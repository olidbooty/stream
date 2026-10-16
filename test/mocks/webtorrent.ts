import { EventEmitter } from 'node:events';

// Test double for the WebTorrent client. Unit tests never join a real swarm:
// it would open ports and depend on the network. These fakes expose the subset
// of the WebTorrent 3 API the app uses; the `simulate*` methods are test-only
// and drive the events a real swarm would emit.

const DEFAULT_INFO_HASH = '0123456789abcdef0123456789abcdef01234567';

// Like the real client, take the info hash from a parsed torrent or a hex
// magnet link. Anything else (a .torrent buffer) gets the default.
function infoHashOf(torrentId: unknown): string | undefined {
  if (typeof torrentId === 'object' && torrentId !== null && 'infoHash' in torrentId) {
    return String(torrentId.infoHash).toLowerCase();
  }
  if (typeof torrentId === 'string') {
    return /xt=urn:btih:([0-9a-f]{40})/i.exec(torrentId)?.[1].toLowerCase();
  }
  return undefined;
}

type Callback = (err: Error | null) => void;
type TorrentCallback = (torrent: FakeTorrent) => void;

export interface FakeFileOptions {
  name: string;
  length?: number;
  path?: string;
}

export interface FakeTorrentOptions {
  infoHash?: string;
  // The real add() options the server passes (Decision #4).
  path?: string;
  destroyStoreOnDestroy?: boolean;
}

export interface FakeDestroyOptions {
  destroyStore?: boolean;
}

export class FakeFile {
  name: string;
  path: string;
  length: number;
  downloaded = 0;
  progress = 0;
  selected = true;
  streamedTo: HTMLMediaElement | null = null;

  constructor({ name, length = 0, path = name }: FakeFileOptions) {
    this.name = name;
    this.path = path;
    this.length = length;
  }

  select() {
    this.selected = true;
  }

  deselect() {
    this.selected = false;
  }

  streamTo<T extends HTMLMediaElement>(element: T): T {
    this.streamedTo = element;
    return element;
  }
}

export class FakeTorrent extends EventEmitter {
  torrentId: unknown;
  infoHash: string;
  path: string | undefined;
  destroyStoreOnDestroy: boolean;
  magnetURI: string;
  name: string | undefined = undefined;
  files: FakeFile[] = [];
  length = 0;
  downloaded = 0;
  uploaded = 0;
  downloadSpeed = 0;
  uploadSpeed = 0;
  numPeers = 0;
  progress = 0;
  ready = false;
  done = false;
  destroyed = false;
  // Whether destroy() would have deleted the downloaded files.
  storeDestroyed = false;

  constructor(
    torrentId: unknown,
    {
      infoHash = infoHashOf(torrentId) ?? DEFAULT_INFO_HASH,
      path,
      destroyStoreOnDestroy = false,
    }: FakeTorrentOptions = {},
  ) {
    super();
    this.torrentId = torrentId;
    this.infoHash = infoHash;
    this.path = path;
    this.destroyStoreOnDestroy = destroyStoreOnDestroy;
    this.magnetURI = typeof torrentId === 'string' ? torrentId : `magnet:?xt=urn:btih:${infoHash}`;
  }

  // Metadata arrives: files become known and the torrent is ready to stream.
  simulateMetadata({
    name = 'fixture',
    files = [],
  }: { name?: string; files?: (FakeFile | FakeFileOptions)[] } = {}): void {
    this.name = name;
    this.files = files.map((file) => (file instanceof FakeFile ? file : new FakeFile(file)));
    this.length = this.files.reduce((total, file) => total + file.length, 0);
    this.ready = true;
    this.emit('metadata');
    this.emit('ready');
  }

  simulateDownload(
    bytes: number,
    { downloadSpeed = bytes, numPeers = this.numPeers }: { downloadSpeed?: number; numPeers?: number } = {},
  ): void {
    this.downloaded = Math.min(this.length, this.downloaded + bytes);
    this.downloadSpeed = downloadSpeed;
    this.numPeers = numPeers;
    this.progress = this.length ? this.downloaded / this.length : 0;
    this.emit('download', bytes);
  }

  simulateDone(): void {
    this.downloaded = this.length;
    this.progress = 1;
    this.done = true;
    this.emit('done');
  }

