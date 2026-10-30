import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeftoversInfo } from '../../server/leftovers.js';
import type { SettingsInfo } from '../../server/settings-api.js';
import { ApiError } from './api.js';
import {
  limitText,
  parseLimit,
  settingsPanel,
  USAGE_REFRESH_MS,
  usageText,
} from './settings-panel.js';

const GB = 1_000_000_000;
const UNDER: SettingsInfo = {
  diskLimit: 50 * GB,
  diskUsed: 12 * GB,
  diskLimitReached: false,
};

afterEach(() => {
  document.body.replaceChildren();
});

const NONE: LeftoversInfo = { pending: false, leftovers: [] };

function setUp(
  getSettings: () => Promise<SettingsInfo> = async () => UNDER,
  saveSettings = vi.fn(async (): Promise<SettingsInfo> => UNDER),
  now = () => 0,
  {
    getLeftovers = vi.fn(async () => NONE),
    deleteLeftover = vi.fn(async () => {}),
    confirm = vi.fn(async () => true),
  }: {
    getLeftovers?: () => Promise<LeftoversInfo>;
    deleteLeftover?: (name: string) => Promise<void>;
    confirm?: (message: string) => Promise<boolean>;
  } = {},
) {
  const panel = settingsPanel({
    api: { getSettings, saveSettings, getLeftovers, deleteLeftover },
    confirm,
    now,
  });
  document.body.append(panel.element);
  const input = panel.element.querySelector('input') as HTMLInputElement;
  const form = panel.element.querySelector('form') as HTMLFormElement;
  return { panel, input, form, saveSettings };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('parseLimit', () => {
  it('reads gigabytes, empty for no limit', () => {
    expect(parseLimit('50')).toBe(50 * GB);
    expect(parseLimit(' 1.5 ')).toBe(1.5 * GB);
    expect(parseLimit('2,5')).toBe(2.5 * GB);
    expect(parseLimit('')).toBeNull();
    expect(parseLimit('  ')).toBeNull();
  });

  it('refuses anything that is not a number above 0', () => {
    for (const text of ['0', '-3', 'lots', '10GB', 'Infinity']) {
      expect(parseLimit(text)).toBeUndefined();
    }
  });
});

describe('limitText and usageText', () => {
  it('shows a saved limit as it was typed', () => {
    expect(limitText(null)).toBe('');
    expect(limitText(50 * GB)).toBe('50');
    expect(limitText(1.5 * GB)).toBe('1.5');
  });

  it('says how much is used, and what happens at the limit', () => {
    expect(usageText(UNDER)).toBe('Torrents use 12 GB of 50 GB.');
    expect(usageText({ ...UNDER, diskLimit: null })).toBe(
      'Torrents use 12 GB. No limit.',
    );
    expect(
      usageText({ ...UNDER, diskUsed: 50 * GB, diskLimitReached: true }),
    ).toContain('downloads are paused and new torrents are refused');
  });
});

describe('settingsPanel', () => {
  it('is hidden until the settings are loaded', async () => {
    const { panel, input } = setUp();
    expect(panel.element.hidden).toBe(true);
    await panel.load();
    expect(panel.element.hidden).toBe(false);
    expect(input.value).toBe('50');
    expect(panel.element.textContent).toContain('Torrents use 12 GB of 50 GB.');
  });

  it('stays hidden when the server can’t answer', async () => {
    const { panel } = setUp(async () => {
      throw new Error('offline');
    });
    await panel.load();
    expect(panel.element.hidden).toBe(true);
  });

  it('saves the limit in bytes and says so', async () => {
    const { panel, input, form, saveSettings } = setUp();
    await panel.load();
    saveSettings.mockResolvedValueOnce({ ...UNDER, diskLimit: 20 * GB });
    input.value = '20';
    input.dispatchEvent(new Event('input'));
    form.requestSubmit();
    await flush();

    expect(saveSettings).toHaveBeenCalledWith({ diskLimit: 20 * GB });
    expect(input.value).toBe('20');
    expect(panel.element.querySelector('[role="status"]')?.textContent).toBe(
      'Saved',
    );
    expect(panel.element.textContent).toContain('of 20 GB');
  });

  it('saves an empty input as no limit', async () => {
    const { panel, input, form, saveSettings } = setUp();
    await panel.load();
    input.value = '';
    form.requestSubmit();
    await flush();
    expect(saveSettings).toHaveBeenCalledWith({ diskLimit: null });
  });

  it('shows an error for a limit it can’t read, without saving', async () => {
    const { panel, input, form, saveSettings } = setUp();
    await panel.load();
    input.value = 'lots';
    form.requestSubmit();
    await flush();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(panel.element.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter a number of gigabytes above 0, or leave it empty',
    );
  });

  it('shows the server’s error when saving fails', async () => {
    const { panel, form, saveSettings } = setUp();
    await panel.load();
    saveSettings.mockRejectedValueOnce(new ApiError(400, 'diskLimit bad'));
    form.requestSubmit();
    await flush();
    expect(panel.element.querySelector('[role="alert"]')?.textContent).toBe(
      'diskLimit bad',
    );
  });

  it('marks the usage when the limit is reached', async () => {
    const { panel } = setUp();
    panel.update({ ...UNDER, diskUsed: 51 * GB, diskLimitReached: true });
    const usage = panel.element.querySelector(
      '.settings__usage',
    ) as HTMLElement;
    expect(usage.dataset.reached).toBe('true');
  });

  it('keeps what the user is typing when new usage arrives', async () => {
    const { panel, input } = setUp();
    await panel.load();
    input.value = '7';
    input.dispatchEvent(new Event('input'));
    panel.update({ ...UNDER, diskUsed: 13 * GB });
    expect(input.value).toBe('7');
    expect(panel.element.textContent).toContain('Torrents use 13 GB');
  });

  it('loads the usage again at most every few seconds, and not while hidden', async () => {
    let time = 0;
    const getSettings = vi.fn(async () => UNDER);
    const { panel } = setUp(getSettings, undefined, () => time);
    await panel.load();
    panel.refresh();
    expect(getSettings).toHaveBeenCalledTimes(1);

    time = USAGE_REFRESH_MS;
    panel.setShown(false);
    panel.refresh();
    expect(getSettings).toHaveBeenCalledTimes(1);

    panel.setShown(true);
    panel.refresh();
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  describe('leftover files', () => {
    const TWO: LeftoversInfo = {
      pending: false,
      leftovers: [
        { name: 'Old Film', folder: true, bytes: 4 * GB },
        { name: 'stray.mp4', folder: false, bytes: 2_000_000 },
      ],
    };
    const names = (element: HTMLElement) =>
      Array.from(element.querySelectorAll('.settings__leftover-name')).map(
        (node) => node.textContent,
      );
    const leftoversSection = (element: HTMLElement) =>
      element.querySelector('.settings__leftovers')
        ?.parentElement as HTMLElement;

    it('lists them with their size, folders marked', async () => {
      const { panel } = setUp(undefined, undefined, undefined, {
        getLeftovers: async () => TWO,
      });
      await panel.load();
      expect(leftoversSection(panel.element).hidden).toBe(false);
      expect(names(panel.element)).toEqual(['Old Film/', 'stray.mp4']);
      expect(panel.element.textContent).toContain('4.0 GB');
    });

    it('hides the list when there are none or it can’t tell yet', async () => {
      const { panel } = setUp();
      await panel.load();
      expect(leftoversSection(panel.element).hidden).toBe(true);
      panel.updateLeftovers({ ...TWO, pending: true });
      expect(leftoversSection(panel.element).hidden).toBe(true);
    });

    it('deletes one after confirming, then lists the rest', async () => {
      const getLeftovers = vi
        .fn(async () => TWO)
        .mockResolvedValueOnce(TWO)
        .mockResolvedValueOnce({ ...TWO, leftovers: [TWO.leftovers[1]] });
      const deleteLeftover = vi.fn(async () => {});
      const confirm = vi.fn(async () => true);
      const { panel } = setUp(undefined, undefined, undefined, {
        getLeftovers,
        deleteLeftover,
        confirm,
      });
      await panel.load();
      const button = panel.element.querySelector(
        '[aria-label="Delete Old Film"]',
      ) as HTMLButtonElement;
      button.click();
      await flush();

      expect(confirm).toHaveBeenCalledWith(
        'Delete the folder “Old Film” and everything in it? This can’t be undone.',
      );
      expect(deleteLeftover).toHaveBeenCalledWith('Old Film');
      expect(names(panel.element)).toEqual(['stray.mp4']);
    });

    it('does nothing when the confirmation is cancelled', async () => {
      const deleteLeftover = vi.fn(async () => {});
      const { panel } = setUp(undefined, undefined, undefined, {
        getLeftovers: async () => TWO,
        deleteLeftover,
        confirm: async () => false,
      });
      await panel.load();
      (
        panel.element.querySelector(
          '[aria-label="Delete stray.mp4"]',
        ) as HTMLButtonElement
      ).click();
      await flush();
      expect(deleteLeftover).not.toHaveBeenCalled();
    });

    it('shows why a delete failed', async () => {
      const { panel } = setUp(undefined, undefined, undefined, {
        getLeftovers: async () => TWO,
        deleteLeftover: async () => {
          throw new ApiError(404, 'No leftover with that name');
        },
      });
      await panel.load();
      (
        panel.element.querySelector(
          '[aria-label="Delete stray.mp4"]',
        ) as HTMLButtonElement
      ).click();
      await flush();
      expect(
        leftoversSection(panel.element).querySelector('[role="alert"]')
          ?.textContent,
      ).toBe('Couldn’t delete stray.mp4: No leftover with that name');
    });

    it('keeps the rows, and focus, when a refresh brings the same list', async () => {
      const { panel } = setUp(undefined, undefined, undefined, {
        getLeftovers: async () => TWO,
      });
      await panel.load();
      const row = panel.element.querySelector('.settings__leftover');
      panel.updateLeftovers(TWO);
      expect(panel.element.querySelector('.settings__leftover')).toBe(row);
    });
  });
});
