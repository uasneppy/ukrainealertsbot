# syntax=docker/dockerfile:1

# ── Base ──────────────────────────────────────────────────────────────────────
# Debian "slim" is the right base for Puppeteer — Alpine/musl has known
# Chromium compatibility issues.
# Node 22 (LTS) satisfies the engine requirements of puppeteer@25 (>=22.12) and
# @sparticuz/chromium (>=22.17); Node 20 only produces EBADENGINE warnings.
FROM node:22-slim

# ── System dependencies ───────────────────────────────────────────────────────
# Chromium (for Puppeteer) + fonts. The map renders Ukrainian (Cyrillic) text and
# emojis inside the image, so Cyrillic + color-emoji fonts are required.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Puppeteer configuration ───────────────────────────────────────────────────
# Use the system Chromium instead of downloading Puppeteer's own copy.
# `PUPPETEER_EXECUTABLE_PATH` is read first by neptun/browser.js at runtime.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# ── Dependencies (own layer for cache reuse) ──────────────────────────────────
COPY package.json package-lock.json ./
# Plain `npm ci` so node_modules is committed to THIS image layer. Keep it plain:
# a BuildKit `--mount=type=cache` on the install caches downloads but its contents
# are not committed to the layer, so it's easy to ship an image whose deps are
# missing at runtime (ERR_MODULE_NOT_FOUND). --no-audit / --no-fund trim npm's
# extra graph-building + network work and lower memory use on small build hosts.
RUN npm ci --omit=dev --no-audit --no-fund

# ── Application source ────────────────────────────────────────────────────────
COPY . .

# ── Run as the non-root `node` user shipped with the base image ───────────────
# The GeoJSON cache is written at runtime, so the app dir must be user-writable.
RUN mkdir -p /app/neptun/geo && chown -R node:node /app
USER node

# This bot is a polling worker — it exposes no inbound port.
# Exec form so SIGTERM reaches node directly for a clean shutdown.
CMD ["node", "bot.js"]
