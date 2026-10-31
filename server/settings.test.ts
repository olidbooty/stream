import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  GB,
  parseSettings,
  SETTINGS_FILE,
  SettingsStore,
} from './settings.js';

describe('defaultSettings', () => {
  it('has no disk limit unless DISK_LIMIT_GB is set', () => {
    expect(defaultSettings({})).toEqual({ diskLimit: null });
    expect(defaultSettings({ DISK_LIMIT_GB: '' })).toEqual({ diskLimit: null });
    expect(defaultSettings({ DISK_LIMIT_GB: '0' })).toEqual({
      diskLimit: null,
    });
  });

  it('reads DISK_LIMIT_GB in decimal gigabytes', () => {
    expect(defaultSettings({ DISK_LIMIT_GB: '50' })).toEqual({
      diskLimit: 50 * GB,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '1.5' })).toEqual({
      diskLimit: 1_500_000_000,
    });
  });

  it('rejects a DISK_LIMIT_GB that is not a positive number', () => {
    for (const value of ['ten', '-5', '10GB', 'Infinity']) {
      expect(() => defaultSettings({ DISK_LIMIT_GB: value })).toThrow(
        /DISK_LIMIT_GB/,
      );
    }
  });
});

describe('parseSettings', () => {
  const current = { diskLimit: 5 * GB };

  it('takes a limit in whole bytes, or null for none', () => {
    expect(parseSettings({ diskLimit: GB }, current)).toEqual({
      diskLimit: GB,
    });
    expect(parseSettings({ diskLimit: null }, current)).toEqual({
      diskLimit: null,
    });
  });

  it('keeps the current value for a key left out, and ignores unknown keys', () => {
    expect(parseSettings({}, current)).toEqual(current);
    expect(parseSettings({ theme: 'dark' }, current)).toEqual(current);
  });

  it('refuses anything else', () => {
    for (const body of [
      null,
      [],
      'big',
      { diskLimit: 0 },
      { diskLimit: -1 },
      { diskLimit: 1.5 },
      { diskLimit: '100' },
      { diskLimit: Number.MAX_VALUE },
    ]) {
      expect(parseSettings(body, current)).toBeNull();
    }
  });
});

describe('SettingsStore', () => {
  let downloadDir: string;
  const settingsPath = () => join(downloadDir, SETTINGS_FILE);

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'stream-settings-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(downloadDir, { recursive: true, force: true });
  });

  it('starts from the defaults when nothing is saved', async () => {
    const store = new SettingsStore(downloadDir, { diskLimit: 7 * GB });
    expect(await store.load()).toEqual({ diskLimit: 7 * GB });
  });

  it('saves a change in DOWNLOAD_DIR and reads it back on the next start', async () => {
    const store = new SettingsStore(downloadDir);
    await store.set({ diskLimit: 2 * GB });
    expect(store.get()).toEqual({ diskLimit: 2 * GB });
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      diskLimit: 2 * GB,
    });

    const next = new SettingsStore(downloadDir, { diskLimit: 9 * GB });
    expect(await next.load()).toEqual({ diskLimit: 2 * GB });
  });

  it('keeps an explicit "no limit" over DISK_LIMIT_GB', async () => {
    await new SettingsStore(downloadDir).set({ diskLimit: null });
    const next = new SettingsStore(downloadDir, { diskLimit: 9 * GB });
    expect(await next.load()).toEqual({ diskLimit: null });
  });

  it('applies the last of several quick changes', async () => {
    const store = new SettingsStore(downloadDir);
    void store.set({ diskLimit: GB });
    void store.set({ diskLimit: 3 * GB });
    await store.flush();
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      diskLimit: 3 * GB,
    });
  });

  it('ignores an unreadable file and leaves it on disk', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const text of ['{not json', '{"diskLimit": -4}']) {
      writeFileSync(settingsPath(), text);
      const store = new SettingsStore(downloadDir, { diskLimit: GB });
      expect(await store.load()).toEqual({ diskLimit: GB });
      expect(readFileSync(settingsPath(), 'utf8')).toBe(text);
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('ignoring unreadable settings'),
    );
  });
});
