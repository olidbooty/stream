import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeDiskLimit,
  defaultSettings,
  dlnaEnabled,
  GB,
  parseSettings,
  SETTINGS_FILE,
  SettingsStore,
} from './settings.js';

describe('dlnaEnabled', () => {
  it('is on unless DLNA=0', () => {
    expect(dlnaEnabled(undefined)).toBe(true);
    expect(dlnaEnabled('')).toBe(true);
    expect(dlnaEnabled('1')).toBe(true);
    expect(dlnaEnabled('0')).toBe(false);
    expect(() => dlnaEnabled('yes')).toThrow('DLNA must be 1 or 0');
  });
});

describe('defaultSettings, DLNA', () => {
  it('starts with DLNA off for DLNA=0', () => {
    expect(defaultSettings({ DLNA: '0' }).dlnaOn).toBe(false);
    expect(defaultSettings({ DLNA: '0', DISK_LIMIT_GB: '5' }).dlnaOn).toBe(
      false,
    );
  });
});

describe('parseSettings, DLNA', () => {
  const current = { diskLimitOn: true, diskLimit: 1000, dlnaOn: true };

  it('turns DLNA off and on, keeping the disk limit', () => {
    expect(parseSettings({ dlnaOn: false }, current)).toEqual({
      ...current,
      dlnaOn: false,
    });
    expect(parseSettings({ diskLimit: 2000 }, current)?.dlnaOn).toBe(true);
  });

  it('rejects a dlnaOn that is not a boolean', () => {
    expect(parseSettings({ dlnaOn: 'yes' }, current)).toBeNull();
  });

  it('keeps DLNA on for a file saved before the setting existed', () => {
    expect(
      parseSettings({ diskLimitOn: false, diskLimit: null }, current)?.dlnaOn,
    ).toBe(true);
  });
});

