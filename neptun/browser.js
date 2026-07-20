/**
 * Shared Puppeteer browser singleton.
 * Keeps one Chromium process alive and relaunches it automatically on disconnect.
 *
 * Resolution order for the Chromium executable:
 *   1. CHROME_EXECUTABLE_PATH / PUPPETEER_EXECUTABLE_PATH env var (manual override)
 *   2. System Chromium found via `which` (works in Replit / NixOS)
 *   3. @sparticuz/chromium (AWS Lambda optimised binary)
 *   4. Let Puppeteer auto-detect (last resort)
 */

import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import { execSync } from 'child_process';

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-infobars',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--js-flags=--max-old-space-size=1024', // bounded to fit the container memory cap (see docker-compose deploy.resources)
];

function findSystemChromium() {
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const name of candidates) {
    try {
      const path = execSync(`which ${name}`, { encoding: 'utf8', timeout: 5_000 }).trim();
      if (path) return path;
    } catch {
      // not found — try next
    }
  }
  return null;
}

export async function resolveLaunchOptions() {
  // 1. Manual override via env var
  const manualPath =
    process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (manualPath) {
    return { headless: 'new', args: BASE_ARGS, executablePath: manualPath };
  }

  // 2. System Chromium (NixOS / Replit — has correct shared-lib paths)
  const systemPath = findSystemChromium();
  if (systemPath) {
    return { headless: 'new', args: BASE_ARGS, executablePath: systemPath };
  }

  // 3. @sparticuz/chromium (AWS Lambda environments)
  try {
    const sparticuzPath = await chromium.executablePath();
    if (sparticuzPath) {
      return {
        args: Array.isArray(chromium.args) && chromium.args.length ? chromium.args : BASE_ARGS,
        headless: typeof chromium.headless === 'boolean' ? chromium.headless : 'new',
        executablePath: sparticuzPath,
      };
    }
  } catch {
    // fall through
  }

  // 4. Let Puppeteer decide (bundled or auto-detected)
  return { headless: 'new', args: BASE_ARGS };
}

let _launchOptionsPromise;
function getLaunchOptions() {
  if (!_launchOptionsPromise) _launchOptionsPromise = resolveLaunchOptions();
  return _launchOptionsPromise;
}

// The *promise* is the singleton, not the resolved browser. Caching the
// resolved value instead would let two concurrent callers both pass the null
// check before either launch settles, leaving an orphaned Chromium alive for
// the life of the process — a real risk under the container memory cap.
let _browserPromise = null;

export async function getOrLaunchBrowser() {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const options = await getLaunchOptions();
      const browser = await puppeteer.launch(options);
      browser.on('disconnected', () => {
        _browserPromise = null;
      });
      return browser;
    })().catch((err) => {
      // Don't cache a failed launch — the next request should retry.
      _browserPromise = null;
      throw err;
    });
  }

  return _browserPromise;
}

/**
 * Closes the shared browser, if one is running. Used on shutdown so Chromium
 * doesn't outlive the bot process (see the SIGTERM handler in bot.js).
 */
export async function closeBrowser() {
  const pending = _browserPromise;
  if (!pending) return;
  _browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch (err) {
    console.error('[browser] Failed to close cleanly:', err?.message ?? err);
  }
}
