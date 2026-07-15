import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import dotenv from 'dotenv';

import { fetchLatestChannelMessages, formatChannelMessages } from './channelMessages.js';
import { analyzeAlertMessages } from './geminiAnalysis.js';

dotenv.config();

const token = process.env.BOT_TOKEN;
const isTestEnv = process.env.NODE_ENV === 'test';
if (!token && !isTestEnv) throw new Error('BOT_TOKEN is required');

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

let cachedLaunchOptionsPromise;
const getLaunchOptions = () => {
  if (!cachedLaunchOptionsPromise) cachedLaunchOptionsPromise = resolveLaunchOptions();
  return cachedLaunchOptionsPromise;
};

// Persistent browser — reused across requests to avoid cold-start on every message.
// Reset to null on disconnect so the next request relaunches cleanly.
let activeBrowser = null;

async function getOrLaunchBrowser() {
  if (activeBrowser) {
    return activeBrowser;
  }

  const options = await getLaunchOptions();

  activeBrowser = await puppeteer.launch({
    ...options,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-infobars',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--js-flags=--max-old-space-size=4096',
      ...(options.args || []),
    ],
  });

  activeBrowser.on('disconnected', () => {
    activeBrowser = null;
  });

  return activeBrowser;
}

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

// ── Screenshot cache ──────────────────────────────────────────────────────────
// The map is refreshed in the background every 30 s so user requests are
// served from cache and respond in under a second.
const SCREENSHOT_TTL_MS = 30_000;
let screenshotCache = { buffer: null, takenAt: 0, refreshing: false };

async function refreshScreenshotCache() {
  if (screenshotCache.refreshing) return;
  screenshotCache.refreshing = true;
  let page;
  try {
    const browser = await getOrLaunchBrowser();
    page = await browser.newPage();
    await applyViewport(page);
    await page.goto('https://alerts.in.ua/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForAnySelector(page, ALERT_CANVAS_SELECTORS, { timeout: 8000 });
    const buffer = await captureCroppedScreenshot(page, DEFAULT_CROP_PADDING, 'jpeg');
    screenshotCache.buffer = buffer;
    screenshotCache.takenAt = Date.now();
    console.log('Screenshot cache refreshed');
  } catch (err) {
    console.error('Screenshot refresh failed:', err);
  } finally {
    screenshotCache.refreshing = false;
    if (page) { try { await page.close(); } catch {} }
  }
}

async function getCachedScreenshot() {
  const age = Date.now() - screenshotCache.takenAt;
  if (screenshotCache.buffer && age < SCREENSHOT_TTL_MS) {
    // Serve from cache; kick off a background refresh when half-stale
    if (age > SCREENSHOT_TTL_MS / 2) refreshScreenshotCache().catch(console.error);
    return screenshotCache.buffer;
  }
  // Cache empty or expired — block until fresh
  await refreshScreenshotCache();
  return screenshotCache.buffer;
}

// ── Gemini analysis cache ─────────────────────────────────────────────────────
// Refreshed in the background every 2 minutes.
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

if (token) {
  const bot = new TelegramBot(token, { polling: true });

  // Pre-warm: launch the browser and populate both caches before the first message arrives
  getOrLaunchBrowser()
    .then(() => Promise.all([refreshScreenshotCache(), refreshAnalysisCache()]))
    .catch(console.error);

  bot.on('message', async (msg) => {
    const text = msg.text?.toLowerCase() ?? '';
    const chatId = msg.chat.id;

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

    if (!text.includes('тривога')) return;

    bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
    try {
      const buffer = await getCachedScreenshot();
      if (buffer) {
        await bot.sendPhoto(chatId, buffer);
      } else {
        await bot.sendMessage(chatId, 'Не вдалося отримати мапу тривог.');
      }
    } catch (error) {
      console.error('Failed to send alert image:', error);
      await bot.sendMessage(chatId, 'Не вдалося отримати мапу тривог.');
    }
  });
}
