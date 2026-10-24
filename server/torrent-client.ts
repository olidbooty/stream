import { setDefaultResultOrder } from 'node:dns';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance as ParsedTorrent } from 'parse-torrent';
import wrtc from 'webrtc-polyfill';
import WebTorrent, { type Torrent } from 'webtorrent';
import { repairPeerAddress } from './peer-address.js';

export const DEFAULT_DOWNLOAD_DIR = fileURLToPath(
  new URL('../downloads', import.meta.url),
);

// Fixed, so the router can forward them. TCP and uTP (UDP) share the torrent
// port; the DHT needs a UDP port of its own.
export const DEFAULT_TORRENT_PORT = 6881;
export const DEFAULT_DHT_PORT = 6882;

export interface TorrentConfig {
  downloadDir: string;
  // 0 lets the OS pick a free port.
  torrentPort: number;
  dhtPort: number;
  // Decision #7: ask the router to forward the peer port (UPnP and NAT-PMP).
  portMapping: boolean;
}

export type TorrentEnv = Partial<
  Record<'DOWNLOAD_DIR' | 'TORRENT_PORT' | 'DHT_PORT' | 'PORT_MAPPING', string>
>;

function parsePort(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `${name} must be a port number between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

export function torrentConfig(env: TorrentEnv = process.env): TorrentConfig {
  return {
    downloadDir: env.DOWNLOAD_DIR
      ? resolve(env.DOWNLOAD_DIR)
      : DEFAULT_DOWNLOAD_DIR,
    torrentPort: parsePort(
      'TORRENT_PORT',
      env.TORRENT_PORT,
      DEFAULT_TORRENT_PORT,
    ),
    dhtPort: parsePort('DHT_PORT', env.DHT_PORT, DEFAULT_DHT_PORT),
    portMapping: parseSwitch('PORT_MAPPING', env.PORT_MAPPING),
  };
}

function parseSwitch(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${name} must be 1 or 0, got "${value}"`);
}

// Fail at startup with a clear message rather than when the first torrent writes.
export async function ensureDownloadDir(downloadDir: string): Promise<void> {
  try {
    await mkdir(downloadDir, { recursive: true });
    await access(downloadDir, constants.W_OK);
  } catch (err) {
    throw new Error(`DOWNLOAD_DIR ${downloadDir} is not a writable directory`, {
      cause: err,
    });
  }
}

// Where the DHT finds its first nodes. WebTorrent's default list lacks
// dht.libtorrent.org, and its other routers often don't answer
// (Decision #28).
export const DHT_BOOTSTRAP = [
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'dht.libtorrent.org:25401',
];

export interface PeerOptions
  extends Pick<TorrentConfig, 'torrentPort' | 'dhtPort' | 'portMapping'> {
  // False when node-datachannel can't load (server/peer-support.ts).
  webrtc: boolean;
}

// DHT, LSD, TCP and uTP are on by default. webtorrent@3 already loads
// webrtc-polyfill through simple-peer; passing it explicitly keeps WebRTC from
// depending on that. wrtc: false skips WebSocket trackers, which only find
// WebRTC peers. UPnP and NAT-PMP are on by default in WebTorrent, so they are
// switched off unless asked for (Decision #7).
export function createTorrentClient({
  torrentPort,
  dhtPort,
  portMapping,
  webrtc,
}: PeerOptions): WebTorrent {
  // The DHT looks up its bootstrap hosts with dns.lookup() and sends over an
  // IPv4 socket. Node returns the resolver's first address, often IPv6, and
  // the send fails silently, so the DHT starts with no nodes (Decision #28).
  setDefaultResultOrder('ipv4first');
  return new WebTorrent({
    torrentPort,
    dhtPort,
    natUpnp: portMapping,
    natPmp: portMapping,
    dht: { bootstrap: DHT_BOOTSTRAP },
    tracker: { wrtc: webrtc ? wrtc : false },
  });
}

// What the client can use, for the startup log. WebTorrent falls back to TCP
// by itself when utp-native is missing.
export function peerTransports(webrtc: boolean): string[] {
  return [
    'TCP',
    ...(WebTorrent.UTP_SUPPORT ? ['uTP'] : []),
    'DHT',
    'LSD',
    'trackers',
    ...(webrtc ? ['WebRTC'] : []),
  ];
}

// Decision #4: files go in DOWNLOAD_DIR and are deleted when the torrent is removed.
// Decision #18: nothing is selected, so nothing downloads until the caller
// selects files (TorrentSelection). Pass a parsed torrent where possible:
// given a string it can't parse, WebTorrent tries it as a URL or file path.
export function addTorrent(
  client: WebTorrent,
  torrentId: string | Uint8Array | ParsedTorrent,
  downloadDir: string,
): Torrent {
  const torrent = client.add(torrentId, {
    path: downloadDir,
    destroyStoreOnDestroy: true,
    deselect: true,
  });
  // Trackers, the DHT and PEX all hand peers to torrent.addPeer(); repair the
  // addresses bittorrent-tracker garbles before WebTorrent tries them.
  const addPeer = torrent.addPeer.bind(torrent);
  torrent.addPeer = (peer, source) =>
    addPeer(typeof peer === 'string' ? repairPeerAddress(peer) : peer, source);
  // A torrent error with no listener is re-emitted on the client, which the
  // server treats as fatal. One bad torrent must not stop the others.
  torrent.on('error', (err) => {
    console.error(
      `torrent ${torrent.infoHash || String(torrentId)} failed:`,
      err,
    );
  });
  return torrent;
}

// client.remove() rejects for an unknown torrent but reports the destroy through
// its callback, so wait for both.
export function removeTorrent(
  client: WebTorrent,
  torrentId: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    client
      .remove(torrentId, { destroyStore: true }, (err) =>
        err ? reject(err) : resolvePromise(),
      )
      .catch(reject);
  });
}

// Stops announcing to trackers and the DHT and closes the peer sockets.
export function destroyTorrentClient(client: WebTorrent): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    client.destroy((err) => (err ? reject(err) : resolvePromise()));
  });
}
