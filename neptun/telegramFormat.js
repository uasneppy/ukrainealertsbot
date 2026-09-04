/**
 * Telegram HTML formatting, in one place.
 *
 * Every outbound message is sent with parse_mode HTML. That buys bold titles
 * and italic detail on a phone at 3 a.m., and costs one discipline: anything
 * dynamic — a region name, a locality from the feed, a quoted channel post,
 * an error string — goes through esc(). An unescaped "<" makes Telegram
 * reject the whole message, and for a notification that is a warning nobody
 * receives. HTML rather than MarkdownV2 because HTML needs three characters
 * escaped, MarkdownV2 needs eighteen, and quoted posts contain all of them.
 */

export const HTML = Object.freeze({ parse_mode: 'HTML' });

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Bold. Escapes its argument — pass raw text, not pre-escaped text. */
export const b = (text) => `<b>${esc(text)}</b>`;
/** Italic. Escapes its argument. */
export const i = (text) => `<i>${esc(text)}</i>`;
/** Monospace. Escapes its argument. */
export const code = (text) => `<code>${esc(text)}</code>`;

const ALLOWED_TAG_RE = /&lt;(\/?)(b|i|strong|em)&gt;/gi;

/**
 * Makes AI output safe to send as HTML. The model is allowed <b> and <i> and
 * nothing else; everything is escaped, then only those tags are restored. If
 * the tags don't balance — models do forget a closing tag — all tags are
 * dropped rather than risk Telegram rejecting the message.
 */
export function sanitizeAiHtml(text) {
  const escaped = esc(text);
  const restored = escaped.replace(ALLOWED_TAG_RE, (_, slash, tag) => {
    const t = tag.toLowerCase() === 'strong' ? 'b' : tag.toLowerCase() === 'em' ? 'i' : tag.toLowerCase();
    return `<${slash}${t}>`;
  });
  for (const tag of ['b', 'i']) {
    const opens = (restored.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
    const closes = (restored.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (opens !== closes) return restored.replace(/<\/?(b|i)>/g, '');
  }
  // Markdown the model slipped in despite instructions reads as noise; drop it.
  return restored.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
}

/** Plain text from a formatted message — for logs and tests. */
export function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
