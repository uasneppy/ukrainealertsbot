import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import dotenv from 'dotenv';

import { fetchLatestChannelMessages, formatChannelMessages } from './channelMessages.js';
import { analyzeAlertMessages, analyzeRegionQuery, getAiHealth } from './geminiAnalysis.js';
import { resolveRegion, regionFromCacheKey } from './neptun/regionResolver.js';
import { routeMessage } from './neptun/messageRouter.js';
import { mapKeyboard, decodeCallback, CALLBACK_REFRESH, CALLBACK_SUBSCRIBE, CALLBACK_UNSUBSCRIBE } from './neptun/keyboards.js';
import { buildRegionStatus, formatRegionReport } from './neptun/regionContext.js';
import { getOrLaunchBrowser, closeBrowser } from './neptun/browser.js';
import { renderNeptunMap, buildNationalReport, renderQueueStats } from './neptun/mapRenderer.js';
import { fetchSnapshot } from './neptun/neptunApi.js';
import { startStream, stopStream, getState, hasSnapshot, streamAgeMs, onUpdate as onStreamUpdate } from './neptun/neptunStream.js';
import { getGeoData, geoCacheAgeMs } from './neptun/fetchGeo.js';
import {
  loadSubscriptions,
  flushSubscriptions,
  subscribe,
  unsubscribe,
  listSubscriptions,
  subscribedRegions,
  getSubscriptionsFile,
  MAX_PER_CHAT,
} from './neptun/subscriptions.js';
import { formatStatusReport } from './neptun/statusReport.js';
import { createAlertWatcher, formatAlertNotification, formatThreatNotification } from './neptun/alertWatcher.js';
import {
  loadAlertState,
  recordAlertState,
  flushAlertState,
} from './neptun/alertState.js';
import { createSender } from './telegramSender.js';
import { createSnapshotSource } from './neptun/liveState.js';
import { createFrameCache } from './neptun/frameCache.js';

dotenv.config();

const token = process.env.BOT_TOKEN;
const isTestEnv = process.env.NODE_ENV === 'test';
if (!token && !isTestEnv) throw new Error('BOT_TOKEN is required');

// ── resolveLaunchOptions — kept here for backward-compat with existing tests ──

const createFallbackLaunchOptions = () => ({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

export const resolveLaunchOptions = async () => {
  const manualPath = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  const fallback = createFallbackLaunchOptions();

  if (manualPath) {
    return { ...fallback, executablePath: manualPath };
  }

  try {
    const executablePath = await chromium.executablePath();
    if (!executablePath) return fallback;
    return {
      args: Array.isArray(chromium.args) && chromium.args.length ? [...chromium.args] : fallback.args,
      headless: typeof chromium.headless === 'boolean' ? chromium.headless : fallback.headless,
      executablePath,
    };
  } catch {
    return fallback;
  }
};

// ── Viewport / screenshot utilities — exported for tests ─────────────────────

export const TARGET_VIEWPORT = Object.freeze({ width: 1280, height: 800, deviceScaleFactor: 1 });
export const DEFAULT_CROP_PADDING = 70;
export const ALERT_CANVAS_SELECTORS = Object.freeze([
  '#alerts-map canvas',
  '.mapboxgl-canvas',
  'canvas',
]);
export const CHANNEL_MESSAGE_TRIGGER = 'чому тривога';
export const CHANNEL_MESSAGE_LIMIT = 20;

export async function applyViewport(page, viewport = TARGET_VIEWPORT) {
  if (!page || typeof page.setViewport !== 'function') {
    throw new Error('A Puppeteer page with setViewport is required');
  }

  if (!viewport || typeof viewport !== 'object') {
    throw new Error('A viewport object is required');
  }

  const { width, height, deviceScaleFactor = 1 } = viewport;

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('Viewport width and height must be finite numbers');
  }

  await page.setViewport({ width, height, deviceScaleFactor });
}

export async function captureCroppedScreenshot(page, padding = DEFAULT_CROP_PADDING, type = 'png') {
  if (!page || typeof page.screenshot !== 'function' || typeof page.viewport !== 'function') {
    throw new Error('A Puppeteer page with viewport and screenshot is required');
  }

  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error('Padding must be a non-negative finite number');
  }

  const viewport = page.viewport();
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw new Error('A viewport with finite width and height is required before taking screenshots');
  }

  const clipWidth = viewport.width - padding * 2;
  const clipHeight = viewport.height - padding * 2;

  if (clipWidth <= 0 || clipHeight <= 0) {
    throw new Error('Padding is too large for the current viewport dimensions');
  }

  return page.screenshot({
    type,
    clip: {
      x: padding,
      y: padding,
      width: clipWidth,
      height: clipHeight,
    },
  });
}

