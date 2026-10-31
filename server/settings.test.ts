import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeDiskLimit,
  defaultSettings,
  GB,
  parseSettings,
  SETTINGS_FILE,
  SettingsStore,
} from './settings.js';

describe('defaultSettings', () => {
  it('has no disk limit unless DISK_LIMIT_GB is set', () => {
    expect(defaultSettings({})).toEqual({
      diskLimitOn: false,
      diskLimit: null,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '' })).toEqual({
      diskLimitOn: false,
      diskLimit: null,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '0' })).toEqual({
      diskLimitOn: false,
      diskLimit: null,
    });
  });

  it('reads DISK_LIMIT_GB in decimal gigabytes', () => {
    expect(defaultSettings({ DISK_LIMIT_GB: '50' })).toEqual({
      diskLimitOn: true,
      diskLimit: 50 * GB,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '1.5' })).toEqual({
      diskLimitOn: true,
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
  const current = { diskLimitOn: true, diskLimit: 5 * GB };

  it('takes a limit in whole bytes, on or off', () => {
    expect(
      parseSettings({ diskLimitOn: true, diskLimit: GB }, current),
    ).toEqual({ diskLimitOn: true, diskLimit: GB });
    expect(
      parseSettings({ diskLimitOn: false, diskLimit: 2 * GB }, current),
    ).toEqual({ diskLimitOn: false, diskLimit: 2 * GB });
  });

  it('keeps the number when the limit is turned off', () => {
    expect(parseSettings({ diskLimitOn: false }, current)).toEqual({
      diskLimitOn: false,
      diskLimit: 5 * GB,
    });
    expect(
      parseSettings({ diskLimitOn: false, diskLimit: null }, current),
    ).toEqual({ diskLimitOn: false, diskLimit: 5 * GB });
    const off = { diskLimitOn: false, diskLimit: 5 * GB };
    expect(parseSettings({ diskLimitOn: true }, off)).toEqual(current);
  });

  it('reads a diskLimit on its own as before the switch', () => {
    const off = { diskLimitOn: false, diskLimit: null };
    expect(parseSettings({ diskLimit: GB }, off)).toEqual({
      diskLimitOn: true,
      diskLimit: GB,
    });
    expect(parseSettings({ diskLimit: null }, current)).toEqual({
      diskLimitOn: false,
      diskLimit: 5 * GB,
    });
  });

  it('refuses to turn the limit on without a number', () => {
    const none = { diskLimitOn: false, diskLimit: null };
    expect(parseSettings({ diskLimitOn: true }, none)).toBeNull();
    expect(
      parseSettings({ diskLimitOn: true, diskLimit: null }, current),
    ).toBeNull();
    expect(parseSettings({ diskLimitOn: 'yes' }, current)).toBeNull();
  });

  it('applies the number only while the limit is on', () => {
    expect(activeDiskLimit(current)).toBe(5 * GB);
    expect(activeDiskLimit({ diskLimitOn: false, diskLimit: 5 * GB })).toBe(
      null,
    );
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
      { diskLimitOn: true, diskLimit: 0 },
      { diskLimitOn: true, diskLimit: -1 },
      { diskLimitOn: true, diskLimit: 1.5 },
      { diskLimitOn: true, diskLimit: '100' },
      { diskLimitOn: true, diskLimit: Number.MAX_VALUE },
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
    const store = new SettingsStore(downloadDir, {
      diskLimitOn: true,
      diskLimit: 7 * GB,
    });
    expect(await store.load()).toEqual({
      diskLimitOn: true,
      diskLimit: 7 * GB,
    });
  });

  it('saves a change in DOWNLOAD_DIR and reads it back on the next start', async () => {
    const store = new SettingsStore(downloadDir);
    await store.set({ diskLimitOn: true, diskLimit: 2 * GB });
    expect(store.get()).toEqual({ diskLimitOn: true, diskLimit: 2 * GB });
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      diskLimitOn: true,
      diskLimit: 2 * GB,
    });

    const next = new SettingsStore(downloadDir, {
      diskLimitOn: true,
      diskLimit: 9 * GB,
    });
    expect(await next.load()).toEqual({ diskLimitOn: true, diskLimit: 2 * GB });
  });

  it('keeps an explicit "no limit" over DISK_LIMIT_GB', async () => {
    await new SettingsStore(downloadDir).set({
      diskLimitOn: false,
      diskLimit: null,
    });
    const next = new SettingsStore(downloadDir, {
      diskLimitOn: true,
      diskLimit: 9 * GB,
    });
    expect((await next.load()).diskLimitOn).toBe(false);
  });

  it('applies the last of several quick changes', async () => {
    const store = new SettingsStore(downloadDir);
    void store.set({ diskLimitOn: true, diskLimit: GB });
    void store.set({ diskLimitOn: true, diskLimit: 3 * GB });
    await store.flush();
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      diskLimitOn: true,
      diskLimit: 3 * GB,
    });
  });

  it('ignores an unreadable file and leaves it on disk', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const text of ['{not json', '{"diskLimit": -4}']) {
      writeFileSync(settingsPath(), text);
      const store = new SettingsStore(downloadDir, {
        diskLimitOn: true,
        diskLimit: GB,
      });
      expect(await store.load()).toEqual({ diskLimitOn: true, diskLimit: GB });
      expect(readFileSync(settingsPath(), 'utf8')).toBe(text);
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('ignoring unreadable settings'),
    );
  });
});
