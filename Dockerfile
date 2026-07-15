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
# --no-audit / --no-fund cut npm's extra work: audit does a network round-trip and
# builds a second dependency graph, a common trigger for the intermittent
# "Exit handler never called!" npm crash on memory/disk-constrained build hosts.
# The BuildKit cache mount keeps ~/.npm across builds so retries are fast and
# self-healing against a corrupted download cache.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ── Application source ────────────────────────────────────────────────────────
COPY . .

# ── Run as the non-root `node` user shipped with the base image ───────────────
# The GeoJSON cache is written at runtime, so the app dir must be user-writable.
RUN mkdir -p /app/neptun/geo && chown -R node:node /app
USER node

# This bot is a polling worker — it exposes no inbound port.
# Exec form so SIGTERM reaches node directly for a clean shutdown.
CMD ["node", "bot.js"]
