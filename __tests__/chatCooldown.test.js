/**
 * Passive "тривога" triggers fire on any matching message; during a raid an
 * active group would otherwise get one photo per message (and Telegram 429s).
 */
import { describe, it, expect } from 'vitest';

import { isOnCooldown, CHAT_COOLDOWN_MS } from '../bot.js';

describe('isOnCooldown', () => {
  it('allows the first reply and suppresses further ones inside the window', () => {
    const t0 = 1_000_000;

    expect(isOnCooldown('chat-a', t0)).toBe(false);
    expect(isOnCooldown('chat-a', t0 + 1_000)).toBe(true);
    expect(isOnCooldown('chat-a', t0 + CHAT_COOLDOWN_MS - 1)).toBe(true);
  });

  it('measures the window from the last reply, not the last attempt', () => {
    const t0 = 5_000_000;

    expect(isOnCooldown('chat-window', t0)).toBe(false);
    // Suppressed attempts must not push the window forward.
    expect(isOnCooldown('chat-window', t0 + 10_000)).toBe(true);
    expect(isOnCooldown('chat-window', t0 + CHAT_COOLDOWN_MS)).toBe(false);
  });

  it('scopes the window per reply kind, so one question cannot mask another', () => {
    const t0 = 6_000_000;

    expect(isOnCooldown('42:map', t0)).toBe(false);
    // A deliberate "чому тривога в X" right after a generic "тривога" must
    // still be answered — it is a different question, not a repeat.
    expect(isOnCooldown('42:why:c:київ', t0 + 1_000)).toBe(false);
    expect(isOnCooldown('42:map', t0 + 1_000)).toBe(true);
  });

  it('tracks chats independently', () => {
    const t0 = 2_000_000;

    expect(isOnCooldown('chat-b', t0)).toBe(false);
    expect(isOnCooldown('chat-c', t0)).toBe(false);
    expect(isOnCooldown('chat-b', t0 + 500)).toBe(true);
    expect(isOnCooldown('chat-c', t0 + 500)).toBe(true);
  });

  it('honours a custom cooldown length', () => {
    const t0 = 4_000_000;

    expect(isOnCooldown('chat-d', t0, 1_000)).toBe(false);
    expect(isOnCooldown('chat-d', t0 + 500, 1_000)).toBe(true);
    expect(isOnCooldown('chat-d', t0 + 1_000, 1_000)).toBe(false);
  });

  it('bounds its bookkeeping so a busy bot cannot grow it without limit', () => {
    const t0 = 3_000_000;

    for (let i = 0; i < 600; i += 1) isOnCooldown(`bulk-${i}`, t0);

    // The map keeps 500 entries; the oldest chats have been evicted, so an
    // early one is no longer considered on cooldown.
    expect(isOnCooldown('bulk-0', t0 + 1)).toBe(false);
    expect(isOnCooldown('bulk-599', t0 + 1)).toBe(true);
  });
});
