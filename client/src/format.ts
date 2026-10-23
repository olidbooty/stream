import type { TorrentSummary } from '../../server/torrents-api.js';

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

// Decimal units, as browsers and most file managers show sizes.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${value} B`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

// Rounded down, so a torrent only shows 100% once it is really complete.
export function formatPercent(fraction: number): string {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return `${Math.floor(clamped * 1000) / 10}%`;
}

// What a state badge shows. `tone` picks the colour: the torrent's state, or
// `checking` for a torrent verifying data already on disk, which the server
// reports as connecting (Decision #24).
export interface StateLabel {
  tone: TorrentSummary['state'] | 'checking';
  label: string;
}

export function stateLabel(
  torrent: Pick<TorrentSummary, 'state' | 'hasMetadata' | 'ready'>,
): StateLabel {
  switch (torrent.state) {
    case 'connecting':
      if (torrent.hasMetadata && !torrent.ready) {
        return { tone: 'checking', label: 'Checking files' };
      }
      return { tone: 'connecting', label: 'Connecting' };
    case 'downloading':
      return { tone: 'downloading', label: 'Downloading' };
    case 'seeding':
      return { tone: 'seeding', label: 'Seeding' };
    case 'noPeers':
      // Decision #15: it keeps looking until the user removes it.
      return { tone: 'noPeers', label: 'No peers yet, still searching' };
    case 'error':
      return { tone: 'error', label: 'Failed' };
  }
}
