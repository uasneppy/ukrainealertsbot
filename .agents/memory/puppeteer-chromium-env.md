---
name: Puppeteer Chromium on Replit & Docker
description: Why the bundled/Lambda Chromium binaries fail here and how to give Puppeteer a working browser in Replit (NixOS) and Docker.
---

# Puppeteer Chromium: getting a launchable browser

Neither Puppeteer's own downloaded Chrome nor `@sparticuz/chromium` (a Lambda-optimised build) launches out of the box in this project's environments — both fail with `error while loading shared libraries` (e.g. `libnspr4.so`, `libglib-2.0.so.0`) because the prebuilt binaries expect standard FHS `.so` paths that neither Replit's NixOS nor a minimal Debian image provides by default.

**The fix: give Puppeteer a system Chromium that ships with its own correct library paths, and point `executablePath` at it.**

- **Replit (NixOS):** install the `chromium` Nix system dependency, then resolve it at runtime with `which chromium` (it lands on PATH). Do NOT rely on `puppeteer.executablePath()` (bundled) or `@sparticuz/chromium.executablePath()` here.
- **Docker:** base on `node:22-slim` (Debian) — NOT Alpine/musl, which has its own Chromium pain. Use Node 22 LTS, not 20: `puppeteer@25` requires node `>=22.12` and `@sparticuz/chromium` `>=22.17`, so Node 20 builds emit `EBADENGINE` warnings (works, but off-spec). `apt-get install chromium`, then set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` and `PUPPETEER_SKIP_DOWNLOAD=true` (skip the useless bundled download).

**Why:** the binaries are compiled against shared libs that must be discoverable; NixOS puts libs in `/nix/store/...` and Debian-slim omits most GUI libs. The distro's own `chromium` package pulls the right lib closure automatically.

**How to apply:** the resolver order that works is env override (`CHROME_EXECUTABLE_PATH`/`PUPPETEER_EXECUTABLE_PATH`) → `which chromium` → `@sparticuz/chromium` (Lambda only) → Puppeteer auto. Always launch with `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` (needed for containers / non-root; `/dev/shm` is tiny in Docker).

**Fonts matter for rendered images:** the map draws Cyrillic text and color emoji *inside the PNG* (Leaflet HTML → screenshot). A slim image has no such fonts, so install `fonts-liberation fonts-dejavu-core fonts-noto-color-emoji` or the map shows tofu boxes. Replit's default env already has them.
