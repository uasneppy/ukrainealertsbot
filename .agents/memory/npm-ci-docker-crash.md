---
name: npm "Exit handler never called!" in Docker builds
description: The intermittent npm ci crash during Docker builds is host-side, not a code/lockfile bug.
---

# npm "Exit handler never called!" during `npm ci` in Docker

**Symptom:** `docker build` fails at `RUN npm ci …` with `npm error Exit handler never called! This is an error with npm itself` (exit 1), often after the step has run unusually long.

**Durable lesson:** this is npm terminating abnormally before its own exit handler runs — an *environment-side* failure on the build host (out of memory, out of disk / ENOSPC, or a corrupted BuildKit / npm cache). It is NOT a lockfile, dependency, or Dockerfile defect.

**Confirm before editing the Dockerfile:** reproduce `npm ci` in a clean base image with the same Node/npm and the same `package.json` + `package-lock.json`. If it installs cleanly there, the repo is fine and the fix is host-side — don't chase a phantom code bug.

**Host remediation:** `docker builder prune -f` then rebuild `--no-cache`; raise Docker memory (≥4GB); free disk (`docker system prune`, check `docker system df`).

**Dockerfile hardening (reduces the trigger surface; requires BuildKit, which compose v2 enables by default):** `RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund` — trims npm's audit/fund work and makes retries fast + self-healing against a corrupt download cache.