  simulateNoPeers(announceType: 'tracker' | 'dht' | 'lsd' = 'tracker'): void {
    this.emit('noPeers', announceType);
  }

  simulateError(error: Error = new Error('fake torrent error')): void {
    this.emit('error', error);
  }

  destroy(opts?: FakeDestroyOptions | Callback, callback?: Callback): void {
    const cb = typeof opts === 'function' ? opts : callback;
    const options = typeof opts === 'function' ? {} : (opts ?? {});
    this.destroyed = true;
    this.storeDestroyed = options.destroyStore ?? this.destroyStoreOnDestroy;
    this.emit('close');
    cb?.(null);
  }
}

export class FakeWebTorrent extends EventEmitter {
  static instances: FakeWebTorrent[] = [];

  opts: Record<string, unknown>;
  torrents: FakeTorrent[] = [];
  destroyed = false;
  listening = false;
  torrentPort: number;
  dhtPort: number;

  constructor(opts: Record<string, unknown> = {}) {
    super();
    this.opts = opts;
    this.torrentPort = Number(opts.torrentPort) || 0;
    this.dhtPort = Number(opts.dhtPort) || 0;
    FakeWebTorrent.instances.push(this);
  }

  address(): { address: string; family: string; port: number } | null {
    return this.listening ? { address: '0.0.0.0', family: 'IPv4', port: this.torrentPort } : null;
  }

  // The real client emits 'listening' once its peer port is bound. Port 0 means
  // the OS picked one, so stand in a fixed port for it.
  simulateListening(port = this.torrentPort || 6881): void {
    this.torrentPort = port;
    this.listening = true;
    this.emit('listening');
  }

  get downloadSpeed(): number {
    return this.torrents.reduce((total, torrent) => total + torrent.downloadSpeed, 0);
  }

  get uploadSpeed(): number {
    return this.torrents.reduce((total, torrent) => total + torrent.uploadSpeed, 0);
  }

  get progress(): number {
    const length = this.torrents.reduce((total, torrent) => total + torrent.length, 0);
    const downloaded = this.torrents.reduce((total, torrent) => total + torrent.downloaded, 0);
    return length ? downloaded / length : 0;
  }

  add(
    torrentId: unknown,
    opts?: FakeTorrentOptions | TorrentCallback,
    ontorrent?: TorrentCallback,
  ): FakeTorrent {
    const options = typeof opts === 'function' ? {} : (opts ?? {});
    const callback = typeof opts === 'function' ? opts : ontorrent;
    const torrent = new FakeTorrent(torrentId, options);

    this.torrents.push(torrent);
    if (callback) torrent.once('ready', () => callback(torrent));
    this.emit('add', torrent);
    torrent.once('ready', () => this.emit('torrent', torrent));
    return torrent;
  }

  // Like the real client, get() and remove() are async.
  async get(torrentId: unknown): Promise<FakeTorrent | null> {
    return this.find(torrentId);
  }

  private find(torrentId: unknown): FakeTorrent | null {
    return this.torrents.find(
      (torrent) =>
        torrent === torrentId || torrent.infoHash === torrentId || torrent.magnetURI === torrentId,
    ) ?? null;
  }

  // Rejects for an unknown torrent; reports the destroy through the callback.
  async remove(
    torrentId: unknown,
    opts?: FakeDestroyOptions | Callback,
    callback?: Callback,
  ): Promise<void> {
    const cb = typeof opts === 'function' ? opts : callback;
    const options = typeof opts === 'function' ? {} : (opts ?? {});
    const torrent = this.find(torrentId);
    if (!torrent) throw new Error(`No torrent with id ${String(torrentId)}`);
    this.torrents = this.torrents.filter((t) => t !== torrent);
    torrent.destroy(options);
    this.emit('remove', torrent);
    cb?.(null);
  }

  destroy(callback?: Callback): void {
    for (const torrent of this.torrents) torrent.destroy();
    this.torrents = [];
    this.destroyed = true;
    this.listening = false;
    callback?.(null);
  }

  simulateError(error: Error = new Error('fake client error')): void {
    this.emit('error', error);
  }

  // Call in afterEach so instances don't leak between tests.
  static reset(): void {
    FakeWebTorrent.instances = [];
  }
}

export default FakeWebTorrent;
