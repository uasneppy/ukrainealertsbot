import { createHash } from 'node:crypto';

import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import dotenv from 'dotenv';

import { fetchLatestChannelMessages, formatChannelMessages } from './channelMessages.js';
import { analyzeAlertMessages, analyzeRegionQuery } from './geminiAnalysis.js';
import { parseRegionQuery, resolveRegion } from './neptun/regionResolver.js';
import { buildRegionStatus, formatRegionReport } from './neptun/regionContext.js';
import { getOrLaunchBrowser } from './neptun/browser.js';
import { renderNeptunMap } from './neptun/mapRenderer.js';
import { fetchSnapshot } from './neptun/neptunApi.js';
import { startStream, getState, hasSnapshot, streamAgeMs } from './neptun/neptunStream.js';
import { getGeoData } from './neptun/fetchGeo.js';

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
const STREAM_FRESH_MS = 60_000;

/**
 * Returns the current NEPTUN state, always favouring live data:
 * fresh WebSocket state → REST fetch → last known stream state (last resort).
 */
async function getNeptunMapData() {
  if (hasSnapshot() && streamAgeMs() < STREAM_FRESH_MS) {
    return getState();
  }
  try {
    return await fetchSnapshot();
  } catch (err) {
    if (hasSnapshot()) {
      console.warn('[neptun] REST fetch failed, using last stream state:', err?.message ?? err);
      return getState();
    }
    throw err;
  }
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

let neptunMapCache = { buffer: null, caption: null, fp: null, takenAt: 0 };
let neptunMapRenderInFlight = null;

async function getLiveNeptunMap() {
  const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
  const fp = dataFingerprint({ threats, alerts });
  const cached = neptunMapCache;
  if (cached.buffer && cached.fp === fp && Date.now() - cached.takenAt < MAP_REUSE_MS) {
    return cached;
  }
  if (neptunMapRenderInFlight) return neptunMapRenderInFlight; // coalesce concurrent asks
  neptunMapRenderInFlight = (async () => {
    try {
      const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo });
      neptunMapCache = { buffer, caption, fp, takenAt: Date.now() };
      return neptunMapCache;
    } finally {
      neptunMapRenderInFlight = null;
    }
  })();
  return neptunMapRenderInFlight;
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

async function sendRegionMap(botInstance, chatId, region) {
  botInstance.sendChatAction(chatId, 'upload_photo').catch(() => {});
  const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
  const fp = dataFingerprint({ threats, alerts });
  const cached = regionMapCache.get(region.cacheKey);
  if (cached && cached.fp === fp && Date.now() - cached.takenAt < REGION_MAP_REUSE_MS) {
    await botInstance.sendPhoto(chatId, cached.buffer, { caption: cached.caption ?? undefined });
    return;
  }
  const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo, focus: region });
  regionMapCache.set(region.cacheKey, { buffer, caption, fp, takenAt: Date.now() });
  pruneCache(regionMapCache);
  await botInstance.sendPhoto(chatId, buffer, { caption: caption ?? undefined });
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
  regionWhyCache.set(region.cacheKey, { text, fp, takenAt: Date.now() });
  pruneCache(regionWhyCache);
  await botInstance.sendMessage(chatId, text);
}

// ── Bot ───────────────────────────────────────────────────────────────────────

if (token) {
  const bot = new TelegramBot(token, { polling: true });

  // Pre-warm on startup: browser, geo cache, NEPTUN stream, first render.
  // Warm-ups only prime the browser/Gemini path — every user request still
  // fetches live data and re-renders whenever that data has changed.
  (async () => {
    try {
      await getOrLaunchBrowser();
      startStream();
      await getGeoData();
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
    const text = msg.text?.toLowerCase() ?? '';
    const chatId = msg.chat.id;

    // Commands (/map …) are handled by their own onText handlers — skipping
    // them here prevents double replies for command texts containing triggers.
    if (text.startsWith('/')) return;

    // ── Region-scoped: "тривога в києві", "чому тривога в київській області" ──
    const regionQuery = parseRegionQuery(text);
    const regionMatch = regionQuery ? resolveRegion(regionQuery.regionText) : null;
    const focusRegion = regionMatch && regionMatch.kind !== 'country' ? regionMatch : null;

    if (focusRegion && regionQuery.why) {
      try {
        await sendRegionWhy(bot, chatId, focusRegion, msg.text ?? '');
      } catch (error) {
        console.error('Failed to send region analysis:', error);
        await bot.sendMessage(chatId, 'Не вдалося отримати аналіз по регіону.');
      }
      return;
    }

    // ── "чому тривога" — channel messages + Gemini analysis ──
    if (text.includes(CHANNEL_MESSAGE_TRIGGER)) {
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
    if (focusRegion) {
      try {
        await sendRegionMap(bot, chatId, focusRegion);
      } catch (error) {
        console.error('Failed to send region map:', error);
        await bot.sendMessage(chatId, 'Не вдалося побудувати мапу регіону.');
      }
      return;
    }

    // ── "тривога" — NEPTUN live map ──
    if (text.includes('тривога')) {
      bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
      try {
        const { buffer, caption } = await getLiveNeptunMap();
        if (buffer) {
          await bot.sendPhoto(chatId, buffer, { caption: caption ?? undefined });
        } else {
          await bot.sendMessage(chatId, 'Не вдалося отримати мапу загроз.');
        }
      } catch (error) {
        console.error('Failed to send NEPTUN map (тривога):', error);
        await bot.sendMessage(chatId, 'Не вдалося отримати мапу загроз.');
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
      const [{ threats, alerts }, geo] = await Promise.all([fetchSnapshot(), getGeoData()]);
      const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo });
      await bot.sendPhoto(chatId, buffer, { caption: caption ?? undefined });
    } catch (error) {
      console.error('Failed to send NEPTUN map (/map):', error);
      await bot.sendMessage(chatId, 'Не вдалося побудувати мапу загроз. Спробуй пізніше.');
    }
  });
}
