import { fetchWithTimeout } from './fetchWithTimeout.js';

export const CHANNEL_URL = 'https://t.me/s/kpszsu';

/** t.me is scraped on the "чому тривога" path — keep the wait short. */
const CHANNEL_TIMEOUT_MS = 10_000;

const MESSAGE_SELECTOR_REGEX = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
});

const decodeHtmlEntities = (value) =>
  value.replace(/&(#\d+|#x[a-f0-9]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      // fromCodePoint throws past 0x10FFFF — this is scraped, untrusted HTML,
      // and one malformed entity must not take down the whole channel fetch.
      if (!Number.isNaN(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return match;
    }

    const normalized = entity.toLowerCase();
    return NAMED_ENTITIES[normalized] ?? match;
  });

const sanitizeLimit = (limit) => {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer');
  }
  return limit;
};

const replaceHtmlBreaks = (html) =>
  html
    .replace(/<\/(p|div)>\s*<\1>/gi, '\n')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<(li)[^>]*>/gi, '\n • ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(ul|ol)>/gi, '\n');

const stripHtmlTags = (html) => html.replace(/<[^>]+>/g, ' ');

export function cleanMessageText(rawHtml) {
  if (typeof rawHtml !== 'string') {
    throw new Error('rawHtml must be a string');
  }

  const normalizedSource = rawHtml.replace(/\s*\n\s*/g, ' ');
  const withBreaks = replaceHtmlBreaks(normalizedSource);
  const withoutTags = stripHtmlTags(withBreaks);
  const decoded = decodeHtmlEntities(withoutTags);

  return decoded
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n\n(\s*• )/g, '\n$1')
    .replace(/\n\n(?=• )/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractMessageContents(html, limit = 10) {
  if (typeof html !== 'string') {
    throw new Error('html must be a string');
  }

  const safeLimit = sanitizeLimit(limit);
  const messages = [];
  let match;

  while ((match = MESSAGE_SELECTOR_REGEX.exec(html))) {
    const cleaned = cleanMessageText(match[1]);
    if (cleaned) messages.push(cleaned);
  }

  MESSAGE_SELECTOR_REGEX.lastIndex = 0;

  if (!messages.length) return [];

  const latestMessages = messages.slice(-safeLimit).reverse();
  return latestMessages;
}

export async function fetchLatestChannelMessages({
  limit = 10,
  fetchFn = globalThis.fetch,
  url = CHANNEL_URL,
  timeoutMs = CHANNEL_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== 'function') {
    throw new Error('fetchFn must be a function');
  }

  const safeLimit = sanitizeLimit(limit);
  // t.me serves different markup to clients it doesn't recognise, and a bare
  // fetch has no User-Agent at all. Without this the scrape can start returning
  // nothing while the request still looks successful.
  const response = await fetchWithTimeout(url, {
    fetchFn,
    timeoutMs,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; UkraineAlertsBot/1.0; +https://github.com/uasneppy/ukrainealertsbot)',
      'Accept-Language': 'uk,en;q=0.8',
    },
  });

  if (!response || typeof response.text !== 'function') {
    throw new Error('Invalid response returned from fetch');
  }

  if (!response.ok) {
    throw new Error(`Failed to load channel feed (status ${response.status ?? 'unknown'})`);
  }

  const html = await response.text();
  const messages = extractMessageContents(html, safeLimit);
  if (!messages.length && html.length > 0) {
    // A 200 with no parseable messages means the markup changed under us. The
    // caller can only fall back silently, so at least say so in the logs.
    console.warn(
      `[channelMessages] ${url} returned ${html.length} bytes but no messages — markup may have changed`
    );
  }
  return messages;
}

export function formatChannelMessages(messages, channelLabel = '@kpszsu') {
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array');
  }

  if (!messages.length) {
    return `Немає нових повідомлень з каналу ${channelLabel}.`;
  }

  const body = messages.map((message, index) => `${index + 1}. ${message}`).join('\n\n');
  return `Останні повідомлення з каналу ${channelLabel}:\n\n${body}`;
}

// ── Dated messages for the night log ─────────────────────────────────────────
// The digest needs *when* a post was made, not just its text. Each message on
// a t.me preview page sits in a wrapper carrying `data-post="channel/id"` and a
// `<time datetime="…">`; this reads those alongside the text.

const MESSAGE_WRAP_RE = /<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|<\/section>|$)/gi;
const POST_ID_RE = /data-post="([^"\/]+)\/(\d+)"/i;
const TIME_RE = /<time[^>]*datetime="([^"]+)"/i;

/**
 * @returns {Array<{ id: string, channel: string, text: string, date: string|null }>}
 *          oldest first, as on the page
 */
export function extractDatedMessages(html) {
  if (typeof html !== 'string') throw new Error('html must be a string');
  const out = [];
  for (const block of html.match(MESSAGE_WRAP_RE) ?? []) {
    const textMatch = new RegExp(MESSAGE_SELECTOR_REGEX.source, 'i').exec(block);
    if (!textMatch) continue;
    const text = cleanMessageText(textMatch[1]);
    if (!text) continue;
    const post = POST_ID_RE.exec(block);
    const time = TIME_RE.exec(block);
    out.push({
      id: post ? `${post[1]}/${post[2]}` : '',
      channel: post ? `@${post[1]}` : '',
      text,
      date: time ? new Date(time[1]).toISOString() : null,
    });
  }
  return out;
}

/** Fetches a public channel's preview page and returns its dated messages. */
export async function fetchChannelFeed(handle, { fetchFn = globalThis.fetch, timeoutMs = CHANNEL_TIMEOUT_MS } = {}) {
  const name = String(handle ?? '').replace(/^@/, '').trim();
  if (!name) throw new Error('channel handle is required');
  const response = await fetchWithTimeout(`https://t.me/s/${name}`, {
    fetchFn,
    timeoutMs,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; UkraineAlertsBot/1.0; +https://github.com/uasneppy/ukrainealertsbot)',
      'Accept-Language': 'uk,en;q=0.8',
    },
  });
  if (!response?.ok) throw new Error(`Failed to load @${name} (status ${response?.status ?? 'unknown'})`);
  const html = await response.text();
  const messages = extractDatedMessages(html);
  if (!messages.length && html.length > 0) {
    console.warn(`[channelMessages] @${name} returned ${html.length} bytes but no messages — markup may have changed`);
  }
  return messages.map((m) => ({ ...m, channel: m.channel || `@${name}` }));
}
