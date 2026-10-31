import type { Leftover, LeftoversInfo } from '../../server/leftovers.js';
import type { SettingsInfo } from '../../server/settings-api.js';
import type { TorrentSummary } from '../../server/torrents-api.js';
import type { Api } from './api.js';
import { formatBytes } from './format.js';
import { button } from './ui/button.js';
import { el } from './ui/dom.js';
import { field } from './ui/field.js';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// Decimal, like formatBytes and the server's DISK_LIMIT_GB.
const GB = 1_000_000_000;

// Usage is fetched again at most this often as the torrent list updates.
export const USAGE_REFRESH_MS = 5000;

export interface SettingsPanelOptions {
  api: Pick<
    Api,
    'getSettings' | 'saveSettings' | 'getLeftovers' | 'deleteLeftover'
  >;
  // Asked before a leftover is deleted; resolves true to go ahead.
  confirm: (message: string) => Promise<boolean>;
  now?: () => number;
}

export interface SettingsPanel {
  element: HTMLElement;
  // Shows the server's settings and usage; the input is only overwritten
  // while the user isn't editing it.
  update(info: SettingsInfo): void;
  // Lists the leftover files, or hides the list when there are none.
  updateLeftovers(info: LeftoversInfo): void;
  // Asks the server for them; hidden if it can't answer.
  load(): Promise<void>;
  // Loads again if the last load is older than USAGE_REFRESH_MS, e.g. on
  // every torrent list update.
  refresh(): void;
  // Shown with the torrent list.
  setShown(shown: boolean): void;
}

// What the list page shows while the limit holds downloads back, since the
// usage itself is on the settings page; null when nothing is held back.
export function diskFullMessage(
  torrents: readonly Pick<TorrentSummary, 'state'>[],
): string | null {
  return torrents.some((torrent) => torrent.state === 'diskFull')
    ? 'Downloads are paused because the disk limit is reached. Remove a torrent, or raise the limit in Settings.'
    : null;
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

// Decision #36: the disk limit, saved on the server for every device. On the
// settings page with the TV address, since both are set once and then rarely
// changed.
export function settingsPanel({
  api,
  confirm,
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
  // Decision #38: files no torrent owns, deleted only when the user asks.
  const leftoverList = el('ul', { className: 'settings__leftovers' });
  const leftoverError = el('p', {
    className: 'field__error',
    attrs: { role: 'alert' },
  });
  const leftovers = el(
    'div',
    { className: 'settings' },
    el('h3', { text: 'Leftover files' }),
    el('p', {
      className: 'settings__usage',
      text: 'In the downloads folder but not part of any torrent here, for example from a torrent removed before a restart. They use disk space but don’t count towards the limit.',
    }),
    leftoverList,
    leftoverError,
  );
  leftovers.hidden = true;
  const element = el(
    'section',
    {
      className: 'settings',
      attrs: { 'aria-labelledby': 'settings-heading' },
    },
    el('h2', { text: 'Disk space', attrs: { id: 'settings-heading' } }),
    usage,
    form,
    leftovers,
  );
  // What the list shows, so a refresh with nothing new keeps focus in it.
  let shownLeftovers = '';

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

  function leftoverRow({ name, folder, bytes }: Leftover): HTMLLIElement {
    const remove = button({
      label: 'Delete',
      variant: 'danger',
      onClick: async () => {
        leftoverError.textContent = '';
        const what = folder
          ? `the folder “${name}” and everything in it`
          : `“${name}”`;
        if (!(await confirm(`Delete ${what}? This can’t be undone.`))) return;
        remove.disabled = true;
        try {
          await api.deleteLeftover(name);
          updateLeftovers(await api.getLeftovers());
        } catch (err) {
          leftoverError.textContent = `Couldn’t delete ${name}: ${errorMessage(err, 'something went wrong')}`;
          remove.disabled = false;
        }
      },
    });
    remove.setAttribute('aria-label', `Delete ${name}`);
    return el(
      'li',
      { className: 'settings__leftover' },
      el('span', {
        className: 'settings__leftover-name',
        text: folder ? `${name}/` : name,
      }),
      el('span', { className: 'settings__usage', text: formatBytes(bytes) }),
      remove,
    );
  }

  function updateLeftovers(info: LeftoversInfo): void {
    const key = JSON.stringify(info.leftovers);
    leftovers.hidden = info.pending || info.leftovers.length === 0;
    if (key === shownLeftovers) return;
    shownLeftovers = key;
    leftoverList.replaceChildren(...info.leftovers.map(leftoverRow));
  }

  async function load(): Promise<void> {
    lastLoad = now();
    try {
      update(await api.getSettings());
    } catch {
      // Like the TV address: the status banner already says when the
      // server is down.
      if (!loaded) show();
      return;
    }
    try {
      updateLeftovers(await api.getLeftovers());
    } catch {
      // The list stays as it was; the next refresh tries again.
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
      limit.setError(errorMessage(err, 'Couldn’t save'));
    } finally {
      save.disabled = false;
    }
  });

  return {
    element,
    update,
    updateLeftovers,
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
