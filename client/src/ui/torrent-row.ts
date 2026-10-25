import type { TorrentSummary } from '../../../server/torrents-api.js';
import { formatBytes, formatSpeed, stateLabel } from '../format.js';
import { playHref } from '../player-route.js';
import { button, linkButton } from './button.js';
import { el, uniqueId } from './dom.js';
import { progressBar, updateProgressBar } from './progress-bar.js';
import { stateBadge, updateStateBadge } from './state-badge.js';

export interface TorrentRowActions {
  onToggle(expanded: boolean): void;
  onRemove(): void;
  onRetry(): void;
}

export interface TorrentRow {
  element: HTMLLIElement;
  readonly expanded: boolean;
  update(torrent: TorrentSummary): void;
  // Replaces what the expanded area shows: a file list or a short note.
  setFiles(content: Node): void;
  // An error from Remove or Retry, or null to clear it.
  setActionError(message: string | null): void;
}

// Only the selected files download (Decision #18), so when that is less than
// the whole torrent both sizes are shown.
function size({ length, selectedLength }: TorrentSummary): string {
  if (length === null) return 'Size not known yet';
  if (selectedLength === null || selectedLength >= length) {
    return formatBytes(length);
  }
  return `${formatBytes(selectedLength)} of ${formatBytes(length)} selected`;
}

function stats(torrent: TorrentSummary): string {
  const parts = [
    size(torrent),
    `${torrent.numPeers} ${torrent.numPeers === 1 ? 'peer' : 'peers'}`,
    `↓ ${formatSpeed(torrent.downloadSpeed)}`,
    `↑ ${formatSpeed(torrent.uploadSpeed)}`,
  ];
  return parts.join(' · ');
}

// One torrent in the list. It is updated in place every second, so it never
// rebuilds the elements a user may be focused on or clicking.
export function torrentRow(
  initial: TorrentSummary,
  actions: TorrentRowActions,
): TorrentRow {
  let expanded = false;
  const filesId = uniqueId('files');
  const name = el('span', { className: 'torrent__name' });
  const toggle = el(
    'button',
    {
      className: 'torrent__toggle',
      attrs: {
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': filesId,
      },
    },
    name,
  );
  const badge = stateBadge();
  const progress = progressBar('Download progress');
  const statsLine = el('p', { className: 'torrent__stats' });
  const errorLine = el('p', { className: 'torrent__error' });
  const actionError = el('p', {
    className: 'torrent__error',
    attrs: { role: 'alert' },
  });
  actionError.hidden = true;
  // Opens the player on the main video; shown once there is one to play.
  const play = linkButton({ label: 'Play', href: '#', variant: 'primary' });
  const retry = button({ label: 'Retry', onClick: () => actions.onRetry() });
  const remove = button({
    label: 'Remove',
    variant: 'danger',
    onClick: () => actions.onRemove(),
  });
  const files = el('div', {
    className: 'torrent__files',
    attrs: { id: filesId },
  });
  files.hidden = true;

  const element = el(
    'li',
    { className: 'torrent' },
    el('div', { className: 'torrent__head' }, toggle, badge),
    progress,
    statsLine,
    errorLine,
    actionError,
    el('div', { className: 'torrent__actions' }, play, retry, remove),
    files,
  );

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    files.hidden = !expanded;
    actions.onToggle(expanded);
  });

  const row: TorrentRow = {
    element,
    get expanded() {
      return expanded;
    },
    update(torrent) {
      element.dataset.infoHash = torrent.infoHash;
      element.dataset.state = torrent.state;
      // A magnet link has no name until its metadata arrives.
      name.textContent = torrent.name ?? torrent.infoHash;
      updateStateBadge(badge, stateLabel(torrent));
      updateProgressBar(progress, torrent.progress);
      statsLine.textContent = stats(torrent);
      const failed = torrent.state === 'error';
      errorLine.textContent = failed ? (torrent.errorMessage ?? '') : '';
      errorLine.hidden = !failed;
      retry.hidden = !failed;
      const playable = !failed && torrent.mainFile !== null;
      play.hidden = !playable;
      if (playable) {
        play.href = playHref(torrent.infoHash, torrent.mainFile as number);
      }
    },
    setFiles(content) {
      files.replaceChildren(content);
    },
    setActionError(message) {
      actionError.textContent = message ?? '';
      actionError.hidden = message === null;
    },
  };
  row.update(initial);
  return row;
}
