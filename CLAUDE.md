# CLAUDE.md

Guidance for working in this repo.

## What this is

A Telegram bot that answers Ukrainian-language air-raid questions with a map it
renders itself. Node.js ESM, no build step, no framework.

Data comes from NEPTUN (`neptun.in.ua`): a long-lived WebSocket for live state,
REST for one-off fetches and as fallback. The map is rendered in headless
Chromium with Leaflet inlined from `node_modules` — self-contained by default,
no CDN dependency at render time and no screenshotting of anyone else's site.
Street tiles are the one opt-in exception: set `STADIA_API_KEY` (or
`CITY_TILES_URL`) and the *city* view draws streets under the markers; unset,
the render is exactly as before. Keep it that way — tiles stay off by default
and city-view only, so the self-contained property holds unless an operator
deliberately opts in.

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
| `neptun/liveState.js` | The authority for "what is happening now": API first, stream as fallback |
| `neptun/frameCache.js` | Fingerprint-gated reuse and coalescing of rendered frames |
| `neptun/mapRenderer.js` | Puppeteer + Leaflet render, legend, captions, render concurrency cap, label placement |
| `neptun/regionResolver.js` | Free-text Ukrainian region/city → region descriptor |
| `neptun/regionContext.js` | Per-region threat/alert analysis, report and caption builders |
| `neptun/subscriptions.js` | Persisted per-chat region subscriptions |
| `neptun/alertWatcher.js` | Polls subscribed regions; emits alert/all-clear transitions, live per-target events (missiles/ballistics appearing near / entering a region) and once-per-window advisories (a ballistic *risk* over a city) |
| `neptun/alertState.js` | Last announced state per region, so a restart doesn't swallow transitions |
| `neptun/eventDetector.js` | Pure: monitoring-channel text → nationwide event kinds (strategic take-off, MiG-31K, Kalibr, drone launch counts) |
| `neptun/eventWatcher.js` | Polls NEPTUN's channel feed (`/api/v1/messages`) and the MiG-31K marker; announces each kind once per cooldown |
| `neptun/nightLog.js` | The bot's memory of the night: every NEPTUN track (with trail and swarm size) and every channel post (with mentioned regions), persisted to the data volume |
| `neptun/nightDigest.js` | Facts for a region's night from the log (track tallies by geometry, launch waves, relevant posts), the caption line, the Gemini prompt body and the no-AI fallback |
| `neptun/regionMentions.js` | Which regions a channel post mentions, via the resolver; computed once at record time |
| `neptun/channelPoller.js` | Polls extra public channels through their t.me preview for the night log (never for pushes) |
| `neptun/chatSettings.js` | Persisted per-chat notification categories; `/settings` |
| `neptun/chatNotifier.js` | Last filter before fan-out: category settings + per-chat dedupe of the same warning arriving by two routes |
| `neptun/adminGate.js` | Who may change settings: anyone in private, admins only in groups (cached `getChatMember`) |
| `neptun/messageRouter.js` | Pure: message text → which reply it asks for |
| `neptun/keyboards.js` | Inline buttons and their 64-byte callback payloads |
| `neptun/statusReport.js` | /status — makes the deliberately-silent degradations visible |
| `neptun/threatIcons.js`, `defaultIcons.js`, `threatMeta.js` | Marker icons and per-type metadata; `threatNature` tells an advisory from a tracked object |
| `fetchWithTimeout.js` | Every outbound HTTP call goes through this |
| `telegramSender.js` | Paced, retrying queue for unprompted fan-out (alert notifications) |

## Conventions that matter here

**Comments explain why, not what.** The existing code documents the reasoning
behind non-obvious choices (why SVG badges instead of emoji, why `\b` doesn't
work on Cyrillic, why a promise rather than a boolean guards in-flight work).
Match that: a comment restating the code is noise, a comment capturing the
constraint that shaped it is why the next person doesn't reintroduce the bug.

**Never serve stale data as live.** This is an air-raid bot. Every user-facing
answer reads the REST API through `neptun/liveState.js` — the stream is the
fallback for an unreachable API, never the default, because its freshness clock
is reset by `heartbeat`/`pong` and a live-but-drifted socket looks healthy.
Rendered frames are reused only while a fingerprint of the data is unchanged
(`neptun/frameCache.js`), and the alert watcher skips a tick entirely rather
than reason from state it can't trust. When in doubt, say nothing rather than
say something outdated.

**Bias asymmetrically.** Alerts go out immediately; all-clears must be
confirmed. The costs of the two mistakes are not symmetric, and the code should
show that they were weighed.

**A warning is not a missile.** NEPTUN uses the same threat types for a tracked
object («Крилата ракета» with a trail) and for a risk («Балістична загроза»
placed over a city, a `mig31k` marker meaning "it took off"). Read as an
object, an advisory became "балістика наближається, ~40 км" for a missile
nobody had launched. `threatNature()` in `threatMeta.js` makes the call once;
advisories are phrased as a risk, said once per region per quiet window, and
MiG-31K is a nationwide event, never a per-region target. `destination: true`
means the point is where a target is *heading*, so it reads "курсом на", not
"над". Nationwide events come from text (`eventDetector.js`) and are judged
sentence by sentence, conservatively: a missed take-off is covered by the
siren that follows; a false "Kalibr launched" gets the bot muted.

**Everything outbound needs a deadline.** Use `fetchWithTimeout`. A bare `fetch`
against a half-open connection never settles and can wedge a whole code path.

**Unprompted messages go through `telegramSender`.** Replying to a user is one
message; announcing a raid is one per subscribed chat at once. Anything that
fans out must be paced and retried — nobody re-asks for a notification they
never knew was coming, so a swallowed 429 is a lost warning.

**The map is read in a hurry, on a phone.** Threat markers are the bare icon
(no disc or ring) — the icon art carries its own colour, so a wrapper only
cluttered the map; a drop-shadow keeps it legible on a saturated fill. Labels
sit on chips because they land on saturated alert fills as often as on the base
map. City names are repositioned after render to dodge
markers and panels — Leaflet has no label collision, and a name occluded to
"уми" is worse than one moved 20 px. Change any of this and re-render the three
views (`mock`, a city, an oblast) before believing it looks right.

**Ukrainian text is user-facing.** Region names are stored in the nominative;
don't interpolate them into sentences that need another case ("тривога в
Київська область" is wrong). Use a command form or the resolver's own phrasing.

**AI reads; it never wakes anyone.** Gemini summarises the night's posts for
a region («що за ніч у києві») because they are terse, slangy and
contradictory — exactly what a regex can't read. It is given only facts from
the night log and told to add nothing. Push notifications stay regex-driven:
a hallucinated "Kalibr launched" at 3 a.m. gets the bot muted, and a muted bot
warns nobody. Without a key the same facts go out un-summarised.

**Degrade, don't apologise.** A render can fail while the answer is perfectly
well known — `formatRegionReport` and `buildNationalReport` say it in text.
Sending "не вдалося" when the facts are in hand throws away the only thing the
user actually asked for.

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
`subscriptions` for `/app/data` — the second holds user data (subscriptions,
per-chat notification settings, last announced alert state), and losing it is
silent, so never remove it as "just a cache".
