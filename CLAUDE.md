# CLAUDE.md

Guidance for working in this repo.

## What this is

A Telegram bot that answers Ukrainian-language air-raid questions with a map it
renders itself. Node.js ESM, no build step, no framework.

Data comes from NEPTUN (`neptun.in.ua`): a long-lived WebSocket for live state,
REST for one-off fetches and as fallback. The map is rendered in headless
Chromium with Leaflet inlined from `node_modules` — there is no CDN dependency
at render time and no screenshotting of anyone else's site.

## Commands

```bash
npm test                       # vitest, whole suite
npm test -- alertWatcher       # one file (substring match)
node bot.js                    # run the bot (needs BOT_TOKEN)
node scripts/render-preview.js mock /tmp/map.png          # render from fixtures
node scripts/render-preview.js live /tmp/kyiv.png "київ"  # render live region
```

`render-preview.js` is the fastest feedback loop for anything touching the
renderer — it needs no Telegram token and writes a PNG you can open.

## Layout

| Path | Role |
| --- | --- |
| `bot.js` | Telegram handlers, caching, flood control, shutdown. Pure helpers are exported for tests; the live bot is wrapped in `if (token && !isTestEnv)` |
| `neptun/neptunStream.js` | WebSocket client, freshness watchdog, reconnect |
| `neptun/neptunApi.js` | REST endpoints |
| `neptun/mapRenderer.js` | Puppeteer + Leaflet render, legend, captions, render concurrency cap |
| `neptun/regionResolver.js` | Free-text Ukrainian region/city → region descriptor |
| `neptun/regionContext.js` | Per-region threat/alert analysis, report and caption builders |
| `neptun/subscriptions.js` | Persisted per-chat region subscriptions |
| `neptun/alertWatcher.js` | Polls region alert state, emits alert/all-clear transitions |
| `neptun/threatIcons.js`, `defaultIcons.js`, `threatMeta.js` | Marker icons and per-type metadata |
| `fetchWithTimeout.js` | Every outbound HTTP call goes through this |

## Conventions that matter here

**Comments explain why, not what.** The existing code documents the reasoning
behind non-obvious choices (why SVG badges instead of emoji, why `\b` doesn't
work on Cyrillic, why a promise rather than a boolean guards in-flight work).
Match that: a comment restating the code is noise, a comment capturing the
constraint that shaped it is why the next person doesn't reintroduce the bug.

**Never serve stale data as live.** This is an air-raid bot. Caches are gated on
a fingerprint of the underlying data, `hasSnapshot()` fails closed when the
stream goes quiet, and the alert watcher skips entirely rather than reason from
stale state. When in doubt, say nothing rather than say something outdated.

**Bias asymmetrically.** Alerts go out immediately; all-clears must be
confirmed. The costs of the two mistakes are not symmetric, and the code should
show that they were weighed.

**Everything outbound needs a deadline.** Use `fetchWithTimeout`. A bare `fetch`
against a half-open connection never settles and can wedge a whole code path.

**Ukrainian text is user-facing.** Region names are stored in the nominative;
don't interpolate them into sentences that need another case ("тривога в
Київська область" is wrong). Use a command form or the resolver's own phrasing.

**Guard test-env side effects.** Tests import `bot.js` for its helpers. Anything
that starts polling, a browser, or a timer must stay behind the
`token && !isTestEnv` check.

## Testing

Vitest, tests in `__tests__/`. Dependencies are injected (`fetchFn`, `getSnapshot`,
`getGeo`, `notify`, directory overrides via env) precisely so tests don't need a
socket, a browser or the network — keep new code injectable the same way.

Before trusting a test that passes, check it fails when the behaviour breaks.
Several tests here pin bug-specific behaviour (a leaked render slot, a stale
snapshot read as an all-clear); those are the ones worth preserving carefully.

## Deployment

`docker compose up -d --build`. Two volumes: `geo-cache` for boundary GeoJSON,
`subscriptions` for `/app/data` — the second holds user data, and losing it is
silent, so never remove it as "just a cache".
