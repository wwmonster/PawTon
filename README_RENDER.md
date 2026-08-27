# PawTON backend for Render

## Render Web Service
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

## Environment variables
- `DATABASE_URL` — Internal Database URL from Render Postgres
- `BOT_TOKEN` — Telegram bot token (add only in Render Environment, never GitHub)
- `NODE_ENV=production`

After deployment copy the service URL, e.g. `https://pawton-api.onrender.com`, into `API_URL` in `index.html`.

Telegram Mini App authentication is verified on the server using `Telegram.WebApp.initData`.
