import type { LeftoversInfo } from '../../../server/leftovers.js';
import type { SettingsInfo } from '../../../server/settings-api.js';
import type { TorrentSummary } from '../../../server/torrents-api.js';
import { ApiError } from '../api.js';
import { isDownloadSlow, slowDownloadMessage } from '../buffer-health.js';
import { playerStats, type StateLabel, stateLabel } from '../format.js';
import { STATUS_MESSAGES } from '../live-updates.js';
import {
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  mediaErrorProblem,
  type PlaybackProblem,
  pictureMissingProblem,
} from '../media-error.js';
import { sampleDetail, sampleSummary } from '../sample-data.js';
import { settingsPanel } from '../settings-panel.js';
import { torrentForm } from '../torrent-form.js';
import { torrentList } from '../torrent-list.js';
import { tvPlaylist } from '../tv-playlist.js';
import { button } from '../ui/button.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { el } from '../ui/dom.js';
import { field } from '../ui/field.js';
import { fileList } from '../ui/file-list.js';
import { progressBar, updateProgressBar } from '../ui/progress-bar.js';
import { stateBadge, updateStateBadge } from '../ui/state-badge.js';
import { statusBanner } from '../ui/status-banner.js';
import { torrentRow } from '../ui/torrent-row.js';
import {
  type PlayerStatusAction,
  type PlayerStatusTone,
  videoPlayer,
} from '../ui/video-player.js';

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
  mainFile: null,
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

const paused = sampleSummary({
  state: 'paused',
  numPeers: 0,
  downloadSpeed: 0,
  uploadSpeed: 0,
});

// Every badge tone. A Record, so a new tone doesn't type-check until it is
// shown here too.
const BADGE_TORRENTS: Record<StateLabel['tone'], TorrentSummary> = {
  connecting: pendingMagnet,
  checking: sampleSummary({ state: 'connecting', ready: false }),
  downloading: sampleSummary(),
  seeding,
  noPeers: sampleSummary({ ...pendingMagnet, state: 'noPeers' }),
  paused,
  diskFull: sampleSummary({
    state: 'diskFull',
    numPeers: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
  }),
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
  async pauseTorrent() {},
  async resumeTorrent() {},
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
    onTogglePause: () => {},
  });
  setUp(r);
  // Rows are list items; the list supplies their spacing.
  return el('ul', { className: 'torrent-list__items' }, r.element);
}

function expand(r: ReturnType<typeof torrentRow>, content: Node): void {
  r.setFiles(content);
  r.element.querySelector<HTMLButtonElement>('.torrent__toggle')?.click();
}

// An empty WebVTT file, so the gallery's tracks load without a server.
const EMPTY_VTT = 'data:text/vtt,WEBVTT';

// The player with no video source: the gallery has no server to stream from.
function player(
  status: string | null,
  tone: PlayerStatusTone = 'info',
  tracks = [{ src: EMPTY_VTT, language: 'de', label: 'German' }],
  action?: PlayerStatusAction,
  title = 'Sintel.mp4',
): HTMLElement {
  const p = videoPlayer({ title, tracks, backHref: '#' });
  p.setStatus(status, tone, action);
  p.setStats(playerStats(sampleSummary()));
  return p.element;
}

// The player during playback with the buffer health of step 3.5: seconds
// buffered in the stats line and, for a slow download, the warning.
function bufferPlayer(ahead: number, downloadSpeed: number): HTMLElement {
  const p = videoPlayer({ title: 'Sintel.mp4', tracks: [], backHref: '#' });
  const torrent = sampleSummary({ downloadSpeed });
  // Sintel.mp4: 129 MB over 888 s.
  const state = {
    ahead,
    currentTime: 120,
    duration: 888,
    fileLength: 129_241_752,
    downloadSpeed,
    downloaded: false,
  };
  p.setStats(playerStats(torrent, ahead));
  p.setHealth(isDownloadSlow(state, false) ? slowDownloadMessage(state) : null);
  return p.element;
}

