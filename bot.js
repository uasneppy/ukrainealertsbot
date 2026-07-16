import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import dotenv from 'dotenv';

import { fetchLatestChannelMessages, formatChannelMessages } from './channelMessages.js';
import { analyzeAlertMessages } from './geminiAnalysis.js';
import { getOrLaunchBrowser } from './neptun/browser.js';
import { renderNeptunMap } from './neptun/mapRenderer.js';
import { fetchSnapshot } from './neptun/neptunApi.js';
import { startStream, getState, hasSnapshot } from './neptun/neptunStream.js';
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

/**
 * Renders the NEPTUN map using live WebSocket state if available,
 * falling back to a one-off REST fetch if the stream hasn't connected yet.
 */
async function getNeptunMapData() {
  if (hasSnapshot()) {
    return getState();
  }
  // Stream not ready yet — fall back to REST
  return fetchSnapshot();
}

// Cache for the rendered NEPTUN map (60 s TTL).
const NEPTUN_MAP_TTL_MS = 60_000;
let neptunMapCache = { buffer: null, caption: null, takenAt: 0, refreshing: false };

async function refreshNeptunMapCache() {
  if (neptunMapCache.refreshing) return;
  neptunMapCache.refreshing = true;
  try {
    const [{ threats, alerts }, geo] = await Promise.all([getNeptunMapData(), getGeoData()]);
    const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo });
    neptunMapCache.buffer = buffer;
    neptunMapCache.caption = caption;
    neptunMapCache.takenAt = Date.now();
    console.log('[neptun] Map cache refreshed');
  } catch (err) {
    console.error('[neptun] Map cache refresh failed:', err);
  } finally {
    neptunMapCache.refreshing = false;
  }
}

async function getCachedNeptunMap() {
  const age = Date.now() - neptunMapCache.takenAt;
  if (neptunMapCache.buffer && age < NEPTUN_MAP_TTL_MS) {
    if (age > NEPTUN_MAP_TTL_MS / 2) refreshNeptunMapCache().catch(console.error);
    return neptunMapCache;
  }
  await refreshNeptunMapCache();
  return neptunMapCache;
}

// ── Gemini analysis cache ─────────────────────────────────────────────────────

const ANALYSIS_TTL_MS = 120_000;
let analysisCache = { text: null, takenAt: 0, refreshing: false };

async function refreshAnalysisCache() {
  if (analysisCache.refreshing) return;
  analysisCache.refreshing = true;
  try {
    const messages = await fetchLatestChannelMessages({ limit: CHANNEL_MESSAGE_LIMIT });
    const text = await analyzeAlertMessages(messages);
    analysisCache.text = text;
    analysisCache.takenAt = Date.now();
    console.log('Analysis cache refreshed');
  } catch (err) {
    console.error('Analysis refresh failed:', err);
  } finally {
    analysisCache.refreshing = false;
  }
}

async function getCachedAnalysis() {
  const age = Date.now() - analysisCache.takenAt;
  if (analysisCache.text && age < ANALYSIS_TTL_MS) {
    if (age > ANALYSIS_TTL_MS / 2) refreshAnalysisCache().catch(console.error);
    return analysisCache.text;
  }
  await refreshAnalysisCache();
  return analysisCache.text;
}

// ── Bot ───────────────────────────────────────────────────────────────────────

if (token) {
  const bot = new TelegramBot(token, { polling: true });

  // Pre-warm on startup: browser, geo cache, NEPTUN stream, map cache, analysis cache
  (async () => {
    try {
      await getOrLaunchBrowser();
      startStream();
      await Promise.all([
        getGeoData(),
        refreshAnalysisCache(),
      ]);
      // First map render (can take a moment — background)
      refreshNeptunMapCache().catch(console.error);
    } catch (err) {
      console.error('[startup] Pre-warm error:', err);
    }
  })();

  bot.on('message', async (msg) => {
    const text = msg.text?.toLowerCase() ?? '';
    const chatId = msg.chat.id;

    // ── "чому тривога" — channel messages + Gemini analysis ──
    if (text.includes(CHANNEL_MESSAGE_TRIGGER)) {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        const analysis = await getCachedAnalysis();
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

    // ── "тривога" — NEPTUN live map ──
    if (text.includes('тривога')) {
      bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
      try {
        const { buffer, caption } = await getCachedNeptunMap();
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

  // ── /map command — on-demand REST fetch ──────────────────────────────────────
  bot.onText(/^\/map/, async (msg) => {
    const chatId = msg.chat.id;
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
