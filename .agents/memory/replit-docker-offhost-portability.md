---
name: Replit → off-host Docker portability
description: Non-obvious reasons a Docker image built in Replit fails to build or run once moved to a VPS / other host.
---

# Shipping a Replit-built Docker image off-host

## 1. package-lock.json is pinned to Replit's internal npm proxy
Replit sets `NPM_CONFIG_REGISTRY=http://package-firewall.replit.local/npm/`, so every `resolved` URL npm writes into `package-lock.json` points at that internal host — resolvable inside Replit, dead from anywhere else. `npm ci` off-host then fails.
**Fix:** rewrite the host to public npm; integrity hashes stay valid because the firewall mirrors npmjs (same tarball bytes):
`sed -i 's|http://package-firewall.replit.local/npm/|https://registry.npmjs.org/|g' package-lock.json`
**Why it recurs:** any `npm install` run *inside* Replit re-pins the URLs. Re-check after touching deps.

## 2. Docker builds inside Replit can't use the default bridge network
The default bridge can't reach external hosts (`deb.debian.org`, `registry.npmjs.org`) and intermittently not even the resolver `172.24.0.254` (`ETIMEOUT` / `EAI_AGAIN`); the host netns is fine.
**Fix:** `docker build --network=host` so `apt` / `npm ci` use the working host stack.
**Why:** Replit-only workaround for local verification — a real VPS builds with no flag, so do not bake `network: host` into compose.

## 3. Don't trust "added N packages" — verify node_modules is actually in the image
An image can build cleanly (npm logs "added N packages") yet start with `ERR_MODULE_NOT_FOUND` because node_modules never landed in the final layer (seen here: npm-ci layer ~237 kB instead of ~175 MB, `/app/node_modules` absent).
**Rule:** prefer a plain `RUN npm ci` (deps are committed to the layer) over cache-mounting the install; if deps go missing, suspect a poisoned BuildKit cache and `docker builder prune` before rebuilding.
**Verify before shipping:** `docker run --rm --entrypoint sh <img> -c "ls node_modules/<pkg>"`.
**Why (honest):** the exact trigger for the empty layer here was not isolated (cache mount, poisoned cache, and a `--no-cache`/prune rebuild all changed at once) — the durable lesson is the verification step, not a specific cache-mount mechanism.
