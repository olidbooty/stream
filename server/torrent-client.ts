import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance as ParsedTorrent } from 'parse-torrent';
import wrtc from 'webrtc-polyfill';
import WebTorrent, { type Torrent } from 'webtorrent';

export const DEFAULT_DOWNLOAD_DIR = fileURLToPath(new URL('../downloads', import.meta.url));

export interface TorrentConfig {
  downloadDir: string;
  // 0 lets the OS pick a free port; 2.6 settles on fixed defaults for port forwarding.
  torrentPort: number;
  dhtPort: number;
}

export type TorrentEnv = Partial<Record<'DOWNLOAD_DIR' | 'TORRENT_PORT' | 'DHT_PORT', string>>;

function parsePort(name: string, value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be a port number between 0 and 65535, got "${value}"`);
  }
  return port;
}

export function torrentConfig(env: TorrentEnv = process.env): TorrentConfig {
  return {
    downloadDir: env.DOWNLOAD_DIR ? resolve(env.DOWNLOAD_DIR) : DEFAULT_DOWNLOAD_DIR,
    torrentPort: parsePort('TORRENT_PORT', env.TORRENT_PORT),
    dhtPort: parsePort('DHT_PORT', env.DHT_PORT),
  };
}

// Fail at startup with a clear message rather than when the first torrent writes.
export async function ensureDownloadDir(downloadDir: string): Promise<void> {
  try {
    await mkdir(downloadDir, { recursive: true });
    await access(downloadDir, constants.W_OK);
  } catch (err) {
    throw new Error(`DOWNLOAD_DIR ${downloadDir} is not a writable directory`, { cause: err });
  }
}

// DHT, TCP and uTP are on by default. webtorrent@3 already loads webrtc-polyfill
// through simple-peer; passing it explicitly keeps WebRTC from depending on that.
export function createTorrentClient({
  torrentPort,
  dhtPort,
}: Pick<TorrentConfig, 'torrentPort' | 'dhtPort'>): WebTorrent {
  return new WebTorrent({ torrentPort, dhtPort, tracker: { wrtc } });
}

// Decision #4: files go in DOWNLOAD_DIR and are deleted when the torrent is removed.
// Pass a parsed torrent where possible: given a string it can't parse, WebTorrent
// tries it as a URL or file path.
export function addTorrent(
  client: WebTorrent,
  torrentId: string | Uint8Array | ParsedTorrent,
  downloadDir: string,
): Torrent {
  const torrent = client.add(torrentId, { path: downloadDir, destroyStoreOnDestroy: true });
  // A torrent error with no listener is re-emitted on the client, which the
  // server treats as fatal. One bad torrent must not stop the others.
  torrent.on('error', (err) => {
    console.error(`torrent ${torrent.infoHash || String(torrentId)} failed:`, err);
  });
  return torrent;
}

// client.remove() rejects for an unknown torrent but reports the destroy through
// its callback, so wait for both.
export function removeTorrent(client: WebTorrent, torrentId: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    client
      .remove(torrentId, { destroyStore: true }, (err) => (err ? reject(err) : resolvePromise()))
      .catch(reject);
  });
}

// Stops announcing to trackers and the DHT and closes the peer sockets.
export function destroyTorrentClient(client: WebTorrent): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    client.destroy((err) => (err ? reject(err) : resolvePromise()));
  });
}
