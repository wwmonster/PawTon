const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data'] }));
app.use(express.json({ limit: '50kb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
const BOT_TOKEN = process.env.BOT_TOKEN;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      score BIGINT NOT NULL DEFAULT 0,
      clicks BIGINT NOT NULL DEFAULT 0,
      energy INTEGER NOT NULL DEFAULT 500,
      boost_progress INTEGER NOT NULL DEFAULT 0,
      x2_until TIMESTAMPTZ,
      last_energy_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS players_score_idx ON players (score DESC);
  `);
}

function validateInitData(initData) {
  if (!BOT_TOKEN || !initData) throw new Error('Telegram авторизация не настроена');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Нет hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'))) throw new Error('Неверная Telegram авторизация');

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) throw new Error('Telegram авторизация устарела');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Не найден Telegram ID');
  return user;
}

async function auth(req, res, next) {
  try {
    const user = validateInitData(req.header('X-Telegram-Init-Data'));
    req.telegramUser = user;
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}

async function ensurePlayer(client, user) {
  await client.query(`
    INSERT INTO players (user_id, username, first_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, updated_at = NOW()
  `, [String(user.id), user.username || null, user.first_name || null]);
}

function state(row) {
  const now = Date.now();
  const x2Until = row.x2_until ? new Date(row.x2_until).getTime() : 0;
  const x2Active = x2Until > now;
  return {
    user: { id: String(row.user_id), username: row.username, firstName: row.first_name },
    score: String(row.score),
    clicks: String(row.clicks),
    energy: row.energy,
    boostProgress: row.boost_progress,
    x2Active,
    x2SecondsLeft: x2Active ? Math.ceil((x2Until - now) / 1000) : 0
  };
}

async function getPlayer(client, userId) {
  const result = await client.query('SELECT * FROM players WHERE user_id = $1', [String(userId)]);
  return result.rows[0];
}

app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/api/bootstrap', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePlayer(client, req.telegramUser);
    const row = await getPlayer(client, req.telegramUser.id);
    await client.query('COMMIT');
    res.json(state(row));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Не удалось загрузить игрока' });
  } finally { client.release(); }
});

app.post('/api/click', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePlayer(client, req.telegramUser);
    const row = await getPlayer(client, req.telegramUser.id);

    const now = Date.now();
    const lastEnergy = new Date(row.last_energy_at).getTime();
    const regenerated = Math.floor(Math.max(0, now - lastEnergy) / 2500);
    let energy = Math.min(500, Number(row.energy) + regenerated);
    let lastEnergyAt = regenerated > 0 ? new Date(lastEnergy + regenerated * 2500) : new Date(lastEnergy);
    if (energy >= 500) lastEnergyAt = new Date();

    const x2Until = row.x2_until ? new Date(row.x2_until).getTime() : 0;
    let x2Active = x2Until > now;
    if (!x2Active && row.x2_until) {
      await client.query('UPDATE players SET x2_until = NULL, boost_progress = 0 WHERE user_id = $1', [String(req.telegramUser.id)]);
      row.x2_until = null;
      row.boost_progress = 0;
    }

    const cost = x2Active ? 2 : 1;
    const reward = x2Active ? 2 : 1;
    if (energy < cost) {
      const current = await getPlayer(client, req.telegramUser.id);
      await client.query('COMMIT');
      return res.json({ ...state(current), reward: 0 });
    }

    energy -= cost;
    let boost = Number(row.boost_progress || 0);
    let newX2Until = row.x2_until;
    if (!x2Active) {
      boost += 1;
      if (boost >= 100) {
        newX2Until = new Date(now + 5000);
        boost = 100;
        x2Active = true;
      }
    }

    await client.query(`
      UPDATE players SET score = score + $1, clicks = clicks + 1, energy = $2,
      boost_progress = $3, x2_until = $4, last_energy_at = $5, updated_at = NOW()
      WHERE user_id = $6
    `, [reward, energy, boost, newX2Until, lastEnergyAt, String(req.telegramUser.id)]);

    const updated = await getPlayer(client, req.telegramUser.id);
    await client.query('COMMIT');
    res.json({ ...state(updated), reward });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Ошибка сохранения клика' });
  } finally { client.release(); }
});

app.get('/api/leaderboard', auth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT user_id, username, first_name, score FROM players ORDER BY score DESC, user_id ASC LIMIT 10`);
    res.json({ players: result.rows.map(r => ({ userId: String(r.user_id), username: r.username, firstName: r.first_name, score: String(r.score) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось загрузить ТОП-10' });
  }
});

const port = Number(process.env.PORT || 10000);
initDb().then(() => app.listen(port, '0.0.0.0', () => console.log(`PawTON API listening on ${port}`))).catch(err => { console.error(err); process.exit(1); });