export function generateCanvasDataUrl(root, selectors) {
  if (!root || typeof root.querySelector !== 'function') {
    throw new Error('A root with querySelector is required');
  }

  if (!Array.isArray(selectors) || !selectors.length) {
    throw new Error('A non-empty selectors array is required');
  }

  for (const selector of selectors) {
    const candidate = typeof selector === 'string' ? root.querySelector(selector) : null;
    if (candidate && typeof candidate.toDataURL === 'function') {
      return candidate.toDataURL('image/png');
    }
  }

  return null;
}

export async function waitForAnySelector(page, selectors = ALERT_CANVAS_SELECTORS, options = {}) {
  if (!page || typeof page.waitForFunction !== 'function') {
    throw new Error('A Puppeteer page with waitForFunction is required');
  }

  if (!Array.isArray(selectors) || !selectors.length) {
    throw new Error('A non-empty selectors array is required');
  }

  try {
    await page.waitForFunction(
      (targetSelectors) => targetSelectors.some((selector) => document.querySelector(selector)),
      options,
      selectors
    );
    return true;
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      return false;
    }
    throw error;
  }
}

export function isolateMapLayout(root, selector) {
  if (!root || typeof root.querySelector !== 'function') {
    throw new Error('A root with querySelector is required');
  }

  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error('A map selector string is required');
  }

  const mapElement = root.querySelector(selector);
  if (!mapElement) {
    return false;
  }

  const siblings = Array.isArray(root.body?.children) ? root.body.children : [];
  siblings.forEach((child) => {
    if (child !== mapElement && child?.style) {
      child.style.display = 'none';
    }
  });

  if (mapElement.style) {
    mapElement.style.position = 'absolute';
    mapElement.style.inset = '0';
    mapElement.style.width = '100%';
    mapElement.style.height = '100%';
  }

  if (typeof mapElement.scrollIntoView === 'function') {
    mapElement.scrollIntoView({ block: 'start', inline: 'start' });
  }

  return true;
}

export async function handleChannelMessageRequest({
  botInstance,
  chatId,
  limit = CHANNEL_MESSAGE_LIMIT,
  fetchMessages = fetchLatestChannelMessages,
  formatMessages = formatChannelMessages,
} = {}) {
  if (!botInstance || typeof botInstance.sendMessage !== 'function') {
    throw new Error('A Telegram bot instance with sendMessage is required');
  }

  if (typeof chatId === 'undefined' || chatId === null) {
    throw new Error('A valid chatId is required');
  }

  const messages = await fetchMessages({ limit });
  const formatted = formatMessages(messages);
  await botInstance.sendMessage(chatId, formatted, { disable_web_page_preview: true });
}

// ── NEPTUN map render — shared by /map and тривога ────────────────────────────

// How fresh the WebSocket state must be to be trusted. Beyond this age the
// stream is treated as stale (half-open socket, reconnect in progress) and the
// data comes from a one-off REST fetch, so replies always reflect the live map.
// Every user-facing answer reads the API. The stream's freshness clock is reset
// by heartbeat and pong, so a live-but-drifted socket looks healthy while its
// state is wrong, and nothing reconciled it — which is how a map ends up
// disagreeing with the API while missiles are inbound. Stream state is now the
// fallback for an unreachable API, not the default. See neptun/liveState.js.
const liveSnapshot = createSnapshotSource({
  fetchSnapshot,
  getState,
  hasSnapshot,
  streamAgeMs,
});

async function getNeptunMapData() {
  return liveSnapshot.get();
}

