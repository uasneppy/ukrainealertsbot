/**
 * Settings persist beside subscriptions for the same reason: one silently
 * reset on redeploy is a chat that muted ballistics and gets them at 3 a.m.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
  NOTIFY_CATEGORIES,
  isNotifyCategory,
  loadChatSettings,
  flushChatSettings,
  getChatSettings,
  setChatSetting,
  toggleChatSetting,
  formatSettingsMessage,
  getChatSettingsFile,
  __resetChatSettings,
} from '../neptun/chatSettings.js';
import { stripHtml } from '../neptun/telegramFormat.js';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-settings-'));
  process.env.CHAT_SETTINGS_FILE = path.join(dir, 'chatSettings.json');
  __resetChatSettings();
});

afterEach(async () => {
  await flushChatSettings();
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.CHAT_SETTINGS_FILE;
});

describe('chat settings', () => {
  it('defaults every category to on', () => {
    const settings = getChatSettings(42);
    for (const { key } of NOTIFY_CATEGORIES) expect(settings[key]).toBe(true);
  });

  it('toggles and persists only the overrides', async () => {
    expect(toggleChatSetting(42, 'kalibr')).toMatchObject({ kalibr: false, alert: true });
    await flushChatSettings();

    const stored = JSON.parse(await fs.readFile(getChatSettingsFile(), 'utf8'));
    expect(stored.chats['42']).toEqual({ kalibr: false });

    expect(toggleChatSetting(42, 'kalibr')).toMatchObject({ kalibr: true });
    await flushChatSettings();
    const after = JSON.parse(await fs.readFile(getChatSettingsFile(), 'utf8'));
    expect(after.chats['42']).toBeUndefined();
  });

  it('rejects unknown keys instead of storing them', () => {
    expect(setChatSetting(42, 'nonsense', false)).toBeNull();
    expect(toggleChatSetting(42, '')).toBeNull();
    expect(isNotifyCategory('alert')).toBe(true);
    expect(isNotifyCategory('nonsense')).toBe(false);
  });

  it('survives a reload', async () => {
    setChatSetting(7, 'uav', false);
    setChatSetting(7, 'strategic', false);
    await flushChatSettings();

    __resetChatSettings();
    await loadChatSettings();

    expect(getChatSettings(7)).toMatchObject({ uav: false, strategic: false, alert: true });
  });

  it('starts empty on a corrupt file rather than failing to boot', async () => {
    await fs.writeFile(getChatSettingsFile(), '{ not json', 'utf8');
    await expect(loadChatSettings()).resolves.toBeUndefined();
    expect(getChatSettings(1).alert).toBe(true);
  });

  it('drops unknown or non-false values on load', async () => {
    await fs.writeFile(getChatSettingsFile(), JSON.stringify({
      version: 1, chats: { 9: { alert: 'no', bogus: false, uav: false } },
    }), 'utf8');
    await loadChatSettings();
    expect(getChatSettings(9)).toMatchObject({ alert: true, uav: false });
  });
});

describe('formatSettingsMessage', () => {
  it('lists every category with its state', () => {
    const text = stripHtml(formatSettingsMessage({ ...getChatSettings(1), kalibr: false }));
    expect(text).toContain('✅ 🔴 Тривога / відбій');
    expect(text).toContain('🔕 🚢 «Калібри»');
    expect(text).not.toContain('адміністратори');
  });

  it('tells a group who may change it', () => {
    expect(stripHtml(formatSettingsMessage(getChatSettings(1), { isGroup: true }))).toContain('адміністратори');
  });
});
