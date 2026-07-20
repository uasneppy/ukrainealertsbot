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

Render the map without Telegram (writes a PNG + prints the caption):

```
node scripts/render-preview.js mock   # synthetic scenario (all threat types, raion+oblast alerts)
node scripts/render-preview.js live   # current NEPTUN data
```

## Docker

The project ships with a `Dockerfile`, `.dockerignore`, and `docker-compose.yml`. The image is based on `node:22-slim` (LTS — matches the engine requirements of `puppeteer@25` and `@sparticuz/chromium`) and installs **system Chromium** (plus Cyrillic + emoji fonts) so Puppeteer works in the container — `neptun/browser.js` picks it up via `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.

Run with Docker Compose (reads `BOT_TOKEN` / `GEMINI_API_KEY` from a local `.env` — see `.env.example`):

```
cp .env.example .env   # then fill in BOT_TOKEN
docker compose up -d --build
docker compose logs -f
```

### Deploying on a Debian VPS

The compose setup is tuned for a small VPS. On the server (Debian 12+):

1. **Install Docker + Compose** and enable it on boot so the bot returns after a reboot:
   ```
   curl -fsSL https://get.docker.com | sudo sh
   sudo systemctl enable --now docker
   ```
2. **Get the code, set the token, start:**
   ```
   git clone <your-repo> alerts-bot && cd alerts-bot
   cp .env.example .env      # fill in BOT_TOKEN (and TZ / GEMINI_API_KEY if wanted)
   docker compose up -d --build
   ```

What's tuned for the VPS (all in `docker-compose.yml`):
- **Resource caps** — `deploy.resources` limits the container to **2 GB / 2 CPUs** (256 MB reserved) so a runaway Chromium render can't take the whole box (or your SSH session) down. Sized for a 4 GB+ VPS; lower `memory` for a smaller box, and if you drop below ~1.5 GB also lower Chromium's `--max-old-space-size` in `neptun/browser.js` (currently 1024 MB).
- **`init: true`** — tini reaps the zombie processes Chromium spawns, so defunct processes don't pile up over long uptime.
- **`no-new-privileges`** — blocks in-container privilege escalation.
- **Log rotation** — json-file capped at 10 MB × 3 so logs can't fill the disk.
- **`restart: unless-stopped`** — with Docker enabled on boot, the bot survives crashes and host reboots.

**Low-RAM builds:** `docker compose build` runs `npm ci`, which needs memory headroom — an OOM here is what produces `npm error Exit handler never called!`. On a small or busy VPS, add swap once so the build can't run out of memory:
```
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Or plain Docker (compose is recommended — it applies the caps above automatically):

```
docker build -t alerts-bot .
docker run -d --name alerts-bot --restart unless-stopped \
  --init --security-opt no-new-privileges --memory 2g \
  -e BOT_TOKEN=xxxx -e TZ=Europe/Kyiv alerts-bot
```

Notes:
- The bot is a **polling worker** — it exposes no inbound port.
- The GeoJSON cache is downloaded on first run; Compose persists it in a named volume (`geo-cache`) so it survives restarts.
- **Custom threat icons:** `./icons` is bind-mounted read-only into the container — drop `uav.png` (etc.) into the folder on the host and the next render picks it up, no rebuild or restart needed (naming: `icons/README.md`).
- Secrets are never baked into the image (`.env` is excluded via `.dockerignore`); pass them at runtime.
- **Portable lockfile** — `package-lock.json` resolves every package from public npm (`registry.npmjs.org`), so `npm ci` works on any host. Heads-up: running `npm install` **inside Replit** re-pins the `resolved` URLs to Replit's internal `package-firewall.replit.local` proxy, which a VPS can't reach — rewrite them back before deploying: `sed -i 's|http://package-firewall.replit.local/npm/|https://registry.npmjs.org/|g' package-lock.json`.

### Troubleshooting

- **`npm error Exit handler never called!` during `RUN npm ci`** — this is a host-side npm crash (low memory, low disk, or a corrupt build cache), **not** a repo/lockfile bug (the same `npm ci` installs cleanly in a clean `node:22-slim`). Fix on the build host: run `docker builder prune -f` and rebuild with `--no-cache`, give Docker ≥4 GB memory, and free disk (`docker system prune`, check `docker system df`).
- **`ERR_MODULE_NOT_FOUND` (e.g. `node-telegram-bot-api`) at startup** — the image shipped without its `node_modules` (a build can log "added N packages" yet not commit them to the final layer, e.g. from a poisoned build cache). This `Dockerfile` keeps a plain `RUN npm ci` so deps are committed to the layer; if you still hit it, rebuild clean (`docker builder prune -f && docker compose build --no-cache`) and confirm they're baked in: `docker run --rm --entrypoint sh <image> -c "ls node_modules/node-telegram-bot-api"`.

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
| `TZ` | ❌ | Timezone for log timestamps (default UTC), e.g. `Europe/Kyiv` |
| `CHROME_EXECUTABLE_PATH` | ❌ | Override Chromium path (auto-detected otherwise) |
| `PUPPETEER_EXECUTABLE_PATH` | ❌ | Alternative Chromium path override |

## Architecture notes

### NEPTUN integration (`neptun/`)

- **`fetchGeo.js`** — Downloads `ukraine.geojson`, `oblasts.geojson`, `raions.geojson` from neptun.in.ua once and caches them in `neptun/geo/` (excluded from git). In-process cache avoids repeated disk reads.
- **`neptunApi.js`** — REST helpers: `fetchThreats()`, `fetchAlerts()`, `fetchSnapshot()`. Used by `/map` and as a fallback when the stream hasn't connected yet.
- **`neptunStream.js`** — WebSocket client for `wss://neptun.in.ua/api/v1/stream`. Handles `snapshot / upsert / remove / alerts / heartbeat` messages. Reconnects with exponential backoff (1 s → 30 s cap). Exports `startStream()` and `getState()`.
- **`mapRenderer.js`** — Renders the threat map as a PNG using Puppeteer + **vendored Leaflet** (inlined from `node_modules`, no CDN at render time). NEPTUN alert entries are **objects** (`{ key, name, oblast, since }`); keys are normalised (`normalizeAlertKey`) and matched against GeoJSON `properties.key`. Fully-alerted **oblasts fill strong red**, individually-alerted **raions fill pale red** (raion alerts inside an already-red oblast are suppressed). Major cities are labelled; fractional zoom (`zoomSnap: 0`) fits Ukraine tightly at 1280×800. Exports `renderNeptunMap({ threats, alerts, geo })`.
- **`threatIcons.js`** — Loads custom marker icons from the repo-root `icons/` folder (`<type>.<png|jpg|jpeg|webp|gif|svg>` → data URL). The folder is re-read on **every render**, so icons can be swapped live without a restart; files >1 MB are skipped. See `icons/README.md`.
- **`defaultIcons.js`** — Built-in SVG badge markers per threat type, used when no user icon exists. Inline SVG is font-independent — headless Chromium's emoji coverage varies by host (tofu boxes □ otherwise), so emoji are only used in Telegram captions, never on the map.
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
