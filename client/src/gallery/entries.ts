import type { TorrentSummary } from '../../../server/torrents-api.js';
import { ApiError } from '../api.js';
import { type StateLabel, stateLabel } from '../format.js';
import { STATUS_MESSAGES } from '../live-updates.js';
import { sampleDetail, sampleSummary } from '../sample-data.js';
import { torrentForm } from '../torrent-form.js';
import { torrentList } from '../torrent-list.js';
import { button } from '../ui/button.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { el } from '../ui/dom.js';
import { field } from '../ui/field.js';
import { fileList } from '../ui/file-list.js';
import { progressBar, updateProgressBar } from '../ui/progress-bar.js';
import { stateBadge, updateStateBadge } from '../ui/state-badge.js';
import { statusBanner } from '../ui/status-banner.js';
import { torrentRow } from '../ui/torrent-row.js';

// One component in one state, rendered from sample data with no server.
export interface GalleryEntry {
  component: string;
  state: string;
  render(): HTMLElement;
}

const MAGNET_HASH = 'c9e15763f722f23e98a29decdfae341b98d53056';

// A magnet link before its metadata arrives: no name, size or peers yet.
const pendingMagnet = sampleSummary({
  infoHash: MAGNET_HASH,
  name: null,
  magnetURI: `magnet:?xt=urn:btih:${MAGNET_HASH}`,
  hasMetadata: false,
  ready: false,
  length: null,
  selectedLength: null,
  progress: 0,
  numPeers: 0,
  downloadSpeed: 0,
  uploadSpeed: 0,
  state: 'connecting',
});

const failed = sampleSummary({
  infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
  name: 'Big Buck Bunny',
  progress: 0,
  numPeers: 0,
  downloadSpeed: 0,
  uploadSpeed: 0,
  state: 'error',
  errorMessage: 'ENOSPC: no space left on device, write',
});

const seeding = sampleSummary({
  infoHash: '6a9759bffd5c0af65319979fb7832189f4f3c35d',
  name: 'Cosmos Laundromat',
  // A single-file torrent: everything is selected.
  length: 1_150_000_000,
  selectedLength: 1_150_000_000,
  progress: 1,
  downloadSpeed: 0,
  state: 'seeding',
});

// Every badge tone. A Record, so a new tone doesn't type-check until it is
// shown here too.
const BADGE_TORRENTS: Record<StateLabel['tone'], TorrentSummary> = {
  connecting: pendingMagnet,
  checking: sampleSummary({ state: 'connecting', ready: false }),
  downloading: sampleSummary(),
  seeding,
  noPeers: sampleSummary({ ...pendingMagnet, state: 'noPeers' }),
  error: failed,
};

// The server's answers for the torrent list, with no network.
const stubApi = {
  async getTorrent(infoHash: string) {
    if (infoHash === MAGNET_HASH) {
      return { ...pendingMagnet, files: null, mainFile: null, videos: null };
    }
    return sampleDetail({ infoHash });
  },
  async removeTorrent() {},
  async addMagnet(): Promise<TorrentSummary> {
    throw new ApiError(409, 'This torrent has already been added');
  },
  async addTorrentFile() {
    return sampleSummary();
  },
};

function row(
  torrent: TorrentSummary,
  setUp: (r: ReturnType<typeof torrentRow>) => void = () => {},
): HTMLElement {
  const r = torrentRow(torrent, {
    onToggle: () => {},
    onRemove: () => {},
    onRetry: () => {},
  });
  setUp(r);
  // Rows are list items; the list supplies their spacing.
  return el('ul', { className: 'torrent-list__items' }, r.element);
}

function expand(r: ReturnType<typeof torrentRow>, content: Node): void {
  r.setFiles(content);
  r.element.querySelector<HTMLButtonElement>('.torrent__toggle')?.click();
}

function filesNote(text: string): HTMLElement {
  return el('p', { className: 'torrent__files-note', text });
}

function list(torrents: TorrentSummary[], stale = false): HTMLElement {
  const l = torrentList({
    api: stubApi,
    confirm: (message) =>
      confirmDialog(document.body, { message, confirmLabel: 'Remove' }),
    onChanged: () => {},
  });
  l.update(torrents);
  l.setStale(stale);
  return l.element;
}

function textInput(placeholder = ''): HTMLInputElement {
  return el('input', { attrs: { type: 'text', placeholder } });
}

