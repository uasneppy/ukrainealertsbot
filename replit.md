# Air Raid Alerts Telegram Bot

A Node.js Telegram bot that monitors Ukrainian air-threat data from **NEPTUN** (neptun.in.ua) and screenshots the live [alerts.in.ua](https://alerts.in.ua/) map, responding to group chat messages.

## Stack

- **Node.js 20** (ESM)
- **Puppeteer** + system **Chromium** (NixOS) — headless browser for map rendering
- **node-telegram-bot-api** — Telegram polling
- **ws** — WebSocket client for the NEPTUN live stream
- **dotenv** — environment config
- **vitest** — unit tests

## Running

```
npm start
```

The bot requires a `BOT_TOKEN` environment variable (set it via Replit Secrets). It will throw on startup if the token is missing.

## Tests

```
npm test
```

## Docker

The project ships with a `Dockerfile`, `.dockerignore`, and `docker-compose.yml`. The image is based on `node:20-slim` and installs **system Chromium** (plus Cyrillic + emoji fonts) so Puppeteer works in the container — `neptun/browser.js` picks it up via `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.

Run with Docker Compose (reads `BOT_TOKEN` / `GEMINI_API_KEY` from a local `.env` — see `.env.example`):

```
cp .env.example .env   # then fill in BOT_TOKEN
docker compose up -d --build
docker compose logs -f
```

Or plain Docker:

```
docker build -t alerts-bot .
docker run -d --name alerts-bot --restart unless-stopped -e BOT_TOKEN=xxxx alerts-bot
```

Notes:
- The bot is a **polling worker** — it exposes no inbound port.
- The GeoJSON cache is downloaded on first run; Compose persists it in a named volume (`geo-cache`) so it survives restarts.
- Secrets are never baked into the image (`.env` is excluded via `.dockerignore`); pass them at runtime.

## Bot commands & triggers

| Trigger | Response |
|---|---|
| `/map` | Renders a NEPTUN threat map on demand (REST fetch) |
| `тривога` (any case) | Renders the live NEPTUN threat map (WebSocket state, cached 60 s) |
| `чому тривога` | Fetches latest @kpszsu channel posts + Gemini AI analysis |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `GEMINI_API_KEY` | ❌ | Enables Gemini AI analysis for "чому тривога" |
| `CHROME_EXECUTABLE_PATH` | ❌ | Override Chromium path (auto-detected otherwise) |
| `PUPPETEER_EXECUTABLE_PATH` | ❌ | Alternative Chromium path override |

## Architecture notes

### NEPTUN integration (`neptun/`)

- **`fetchGeo.js`** — Downloads `ukraine.geojson`, `oblasts.geojson`, `raions.geojson` from neptun.in.ua once and caches them in `neptun/geo/` (excluded from git). In-process cache avoids repeated disk reads.
- **`neptunApi.js`** — REST helpers: `fetchThreats()`, `fetchAlerts()`, `fetchSnapshot()`. Used by `/map` and as a fallback when the stream hasn't connected yet.
- **`neptunStream.js`** — WebSocket client for `wss://neptun.in.ua/api/v1/stream`. Handles `snapshot / upsert / remove / alerts / heartbeat` messages. Reconnects with exponential backoff (1 s → 30 s cap). Exports `startStream()` and `getState()`.
- **`mapRenderer.js`** — Renders the threat map as a PNG using Puppeteer + Leaflet (CDN). Oblast/raion boundaries are drawn from cached GeoJSON; alerted regions are highlighted red; threats are colored circles by type. Exports `renderNeptunMap({ threats, alerts, geo })`.
- **`browser.js`** — Shared Puppeteer browser singleton. Resolution order: env override → system `chromium` (NixOS/Replit) → `@sparticuz/chromium` (Lambda) → Puppeteer auto-detect.

### Caching

- **NEPTUN map** — rendered PNG cached for 60 s; background refresh at 30 s. Served instantly on "тривога".
- **Gemini analysis** — cached for 2 min with background refresh at 1 min.

### Startup pre-warm

On `npm start` the bot:
1. Launches the Chromium browser
2. Starts the NEPTUN WebSocket stream
3. Downloads GeoJSON boundary files (or loads from cache)
4. Kicks off the first map render and Gemini analysis in the background

## User preferences

- Prefer minimal, targeted changes — don't restructure or migrate the existing stack.