const jsonCompare = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));

/**
 * Stable fingerprint of the data that ends up on a rendered map. Two calls
 * with the same threats + alerts produce the same hash, so a cached image may
 * be reused ONLY while the underlying data is truly unchanged.
 */
export function dataFingerprint({ threats = [], alerts = {} } = {}) {
  const stable = {
    t: [...threats].sort((a, b) => String(a?.id).localeCompare(String(b?.id))),
    a: {
      raions: [...(alerts.raions ?? [])].sort(jsonCompare),
      oblasts: [...(alerts.oblasts ?? [])].sort(jsonCompare),
    },
  };
  return createHash('sha1').update(JSON.stringify(stable)).digest('hex');
}

// ── Live map rendering ────────────────────────────────────────────────────────
// The map is ALWAYS rendered from the current data. A rendered frame is reused
// only while the fingerprint of the live data still matches (nothing changed),
// and even then no longer than MAP_REUSE_MS — spam protection that can never
// serve an outdated picture.
const MAP_REUSE_MS = 15_000;

// The frame is keyed on a fingerprint of the data, so a picture is only ever
// reused while nothing has moved. See neptun/frameCache.js for why coalescing
// on "a render is running" (without checking the data) served stale maps.
const mapFrames = createFrameCache({
  render: ({ threats, alerts, geo }) => renderNeptunMap({ threats, alerts, geo }),
  reuseMs: MAP_REUSE_MS,
});

async function getLiveNeptunMap() {
  const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
  const fp = dataFingerprint({ threats, alerts });
  return mapFrames.get(fp, { threats, alerts, geo });
}

// ── Gemini analysis — reused only while the channel feed is unchanged ────────
// The channel feed is fetched fresh on every request; the Gemini answer is
// reused only when the fetched messages are identical to the analysed ones.

const ANALYSIS_TTL_MS = 120_000;
let analysisCache = { text: null, fp: null, takenAt: 0 };
let analysisInFlight = null;

async function getLiveAnalysis() {
  const messages = await fetchLatestChannelMessages({ limit: CHANNEL_MESSAGE_LIMIT });
  const fp = createHash('sha1').update(JSON.stringify(messages)).digest('hex');
  const cached = analysisCache;
  if (cached.text && cached.fp === fp && Date.now() - cached.takenAt < ANALYSIS_TTL_MS) {
    return cached.text;
  }
  if (analysisInFlight) return analysisInFlight;
  analysisInFlight = (async () => {
    try {
      const text = await analyzeAlertMessages(messages);
      analysisCache = { text, fp, takenAt: Date.now() };
      return text;
    } finally {
      analysisInFlight = null;
    }
  })();
  return analysisInFlight;
}

// ── Region-scoped queries ─────────────────────────────────────────────────────
// "тривога в києві" → zoomed map of the region; "чому тривога в києві" →
// Gemini analysis scoped to the region and the user's exact question.

// Region replies follow the same rule as the country map: data is fetched
// fresh every time, cached renders/answers are reused only while the data
// fingerprint is unchanged.
const REGION_MAP_REUSE_MS = 15_000;
const REGION_WHY_TTL_MS = 90_000;
const regionMapCache = new Map(); // cacheKey → { buffer, caption, fp, takenAt }
const regionWhyCache = new Map(); // cacheKey → { text, fp, takenAt }