// The player showing what step 4.2a says about a file it can't play.
function problemPlayer(problem: PlaybackProblem | null, title: string) {
  if (!problem) throw new Error('no message for this error');
  return player(
    problem.message,
    problem.tone,
    [],
    problem.retry ? { label: 'Retry', onClick: () => {} } : undefined,
    title,
  );
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

function tv(
  playlistUrls: string[],
  dlnaName: string | null = null,
  dlnaOn = dlnaName !== null,
): HTMLElement {
  const t = tvPlaylist({
    api: {
      getTv: async () => ({ playlistUrls, dlnaName, dlnaOn }),
      saveSettings: async (changes) => ({
        diskLimitOn: false,
        diskLimit: null,
        dlnaOn,
        diskUsed: 0,
        diskLimitReached: false,
        ...changes,
      }),
    },
    clipboard: { writeText: async () => {} },
  });
  t.update(playlistUrls, dlnaName, dlnaOn);
  return t.element;
}

const GB = 1_000_000_000;

function settings(
  info: SettingsInfo,
  leftovers: LeftoversInfo = { pending: false, leftovers: [] },
): HTMLElement {
  const panel = settingsPanel({
    api: {
      getSettings: async () => info,
      saveSettings: async () => info,
      getLeftovers: async () => leftovers,
      deleteLeftover: async () => {},
    },
    confirm: (message) =>
      confirmDialog(document.body, { message, confirmLabel: 'Delete' }),
  });
  panel.update(info);
  panel.updateLeftovers(leftovers);
  return panel.element;
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
    state: 'paused, with Resume',
    render: () => row(paused),
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
  {
    component: 'Video player',
    state: 'loading',
    render: () => player('Loading…'),
  },
  {
    component: 'Video player',
    state: 'buffering',
    render: () => player('Buffering…'),
  },
  {
    component: 'Video player',
    state: 'waiting for peers',
    render: () => player('Waiting for data from peers…'),
  },
  {
    component: 'Video player',
    state: 'playing, two subtitle tracks',
    render: () =>
      player(null, 'info', [
        { src: EMPTY_VTT, language: 'en', label: 'English' },
        { src: EMPTY_VTT, language: 'pt-br', label: 'Brazilian Portuguese' },
      ]),
  },
  {
    component: 'Video player',
    state: 'playing, buffer healthy',
    render: () => bufferPlayer(48, 1_250_000),
  },
  {
    component: 'Video player',
    state: 'download slower than the video',
    render: () => bufferPlayer(6, 60_000),
  },
  {
    component: 'Video player',
    state: 'no data arriving',
    render: () => bufferPlayer(3, 0),
  },
  {
    component: 'Video player',
    state: 'format not supported',
    render: () =>
      problemPlayer(
        mediaErrorProblem(MEDIA_ERR_SRC_NOT_SUPPORTED, 'Sintel.mkv'),
        'Sintel.mkv',
      ),
  },
  {
    component: 'Video player',
    state: 'decode error',
    render: () =>
      problemPlayer(
        mediaErrorProblem(MEDIA_ERR_DECODE, 'Sintel.mp4'),
        'Sintel.mp4',
      ),
  },
  {
    component: 'Video player',
    state: 'stream cut off, with Retry',
    render: () =>
      problemPlayer(
        mediaErrorProblem(MEDIA_ERR_NETWORK, 'Sintel.mp4'),
        'Sintel.mp4',
      ),
  },
  {
    component: 'Video player',
    state: 'sound only',
    render: () =>
      problemPlayer(pictureMissingProblem('Sintel.mkv'), 'Sintel.mkv'),
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
  {
    component: 'Watch on TV',
    state: 'DLNA on',
    render: () => tv(['http://192.168.1.20:1234/tv.m3u'], 'stream on studio'),
  },
  {
    component: 'Watch on TV',
    state: 'DLNA turned off',
    render: () =>
      tv(['http://192.168.1.20:1234/tv.m3u'], 'stream on studio', false),
  },
  {
    component: 'Watch on TV',
    state: 'one address, no DLNA (HOST is local)',
    render: () => tv(['http://192.168.1.20:1234/tv.m3u']),
  },
  {
    component: 'Watch on TV',
    state: 'two addresses',
    render: () =>
      tv(['http://192.168.1.20:1234/tv.m3u', 'http://10.0.0.5:1234/tv.m3u']),
  },
  {
    component: 'Watch on TV',
    state: 'no network',
    render: () => tv([]),
  },
  {
    component: 'Settings',
    state: 'limit off',
    render: () =>
      settings({
        diskLimitOn: false,
        diskLimit: 50 * GB,
        dlnaOn: true,
        diskUsed: 12.4 * GB,
        diskLimitReached: false,
      }),
  },
  {
    component: 'Settings',
    state: 'under the limit',
    render: () =>
      settings({
        diskLimitOn: true,
        diskLimit: 50 * GB,
        dlnaOn: true,
        diskUsed: 12.4 * GB,
        diskLimitReached: false,
      }),
  },
  {
    component: 'Settings',
    state: 'limit reached',
    render: () =>
      settings({
        diskLimitOn: true,
        diskLimit: 50 * GB,
        dlnaOn: true,
        diskUsed: 50.2 * GB,
        diskLimitReached: true,
      }),
  },
  {
    component: 'Settings',
    state: 'leftover files',
    render: () =>
      settings(
        {
          diskLimitOn: true,
          diskLimit: 50 * GB,
          dlnaOn: true,
          diskUsed: 12.4 * GB,
          diskLimitReached: false,
        },
        {
          pending: false,
          leftovers: [
            { name: 'Old Film (2019)', folder: true, bytes: 4.2 * GB },
            { name: 'sample.mkv', folder: false, bytes: 38_000_000 },
          ],
        },
      ),
  },
  {
    component: 'Settings',
    state: 'invalid limit',
    render: () => {
      const element = settings({
        diskLimitOn: true,
        diskLimit: 50 * GB,
        dlnaOn: true,
        diskUsed: 12.4 * GB,
        diskLimitReached: false,
      });
      const input = element.querySelector<HTMLInputElement>(
        'input[name="diskLimit"]',
      );
      const form = element.querySelector('form');
      if (input && form) {
        input.value = 'lots';
        form.requestSubmit();
      }
      return element;
    },
  },
];
