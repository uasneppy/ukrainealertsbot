---
name: npm "Exit handler never called!" in Docker builds
description: Diagnosing the intermittent npm ci crash during Docker builds — it is host-side, not a code/lockfile bug.
---

# npm "Exit handler never called!" during `npm ci` in Docker

**Symptom:** `docker build` fails at `RUN npm ci …` with `npm error Exit handler never called! This is an error with npm itself`, exit code 1. The step often runs unusually long (e.g. ~70s) before crashing.

**What it is NOT:** not a lockfile mismatch, dependency problem, or Dockerfile bug. "Exit handler never called!" is npm terminating abnormally before its own exit handler runs — an *environment-side* failure on the build host.

**Most common real causes (in order):** out of memory (Docker Desktop RAM too low), out of disk / ENOSPC mid-install, or a corrupted BuildKit / npm build cache.

**Verify before touching the Dockerfile:** reproduce `npm ci` in a clean base image with the *same* Node/npm and the same `package.json` + `package-lock.json`. If it builds clean there, the Dockerfile is fine and the fix is host-side. (Confirmed once: 46 pkgs, 0 vuln, ~4s on `node:22-slim` / npm 10.9.8 — while the user's host crashed at ~70s.)

**Why:** chasing this as a code/lock bug wastes effort; the reproduce-in-clean-base test decisively separates host issues from repo issues.

**Host remediation to give the user:** `docker builder prune -f` then rebuild with `--no-cache`; raise Docker memory to ≥4GB; `docker system prune` / check `docker system df` for disk.

**Dockerfile hardening (reduces the trigger surface):** `RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund` — `--no-audit`/`--no-fund` cut npm's extra graph-building + network work; the cache mount makes retries fast and self-heals a corrupt download cache. Requires BuildKit (compose v2 enables it by default).