function pruneCache(map, maxEntries = 40) {
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

/**
 * Writes to an insertion-ordered cache, refreshing the key's position first.
 * Map.set on an existing key keeps its original slot, so without the delete
 * the most-requested region is evicted on the same schedule as a cold one.
 */
function setCacheEntry(map, key, value, maxEntries = 40) {
  map.delete(key);
  map.set(key, value);
  pruneCache(map, maxEntries);
}

function regionMarkup(chatId, region) {
  const subscribed = listSubscriptions(chatId).some((s) => s.cacheKey === region.cacheKey);
  return mapKeyboard({ cacheKey: region.cacheKey, subscribed });
}

async function sendRegionMap(botInstance, chatId, region) {
  botInstance.sendChatAction(chatId, 'upload_photo').catch(() => {});
  const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
  const fp = dataFingerprint({ threats, alerts });
  const cached = regionMapCache.get(region.cacheKey);
  if (cached && cached.fp === fp && Date.now() - cached.takenAt < REGION_MAP_REUSE_MS) {
    await botInstance.sendPhoto(chatId, cached.buffer, {
      caption: cached.caption ?? undefined,
      reply_markup: regionMarkup(chatId, region),
    });
    return;
  }
  try {
    const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo, focus: region });
    setCacheEntry(regionMapCache, region.cacheKey, { buffer, caption, fp, takenAt: Date.now() });
    await botInstance.sendPhoto(chatId, buffer, {
      caption: caption ?? undefined,
      reply_markup: regionMarkup(chatId, region),
    });
  } catch (error) {
    // Chromium died, the render timed out, the queue is wedged — the answer is
    // still known, it just can't be drawn. Sending "не вдалося" here throws away
    // facts we are holding: alert state, what's in the region, distances,
    // headings. A text report is a degraded answer; an apology is no answer.
    console.error('Region render failed, sending text report:', error?.message ?? error);
    const status = buildRegionStatus({ region, threats, alerts, geo });
    await botInstance.sendMessage(
      chatId,
      `${formatRegionReport(status)}\n\n🗺 Мапу зараз не вдалося побудувати.`
    );
  }
}

async function sendRegionWhy(botInstance, chatId, region, userQuery) {
  botInstance.sendChatAction(chatId, 'typing').catch(() => {});
  const [{ threats, alerts }, geo, messages] = await Promise.all([
    getNeptunMapData(),
    getGeoData(),
    fetchLatestChannelMessages({ limit: CHANNEL_MESSAGE_LIMIT }).catch(() => []),
  ]);
  const fp =
    dataFingerprint({ threats, alerts }) +
    ':' +
    createHash('sha1').update(JSON.stringify(messages)).digest('hex');
  const cached = regionWhyCache.get(region.cacheKey);
  if (cached && cached.fp === fp && Date.now() - cached.takenAt < REGION_WHY_TTL_MS) {
    await botInstance.sendMessage(chatId, cached.text);
    return;
  }
  const status = buildRegionStatus({ region, threats, alerts, geo });
  const report = formatRegionReport(status);
  let text;
  try {
    text = await analyzeRegionQuery({
      userQuery,
      regionName: region.name,
      regionReport: report,
      channelMessages: messages,
    });
  } catch (error) {
    // No GEMINI_API_KEY or Gemini error — the live NEPTUN report still answers
    // the question factually, so send it instead of failing.
    console.error('Region Gemini analysis failed, sending NEPTUN report:', error?.message ?? error);
    text = `${report}\n\n⚠️ AI-аналіз тимчасово недоступний — вище наведено живі дані NEPTUN.`;
  }
  setCacheEntry(regionWhyCache, region.cacheKey, { text, fp, takenAt: Date.now() });
  await botInstance.sendMessage(chatId, text);
}

// ── Flood control ─────────────────────────────────────────────────────────────
// Reusing a rendered frame bounds render cost, but every triggering message
// still produces a *send*. Passive triggers fire on any message containing
// "тривога", so during a raid an active group is one photo per message and a
// fast route to Telegram's 429s.
//
// The window is per (chat, reply kind) rather than per chat: a generic
// "тривога" must not silently swallow a deliberate "чому тривога в києві"
// seconds later — different questions deserve answers, it's the repetition
// that needs damping. Explicit commands (/map) are exempt: silently swallowing
// a command reads as a broken bot.

export const CHAT_COOLDOWN_MS = 20_000;
const lastReplyAt = new Map(); // "chatId:kind" → epoch ms

export function isOnCooldown(key, now = Date.now(), cooldownMs = CHAT_COOLDOWN_MS) {
  const last = lastReplyAt.get(key) ?? 0;
  if (now - last < cooldownMs) return true;
  setCacheEntry(lastReplyAt, key, now, 500);
  return false;
}

// ── Subscription replies ──────────────────────────────────────────────────────
// Text builders kept separate from the handlers so they can be unit-tested.

