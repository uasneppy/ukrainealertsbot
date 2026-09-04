/**
 * One unescaped "<" makes Telegram reject the whole message — for a
 * notification, a warning nobody receives. Everything dynamic goes through
 * esc(); AI output is allowed two tags and must balance them.
 */
import { describe, it, expect } from 'vitest';

import { esc, b, i, code, sanitizeAiHtml, stripHtml, HTML } from '../neptun/telegramFormat.js';

describe('esc / b / i / code', () => {
  it('escapes the three characters Telegram HTML cares about', () => {
    expect(esc('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(esc(null)).toBe('');
    expect(esc(42)).toBe('42');
  });

  it('wraps and escapes', () => {
    expect(b('Київ <x>')).toBe('<b>Київ &lt;x&gt;</b>');
    expect(i('a&b')).toBe('<i>a&amp;b</i>');
    expect(code('/map <r>')).toBe('<code>/map &lt;r&gt;</code>');
    expect(HTML).toEqual({ parse_mode: 'HTML' });
  });
});

describe('sanitizeAiHtml', () => {
  it('keeps balanced <b> and <i>, escapes everything else', () => {
    const out = sanitizeAiHtml('🔴 <b>Київ</b>: <i>дрони</i> з півдня <script>x</script> & 5 < 6');
    expect(out).toBe('🔴 <b>Київ</b>: <i>дрони</i> з півдня &lt;script&gt;x&lt;/script&gt; &amp; 5 &lt; 6');
  });

  it('drops all tags when they do not balance', () => {
    expect(sanitizeAiHtml('<b>Київ: дрони')).toBe('Київ: дрони');
    expect(sanitizeAiHtml('<b>a</b> <i>b')).toBe('a b');
  });

  it('maps <strong>/<em> to the Telegram tags and converts stray markdown bold', () => {
    expect(sanitizeAiHtml('<strong>a</strong> <em>b</em>')).toBe('<b>a</b> <i>b</i>');
    expect(sanitizeAiHtml('**Київ** під загрозою')).toBe('<b>Київ</b> під загрозою');
  });
});

describe('stripHtml', () => {
  it('returns the plain text', () => {
    expect(stripHtml('🔴 <b>Повітряна тривога</b> — <b>Київ &lt;x&gt;</b>')).toBe('🔴 Повітряна тривога — Київ <x>');
  });
});