describe('SettingsStore.onChange', () => {
  it('tells listeners about each change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stream-settings-'));
    const store = new SettingsStore(dir);
    const seen: boolean[] = [];
    store.onChange((settings) => seen.push(settings.dlnaOn));
    void store.set({ ...store.get(), dlnaOn: false });
    void store.set({ ...store.get(), dlnaOn: true });
    expect(seen).toEqual([false, true]);
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('defaultSettings', () => {
  it('has no disk limit unless DISK_LIMIT_GB is set', () => {
    expect(defaultSettings({})).toEqual({
      diskLimitOn: false,
      diskLimit: null,
      dlnaOn: true,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '' })).toEqual({
      diskLimitOn: false,
      diskLimit: null,
      dlnaOn: true,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '0' })).toEqual({
      diskLimitOn: false,
      diskLimit: null,
      dlnaOn: true,
    });
  });

  it('reads DISK_LIMIT_GB in decimal gigabytes', () => {
    expect(defaultSettings({ DISK_LIMIT_GB: '50' })).toEqual({
      diskLimitOn: true,
      diskLimit: 50 * GB,
      dlnaOn: true,
    });
    expect(defaultSettings({ DISK_LIMIT_GB: '1.5' })).toEqual({
      diskLimitOn: true,
      diskLimit: 1_500_000_000,
      dlnaOn: true,
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
  const current = { diskLimitOn: true, diskLimit: 5 * GB, dlnaOn: true };

  it('takes a limit in whole bytes, on or off', () => {
    expect(
      parseSettings(
        { diskLimitOn: true, diskLimit: GB, dlnaOn: true },
        current,
      ),
    ).toEqual({ diskLimitOn: true, diskLimit: GB, dlnaOn: true });
    expect(
      parseSettings(
        { diskLimitOn: false, diskLimit: 2 * GB, dlnaOn: true },
        current,
      ),
    ).toEqual({ diskLimitOn: false, diskLimit: 2 * GB, dlnaOn: true });
  });

  it('keeps the number when the limit is turned off', () => {
    expect(parseSettings({ diskLimitOn: false }, current)).toEqual({
      diskLimitOn: false,
      diskLimit: 5 * GB,
      dlnaOn: true,
    });
    expect(
      parseSettings(
        { diskLimitOn: false, diskLimit: null, dlnaOn: true },
        current,
      ),
    ).toEqual({ diskLimitOn: false, diskLimit: 5 * GB, dlnaOn: true });
    const off = { diskLimitOn: false, diskLimit: 5 * GB, dlnaOn: true };
    expect(parseSettings({ diskLimitOn: true }, off)).toEqual(current);
  });

  it('reads a diskLimit on its own as before the switch', () => {
    const off = { diskLimitOn: false, diskLimit: null, dlnaOn: true };
    expect(parseSettings({ diskLimit: GB }, off)).toEqual({
      diskLimitOn: true,
      diskLimit: GB,
      dlnaOn: true,
    });
    expect(parseSettings({ diskLimit: null }, current)).toEqual({
      diskLimitOn: false,
      diskLimit: 5 * GB,
      dlnaOn: true,
    });
  });

  it('refuses to turn the limit on without a number', () => {
    const none = { diskLimitOn: false, diskLimit: null, dlnaOn: true };
    expect(parseSettings({ diskLimitOn: true }, none)).toBeNull();
    expect(
      parseSettings(
        { diskLimitOn: true, diskLimit: null, dlnaOn: true },
        current,
      ),
    ).toBeNull();
    expect(parseSettings({ diskLimitOn: 'yes' }, current)).toBeNull();
  });

  it('applies the number only while the limit is on', () => {
    expect(activeDiskLimit(current)).toBe(5 * GB);
    expect(
      activeDiskLimit({ diskLimitOn: false, diskLimit: 5 * GB, dlnaOn: true }),
    ).toBe(null);
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
      { diskLimitOn: true, diskLimit: 0, dlnaOn: true },
      { diskLimitOn: true, diskLimit: -1, dlnaOn: true },
      { diskLimitOn: true, diskLimit: 1.5, dlnaOn: true },
      { diskLimitOn: true, diskLimit: '100', dlnaOn: true },
      { diskLimitOn: true, diskLimit: Number.MAX_VALUE, dlnaOn: true },
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
      dlnaOn: true,
    });
    expect(await store.load()).toEqual({
      diskLimitOn: true,
      diskLimit: 7 * GB,
      dlnaOn: true,
    });
  });

  it('saves a change in DOWNLOAD_DIR and reads it back on the next start', async () => {
    const store = new SettingsStore(downloadDir);
    await store.set({ diskLimitOn: true, diskLimit: 2 * GB, dlnaOn: true });
    expect(store.get()).toEqual({
      diskLimitOn: true,
      diskLimit: 2 * GB,
      dlnaOn: true,
    });
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      diskLimitOn: true,
      diskLimit: 2 * GB,
      dlnaOn: true,
    });

    const next = new SettingsStore(downloadDir, {
      diskLimitOn: true,
      diskLimit: 9 * GB,
      dlnaOn: true,
    });
    expect(await next.load()).toEqual({
      diskLimitOn: true,
      diskLimit: 2 * GB,
      dlnaOn: true,
    });
  });

  it('keeps an explicit "no limit" over DISK_LIMIT_GB', async () => {
    await new SettingsStore(downloadDir).set({
      diskLimitOn: false,
      diskLimit: null,
      dlnaOn: true,
    });
    const next = new SettingsStore(downloadDir, {
      diskLimitOn: true,
      diskLimit: 9 * GB,
      dlnaOn: true,
    });
    expect((await next.load()).diskLimitOn).toBe(false);
  });

  it('applies the last of several quick changes', async () => {
    const store = new SettingsStore(downloadDir);
    void store.set({ diskLimitOn: true, diskLimit: GB, dlnaOn: true });
    void store.set({ diskLimitOn: true, diskLimit: 3 * GB, dlnaOn: true });
    await store.flush();
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      diskLimitOn: true,
      diskLimit: 3 * GB,
      dlnaOn: true,
    });
  });

  it('ignores an unreadable file and leaves it on disk', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const text of ['{not json', '{"diskLimit": -4}']) {
      writeFileSync(settingsPath(), text);
      const store = new SettingsStore(downloadDir, {
        diskLimitOn: true,
        diskLimit: GB,
        dlnaOn: true,
      });
      expect(await store.load()).toEqual({
        diskLimitOn: true,
        diskLimit: GB,
        dlnaOn: true,
      });
      expect(readFileSync(settingsPath(), 'utf8')).toBe(text);
    }
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('ignoring unreadable settings'),
    );
  });
});