export const entries: GalleryEntry[] = [
  ...(['primary', 'secondary', 'danger'] as const).map((variant) => ({
    component: 'Button',
    state: variant,
    render: () => button({ label: 'Add magnet', variant }),
  })),
  {
    component: 'Button',
    state: 'disabled',
    render: () => {
      const b = button({ label: 'Add magnet', variant: 'primary' });
      b.disabled = true;
      return b;
    },
  },
  {
    component: 'Field',
    state: 'text',
    render: () =>
      field({ label: 'Magnet link', input: textInput('magnet:?xt=urn:btih:…') })
        .element,
  },
  {
    component: 'Field',
    state: 'file with help',
    render: () =>
      field({
        label: '.torrent file',
        input: el('input', { attrs: { type: 'file' } }),
        help: 'Up to 10 MB.',
      }).element,
  },
  {
    component: 'Field',
    state: 'error',
    render: () => {
      const f = field({ label: 'Magnet link', input: textInput() });
      f.setError('Paste a magnet link first');
      return f.element;
    },
  },
  ...Object.entries(BADGE_TORRENTS).map(([tone, torrent]) => ({
    component: 'State badge',
    state: tone,
    render: () => {
      const badge = stateBadge();
      updateStateBadge(badge, stateLabel(torrent));
      return badge;
    },
  })),
  ...[0, 0.42, 1].map((fraction) => ({
    component: 'Progress bar',
    state: `${fraction * 100}%`,
    render: () => {
      const bar = progressBar('Download progress');
      updateProgressBar(bar, fraction);
      return bar;
    },
  })),
  {
    component: 'File list',
    state: 'main file, subtitle, may not play, sample, downloading',
    render: () => fileList(sampleDetail()),
  },
  {
    component: 'File list',
    state: 'selection downloaded',
    render: () => fileList(sampleDetail({ state: 'seeding', progress: 1 })),
  },
  {
    component: 'File list',
    state: 'every file downloading (no tags)',
    render: () => {
      const detail = sampleDetail();
      return fileList({
        ...detail,
        files: (detail.files ?? []).map((file) => ({
          ...file,
          selected: true,
        })),
      });
    },
  },
  {
    component: 'Torrent row',
    state: 'downloading',
    render: () => row(sampleSummary()),
  },
  {
    component: 'Torrent row',
    state: 'expanded with files',
    render: () =>
      row(sampleSummary(), (r) => expand(r, fileList(sampleDetail()))),
  },
  {
    component: 'Torrent row',
    state: 'magnet without metadata, expanded',
    render: () =>
      row(pendingMagnet, (r) =>
        expand(
          r,
          filesNote('File list not known yet: it is still coming from peers.'),
        ),
      ),
  },
  {
    component: 'Torrent row',
    state: 'seeding',
    render: () => row(seeding),
  },
  {
    component: 'Torrent row',
    state: 'failed, with Retry',
    render: () => row(failed),
  },
  {
    component: 'Torrent row',
    state: 'action error',
    render: () =>
      row(sampleSummary(), (r) =>
        r.setActionError(
          "Couldn't remove it: The server answered 500 Internal Server Error",
        ),
      ),
  },
  ...(['reconnecting', 'unavailable'] as const).map((status) => ({
    component: 'Status banner',
    state: status,
    render: () => {
      const banner = statusBanner();
      banner.show(STATUS_MESSAGES[status]);
      return banner.element;
    },
  })),
  {
    component: 'Confirm dialog',
    state: 'remove',
    render: () =>
      button({
        label: 'Open the dialog',
        onClick: () =>
          void confirmDialog(document.body, {
            message: `Remove ${sampleSummary().name}? Its downloaded files will be deleted.`,
            confirmLabel: 'Remove',
          }),
      }),
  },
  {
    component: 'Add form',
    state: 'empty (Add magnet answers 409)',
    render: () => torrentForm({ api: stubApi, onAdded: () => {} }),
  },
  {
    component: 'Torrent list',
    state: 'empty',
    render: () => list([]),
  },
  {
    component: 'Torrent list',
    state: 'several torrents',
    render: () => list([sampleSummary(), pendingMagnet, seeding, failed]),
  },
  {
    component: 'Torrent list',
    state: 'stale (live updates down)',
    render: () => list([sampleSummary(), seeding], true),
  },
];
