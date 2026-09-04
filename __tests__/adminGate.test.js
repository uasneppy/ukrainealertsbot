/**
 * A bot that lets any group member mute ballistic warnings for everyone is a
 * bot one troll can switch off, so the gate errs toward "no".
 */
import { describe, it, expect, vi } from 'vitest';

import { createAdminGate, isGroupChat } from '../neptun/adminGate.js';

const group = { id: -100, type: 'supergroup' };
const user = { id: 5 };

describe('createAdminGate', () => {
  it('requires getChatMember', () => {
    expect(() => createAdminGate()).toThrow('getChatMember is required');
  });

  it('lets anyone manage a private chat without asking Telegram', async () => {
    const getChatMember = vi.fn();
    const gate = createAdminGate({ getChatMember });
    await expect(gate.canManage({ chat: { id: 5, type: 'private' }, from: user })).resolves.toMatchObject({ allowed: true });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  it('allows admins and creators in a group, denies members', async () => {
    const statuses = { 1: 'creator', 2: 'administrator', 3: 'member', 4: 'left' };
    const gate = createAdminGate({ getChatMember: async (_, userId) => ({ status: statuses[userId] }) });
    for (const [id, expected] of [[1, true], [2, true], [3, false], [4, false]]) {
      const { allowed } = await gate.canManage({ chat: group, from: { id } });
      expect(allowed).toBe(expected);
    }
  });

  it('treats a post from the group itself (anonymous admin) as an admin', async () => {
    const getChatMember = vi.fn();
    const gate = createAdminGate({ getChatMember });
    const result = await gate.canManage({ chat: group, from: { id: 1087968824 }, senderChat: { id: -100 } });
    expect(result).toMatchObject({ allowed: true, reason: 'anonymous-admin' });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  it('denies when there is no user to check', async () => {
    const gate = createAdminGate({ getChatMember: vi.fn() });
    await expect(gate.canManage({ chat: group })).resolves.toMatchObject({ allowed: false });
    await expect(gate.canManage({})).resolves.toMatchObject({ allowed: false });
  });

  it('denies, and does not cache, when Telegram cannot be asked', async () => {
    const getChatMember = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ status: 'administrator' });
    const gate = createAdminGate({ getChatMember, log: { warn() {} } });

    await expect(gate.canManage({ chat: group, from: user })).resolves.toMatchObject({ allowed: false, reason: 'unknown' });
    await expect(gate.canManage({ chat: group, from: user })).resolves.toMatchObject({ allowed: true });
  });

  it('caches a verdict for the TTL and re-asks after it', async () => {
    let clock = 0;
    const getChatMember = vi.fn(async () => ({ status: 'administrator' }));
    const gate = createAdminGate({ getChatMember, ttlMs: 1_000, now: () => clock });

    await gate.canManage({ chat: group, from: user });
    await gate.canManage({ chat: group, from: user });
    expect(getChatMember).toHaveBeenCalledTimes(1);

    clock += 1_500;
    await gate.canManage({ chat: group, from: user });
    expect(getChatMember).toHaveBeenCalledTimes(2);
  });
});

describe('isGroupChat', () => {
  it('recognises groups and supergroups only', () => {
    expect(isGroupChat({ type: 'group' })).toBe(true);
    expect(isGroupChat({ type: 'supergroup' })).toBe(true);
    expect(isGroupChat({ type: 'private' })).toBe(false);
    expect(isGroupChat({ type: 'channel' })).toBe(false);
    expect(isGroupChat(null)).toBe(false);
  });
});
