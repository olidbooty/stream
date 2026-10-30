import type { SettingsInfo } from '../../server/settings-api.js';
import type { Api } from './api.js';
import { formatBytes } from './format.js';
import { button } from './ui/button.js';
import { el } from './ui/dom.js';
import { field } from './ui/field.js';

// Decimal, like formatBytes and the server's DISK_LIMIT_GB.
const GB = 1_000_000_000;

// Usage is fetched again at most this often as the torrent list updates.
export const USAGE_REFRESH_MS = 5000;

export interface SettingsPanelOptions {
  api: Pick<Api, 'getSettings' | 'saveSettings'>;
  now?: () => number;
}

export interface SettingsPanel {
  element: HTMLElement;
  // Shows the server's settings and usage; the input is only overwritten
  // while the user isn't editing it.
  update(info: SettingsInfo): void;
  // Asks the server for them; hidden if it can't answer.
  load(): Promise<void>;
  // Loads again if the last load is older than USAGE_REFRESH_MS, e.g. on
  // every torrent list update.
  refresh(): void;
  // Shown with the torrent list.
  setShown(shown: boolean): void;
}

// The limit typed in gigabytes: empty for none. Returns undefined when it
// isn't a number above 0.
export function parseLimit(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.');
  if (value === '') return null;
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb <= 0) return undefined;
  return Math.max(1, Math.round(gb * GB));
}

// "12.5", with no trailing zeros, so a saved limit reads as it was typed.
export function limitText(diskLimit: number | null): string {
  return diskLimit === null ? '' : String(Number((diskLimit / GB).toFixed(3)));
}

export function usageText({
  diskLimit,
  diskUsed,
  diskLimitReached,
}: SettingsInfo): string {
  if (diskLimit === null)
    return `Torrents use ${formatBytes(diskUsed)}. No limit.`;
  const usage = `Torrents use ${formatBytes(diskUsed)} of ${formatBytes(diskLimit)}.`;
  return diskLimitReached
    ? `${usage} The limit is reached, so downloads are paused and new torrents are refused. Remove a torrent or raise the limit.`
    : usage;
}

// Decision #36: the disk limit, saved on the server for every device. Below
// the TV address, since it is set once and then rarely changed.
export function settingsPanel({
  api,
  now = Date.now,
}: SettingsPanelOptions): SettingsPanel {
  const limit = field({
    label: 'Disk limit (GB)',
    input: el('input', {
      attrs: {
        type: 'text',
        name: 'diskLimit',
        inputmode: 'decimal',
        autocomplete: 'off',
        placeholder: 'No limit',
      },
    }),
    help: 'Leave empty for no limit. At the limit, downloads pause until you remove a torrent or raise it.',
  });
  const save = button({ label: 'Save', variant: 'primary', type: 'submit' });
  const saved = el('p', {
    className: 'settings__saved',
    attrs: { role: 'status' },
  });
  const usage = el('p', { className: 'settings__usage' });
  const form = el(
    'form',
    { className: 'add-torrent__form' },
    el('div', { className: 'add-torrent__row' }, limit.element, save),
    saved,
  );
  form.noValidate = true;
  const element = el(
    'section',
    {
      className: 'settings',
      attrs: { 'aria-labelledby': 'settings-heading' },
    },
    el('h2', { text: 'Settings', attrs: { id: 'settings-heading' } }),
    usage,
    form,
  );

  let loaded = false;
  let shown = true;
  let lastLoad = -Infinity;
  // Whether the input holds something the user typed and hasn't saved.
  let editing = false;
  const show = () => {
    element.hidden = !(loaded && shown);
  };
  show();

  limit.input.addEventListener('input', () => {
    editing = true;
    saved.textContent = '';
  });

  function update(info: SettingsInfo): void {
    loaded = true;
    show();
    usage.textContent = usageText(info);
    usage.dataset.reached = String(info.diskLimitReached);
    if (!editing) limit.input.value = limitText(info.diskLimit);
  }

  async function load(): Promise<void> {
    lastLoad = now();
    try {
      update(await api.getSettings());
    } catch {
      // Like the TV address: the status banner already says when the
      // server is down.
      if (!loaded) show();
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saved.textContent = '';
    limit.setError(null);
    const diskLimit = parseLimit(limit.input.value);
    if (diskLimit === undefined) {
      limit.setError('Enter a number of gigabytes above 0, or leave it empty');
      return;
    }
    save.disabled = true;
    try {
      const info = await api.saveSettings({ diskLimit });
      editing = false;
      update(info);
      saved.textContent = 'Saved';
    } catch (err) {
      limit.setError(err instanceof Error ? err.message : 'Couldn’t save');
    } finally {
      save.disabled = false;
    }
  });

  return {
    element,
    update,
    load,
    refresh() {
      if (shown && now() - lastLoad >= USAGE_REFRESH_MS) void load();
    },
    setShown(value) {
      shown = value;
      show();
    },
  };
}