export function formatSubscribeReply(result, query) {
  if (result.ok) {
    return `✅ Підписано на сповіщення: ${result.region.name}\nНадсилатиму тривогу та відбій.`;
  }
  switch (result.reason) {
    case 'duplicate':
      return `ℹ️ Підписка на ${result.region.name} вже активна.`;
    case 'limit':
      return `⚠️ Досягнуто ліміт підписок (${MAX_PER_CHAT}). Спочатку відпишись від зайвого: /unsubscribe`;
    default:
      return `❓ Не вдалося розпізнати регіон «${query}».\nСпробуй: /subscribe київ або /subscribe харківщина`;
  }
}

export function formatSubscriptionList(subs) {
  if (!subs.length) {
    return 'Підписок немає.\nДодати: /subscribe <регіон>, напр. /subscribe київщина';
  }
  const lines = subs.map((sub) => `• ${sub.name}`);
  return `🔔 Активні підписки (${subs.length}):\n${lines.join('\n')}\n\nВідписатися: /unsubscribe <регіон> або /unsubscribe all`;
}

// ── Bot ───────────────────────────────────────────────────────────────────────

// `!isTestEnv` matters: tests import the helpers above, and a real BOT_TOKEN in
// a local .env would otherwise start long-polling (and a browser) mid-suite.
if (token && !isTestEnv) {
  const bot = new TelegramBot(token, { polling: true });

  // Pre-warm on startup: browser, geo cache, NEPTUN stream, first render.
  // Warm-ups only prime the browser/Gemini path — every user request still
  // fetches live data and re-renders whenever that data has changed.
  // ── Alert watcher ───────────────────────────────────────────────────────────
  // Only ever reasons about fresh stream state: returning null here is what
  // stops a dead socket from being read as "відбій" for every subscriber.
  // Fan-out goes through a paced queue: one alert can mean a message to every
  // subscribed chat at once, and a burst past Telegram's ~30/s ceiling comes
  // back as 429s — dropping exactly the messages nobody knows to ask for again.
  const notificationSender = createSender({
    send: (chatId, text) => bot.sendMessage(chatId, text),
    // A chat that blocked or deleted the bot would otherwise be retried on
    // every alert forever.
    onDeadChat: (chatId) => {
      const { removed } = unsubscribe(chatId);
      if (removed) console.log(`[alert-watcher] dropped ${removed} subscription(s) for ${chatId}`);
    },
  });

  // Filled in by the pre-warm below, before the watcher starts ticking. Holds
  // what subscribers were last told, so a restart mid-raid doesn't swallow the
  // transition that happened while the process was down.
  const persistedAlertState = {};

  // Live per-target alerts tuning. Unset OR empty → watcher defaults (empty is
  // important: `docker compose` sets `${LIVE_ALERT_TYPES:-}` to "" when unset,
  // and that must not silently disable the feature). Explicit "none"/"off"
  // disables it; a comma list overrides the type set.
  const rawTypes = (process.env.LIVE_ALERT_TYPES ?? '').trim();
  let liveAlertTypes; // undefined → keep the watcher's default set
  if (rawTypes) {
    liveAlertTypes = /^(none|off)$/i.test(rawTypes)
      ? []
      : rawTypes.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  const liveAlertKm = Number(process.env.LIVE_ALERT_KM) || undefined;
  const watcherIntervalMs = Number(process.env.WATCHER_INTERVAL_MS) || undefined;

  const alertWatcher = createAlertWatcher({
    initialStates: persistedAlertState,
    onStateChange: recordAlertState,
    ...(watcherIntervalMs ? { intervalMs: watcherIntervalMs } : {}),
    // Same authority as the maps: notifications and pictures must never
    // disagree. null when nothing trustworthy is available, so the tick skips.
    getSnapshot: () => liveSnapshot.getOrNull(),
    getGeo: getGeoData,
    ...(liveAlertTypes ? { liveAlertTypes } : {}),
    ...(liveAlertKm ? { liveAlertKm } : {}),
    // Enqueue and return: the tick must not sit waiting on a fan-out that is
    // paced over seconds, or ticks would overlap during a nationwide alert.
    notify: (event) => {
      const text = event.kind === 'threat'
        ? formatThreatNotification(event)
        : formatAlertNotification(event);
      for (const chatId of event.chatIds) notificationSender.sendTo(chatId, text);
    },
  });

  (async () => {
    try {
      await getOrLaunchBrowser();
      startStream();
      const [, , alertState] = await Promise.all([
        getGeoData(),
        loadSubscriptions(),
        loadAlertState(),
      ]);
      // Object.assign so the watcher's captured reference sees it — the
      // watcher is constructed before this async pre-warm finishes.
      Object.assign(persistedAlertState, alertState);
      alertWatcher.start();
      // Near-real-time: react the moment the stream reports a changed threat or
      // alert, instead of only on the periodic poll. wake() coalesces bursts.
      onStreamUpdate(() => alertWatcher.wake());
      getLiveNeptunMap().catch((err) =>
        console.error('[startup] Map warm-up failed:', err?.message ?? err)
      );
      getLiveAnalysis().catch((err) =>
        console.error('[startup] Analysis warm-up failed:', err?.message ?? err)
      );
    } catch (err) {
      console.error('[startup] Pre-warm error:', err);
    }
  })();

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const { kind, region: focusRegion, cooldownKey } = routeMessage(msg.text);

    // Ordinary chatter never consumes a cooldown slot; the slot is scoped to
    // the kind of reply and, for region queries, to the region asked about.
    if (!kind || isOnCooldown(`${chatId}:${cooldownKey}`)) return;

    if (kind === 'region-why') {
      try {
        await sendRegionWhy(bot, chatId, focusRegion, msg.text ?? '');
      } catch (error) {
        console.error('Failed to send region analysis:', error);
        await bot.sendMessage(chatId, 'Не вдалося отримати аналіз по регіону.');
      }
      return;
    }

    // ── "чому тривога" — channel messages + Gemini analysis ──
    if (kind === 'channel-why') {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        const analysis = await getLiveAnalysis();
        await bot.sendMessage(chatId, analysis ?? 'Не вдалося отримати аналіз.');
      } catch (error) {
        console.error('Failed to send analysis:', error);
        try {
          await handleChannelMessageRequest({ botInstance: bot, chatId, limit: CHANNEL_MESSAGE_LIMIT });
        } catch (fallbackError) {
          console.error('Fallback also failed:', fallbackError);
          await bot.sendMessage(chatId, 'Не вдалося отримати інформацію з каналу @kpszsu.');
        }
      }
      return;
    }

    // ── Region map: "тривога в <місті/області>" ──
    if (kind === 'region-map') {
      try {
        await sendRegionMap(bot, chatId, focusRegion);
      } catch (error) {
        console.error('Failed to send region map:', error);
        await bot.sendMessage(chatId, 'Не вдалося побудувати мапу регіону.');
      }
      return;
    }

    // ── "тривога" — NEPTUN live map ──
    if (kind === 'national-map') {
      bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
      try {
        const { buffer, caption } = await getLiveNeptunMap();
        if (buffer) {
          await bot.sendPhoto(chatId, buffer, {
            caption: caption ?? undefined,
            reply_markup: mapKeyboard({}),
          });
        } else {
          await bot.sendMessage(chatId, 'Не вдалося отримати мапу загроз.');
        }
      } catch (error) {
        // Same reasoning as the region path: the data is known even when it
        // can't be drawn, so answer in text rather than apologising.
        console.error('Failed to send NEPTUN map (тривога):', error?.message ?? error);
        try {
          const { threats, alerts } = await getNeptunMapData();
          await bot.sendMessage(
            chatId,
            `${buildNationalReport({ threats, alerts })}\n\n🗺 Мапу зараз не вдалося побудувати.`
          );
        } catch {
          await bot.sendMessage(chatId, 'Не вдалося отримати мапу загроз.');
        }
      }
      return;
    }
  });

  // ── /map command — on-demand REST fetch; "/map київ" renders a region ───────
  bot.onText(/^\/map(?:@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const regionArg = match?.[1]?.trim();
    if (regionArg) {
      const region = resolveRegion(regionArg);
      if (region && region.kind !== 'country') {
        try {
          await sendRegionMap(bot, chatId, region);
        } catch (error) {
          console.error('Failed to send NEPTUN region map (/map):', error);
          await bot.sendMessage(chatId, 'Не вдалося побудувати мапу регіону. Спробуй пізніше.');
        }
        return;
      }
    }
    bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
    try {
      // Same source as every other reply, so /map can't disagree with «тривога».
      const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
      const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo });
      await bot.sendPhoto(chatId, buffer, { caption: caption ?? undefined });
    } catch (error) {
      console.error('Failed to send NEPTUN map (/map):', error);
      await bot.sendMessage(chatId, 'Не вдалося побудувати мапу загроз. Спробуй пізніше.');
    }
  });

  // ── Subscription commands ───────────────────────────────────────────────────

  bot.onText(/^\/subscribe(?:@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match?.[1]?.trim();
    if (!query) {
      await bot.sendMessage(
        chatId,
        'Вкажи регіон: /subscribe київ, /subscribe харківщина\nПоточні підписки: /subscriptions'
      );
      return;
    }
    try {
      const result = subscribe(chatId, query);
      await bot.sendMessage(chatId, formatSubscribeReply(result, query));
    } catch (error) {
      console.error('Failed to subscribe:', error);
      await bot.sendMessage(chatId, 'Не вдалося оформити підписку. Спробуй пізніше.');
    }
  });

  bot.onText(/^\/unsubscribe(?:@\S+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const arg = match?.[1]?.trim();
    try {
      if (!arg || arg.toLowerCase() === 'all' || arg.toLowerCase() === 'всі') {
        const { removed } = unsubscribe(chatId);
        await bot.sendMessage(
          chatId,
          removed ? `✅ Скасовано підписок: ${removed}` : 'Підписок не було.'
        );
        return;
      }
      const region = resolveRegion(arg);
      if (!region || region.kind === 'country') {
        await bot.sendMessage(chatId, `❓ Не вдалося розпізнати регіон «${arg}».`);
        return;
      }
      const { removed } = unsubscribe(chatId, region.cacheKey);
      await bot.sendMessage(
        chatId,
        removed ? `✅ Підписку скасовано: ${region.name}` : `Підписки на ${region.name} не було.`
      );
    } catch (error) {
      console.error('Failed to unsubscribe:', error);
      await bot.sendMessage(chatId, 'Не вдалося скасувати підписку. Спробуй пізніше.');
    }
  });

  bot.onText(/^\/status(?:@\S+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      // Probe the API for real rather than reporting a cached opinion of it —
      // "can we answer right now" is the only question worth asking here.
      let apiOk = false;
      let apiLatencyMs = 0;
      let apiError = null;
      const startedAt = Date.now();
      try {
        await fetchSnapshot();
        apiOk = true;
        apiLatencyMs = Date.now() - startedAt;
      } catch (err) {
        apiError = err?.message ?? String(err);
      }

      await bot.sendMessage(chatId, formatStatusReport({
        streamConnected: hasSnapshot(),
        streamAgeMs: streamAgeMs(),
        apiOk,
        apiLatencyMs,
        apiError,
        geoAgeMs: await geoCacheAgeMs(),
        ai: getAiHealth(),
        renderQueue: renderQueueStats(),
        subscriptions: listSubscriptions(chatId).length,
        watchedRegions: subscribedRegions().length,
      }));
    } catch (error) {
      console.error('Failed to send status:', error);
      await bot.sendMessage(chatId, 'Не вдалося зібрати стан.');
    }
  });

  bot.onText(/^\/subscriptions(?:@\S+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await bot.sendMessage(chatId, formatSubscriptionList(listSubscriptions(chatId)));
    } catch (error) {
      console.error('Failed to list subscriptions:', error);
      await bot.sendMessage(chatId, 'Не вдалося отримати список підписок.');
    }
  });

  // ── Inline button callbacks ─────────────────────────────────────────────────

  bot.on('callback_query', async (query) => {
    const chatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;
    const { action, cacheKey } = decodeCallback(query?.data);
    // Telegram shows a spinner on the button until this is answered.
    const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});

    if (!chatId || !action) {
      await ack();
      return;
    }

    const region = cacheKey ? regionFromCacheKey(cacheKey) : null;

    try {
      if (action === CALLBACK_SUBSCRIBE || action === CALLBACK_UNSUBSCRIBE) {
        if (!region) {
          await ack('Регіон не розпізнано');
          return;
        }
        if (action === CALLBACK_SUBSCRIBE) {
          const result = subscribe(chatId, region.name);
          await ack(result.ok ? `🔔 Підписано: ${region.name}` : 'Підписка вже активна');
        } else {
          const { removed } = unsubscribe(chatId, region.cacheKey);
          await ack(removed ? `🔕 Підписку скасовано` : 'Підписки не було');
        }
        // Flip the button to match the new state.
        await bot
          .editMessageReplyMarkup(regionMarkup(chatId, region) ?? { inline_keyboard: [] }, {
            chat_id: chatId,
            message_id: messageId,
          })
          .catch(() => {});
        return;
      }

      if (action === CALLBACK_REFRESH) {
        await ack('Оновлюю…');
        const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
        const { buffer, caption } = region
          ? await renderNeptunMap({ threats, alerts, geo, focus: region })
          : await renderNeptunMap({ threats, alerts, geo });
        const markup = region ? regionMarkup(chatId, region) : mapKeyboard({});

        // Editing keeps the chat from filling with near-identical maps. If the
        // API shape or the message disagrees, fall back to a new message rather
        // than leaving the user with nothing.
        try {
          await bot.editMessageMedia(
            { type: 'photo', media: buffer, caption: caption ?? undefined },
            { chat_id: chatId, message_id: messageId, reply_markup: markup }
          );
        } catch (err) {
          console.error('[callback] editMessageMedia failed, resending:', err?.message ?? err);
          await bot.sendPhoto(chatId, buffer, { caption: caption ?? undefined, reply_markup: markup });
        }
      }
    } catch (error) {
      console.error('Callback handling failed:', error?.message ?? error);
      await ack('Не вдалося виконати дію');
    }
  });

  // ── Process-level resilience ────────────────────────────────────────────────

  // Long-poll failures (network blips, 409 from a second instance, Telegram
  // 5xx) are emitted here; unhandled they surface as bare stack traces.
  bot.on('polling_error', (err) => {
    console.error('[telegram] Polling error:', err?.code ?? '', err?.message ?? err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[process] Unhandled rejection:', reason);
  });

  // Graceful shutdown. docker-compose already grants a 20 s stop_grace_period
  // and runs tini as PID 1 — this is the piece that actually uses them, so a
  // deploy stops polling cleanly and doesn't leave Chromium behind.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — stopping…`);

    const timer = setTimeout(() => {
      console.error('[shutdown] Timed out after 15 s — forcing exit');
      process.exit(1);
    }, 15_000);
    timer.unref();

    try {
      if (typeof bot.stopPolling === 'function') {
        await bot.stopPolling({ cancel: true });
      }
    } catch (err) {
      console.error('[shutdown] stopPolling failed:', err?.message ?? err);
    }

    alertWatcher.stop();
    stopStream();
    // Deliver whatever is still queued — an alert notification abandoned
    // mid-fan-out is one nobody will ever be told about.
    await notificationSender.drain();
    // Let any queued subscription/state write land before the process goes away.
    await Promise.all([flushSubscriptions(), flushAlertState()]);
    await closeBrowser();
    console.log('[shutdown] Done');
    process.exit(0);
  };

  // Liveness beacon for the container healthcheck. A crashed process is caught
  // by Docker already; this catches the nastier case of a process that is still
  // "up" while its event loop is wedged and it answers nobody.
  const heartbeatFile = process.env.HEARTBEAT_FILE
    || path.join(path.dirname(getSubscriptionsFile()), 'heartbeat');
  const beat = () => {
    fs.writeFile(heartbeatFile, String(Date.now()), 'utf8').catch(() => {});
  };
  beat();
  const heartbeatTimer = setInterval(beat, 30_000);
  heartbeatTimer.unref?.();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
