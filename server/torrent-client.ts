import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// DHT, TCP and uTP are on by default. webtorrent@3 already loads webrtc-polyfill
// through simple-peer; passing it explicitly keeps WebRTC from depending on that.
export function createTorrentClient({
  torrentPort,
  dhtPort,
}: Pick<TorrentConfig, 'torrentPort' | 'dhtPort'>): WebTorrent {
  return new WebTorrent({ torrentPort, dhtPort, tracker: { wrtc } });
}

// Decision #4: files go in DOWNLOAD_DIR and are deleted when the torrent is removed.
export function addTorrent(
  client: WebTorrent,
  torrentId: string | Buffer,
  downloadDir: string,
): Torrent {
  return client.add(torrentId, { path: downloadDir, destroyStoreOnDestroy: true });
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
