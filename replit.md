# Air Raid Alerts Telegram Bot

A Node.js Telegram bot that screenshots the live [alerts.in.ua](https://alerts.in.ua/) map and sends it to a group chat whenever someone writes **"тривога"**. Also responds to **"чому тривога"** with the latest posts from the [@kpszsu](https://t.me/s/kpszsu) Telegram channel.

## Stack

- **Node.js 20** (ESM)
- **Puppeteer** + **@sparticuz/chromium** — headless browser for map screenshots
- **node-telegram-bot-api** — Telegram polling
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

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `CHROME_EXECUTABLE_PATH` | ❌ | Override Chromium path (auto-detected otherwise) |
| `PUPPETEER_EXECUTABLE_PATH` | ❌ | Alternative Chromium path override |

## Architecture notes

- **Persistent browser** — a single Chromium instance is kept alive across requests (auto-relaunched on disconnect). This removes the ~3–5 s cold-start penalty on every "тривога" message.
- **Canvas-aware waiting** — instead of a fixed sleep, the bot waits for the map canvas element to appear in the DOM before screenshotting, so it responds as soon as the map is ready.
- **Immediate feedback** — `sendChatAction('upload_photo')` is fired right away so users see the "sending photo…" indicator while the screenshot is being taken.

## User preferences

- Prefer minimal, targeted changes — don't restructure or migrate the existing stack.
