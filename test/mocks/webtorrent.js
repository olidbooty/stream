import { EventEmitter } from 'node:events';

// Test double for the WebTorrent browser client. jsdom has no WebRTC, so unit
// tests cannot join a real swarm. These fakes expose the subset of the
// WebTorrent 3 API the app uses; the `simulate*` methods are test-only and
// drive the events a real swarm would emit.

const DEFAULT_INFO_HASH = '0123456789abcdef0123456789abcdef01234567';

export class FakeFile {
  constructor({ name, length = 0, path = name } = {}) {
    this.name = name;
    this.path = path;
    this.length = length;
    this.downloaded = 0;
    this.progress = 0;
    this.selected = true;
    this.streamedTo = null;
  }

  select() {
    this.selected = true;
  }

  deselect() {
    this.selected = false;
  }

  streamTo(element) {
    this.streamedTo = element;
    return element;
  }
}

export class FakeTorrent extends EventEmitter {
  constructor(torrentId, { infoHash = DEFAULT_INFO_HASH } = {}) {
    super();
    this.torrentId = torrentId;
    this.infoHash = infoHash;
    this.magnetURI = typeof torrentId === 'string' ? torrentId : `magnet:?xt=urn:btih:${infoHash}`;
    this.name = undefined;
    this.files = [];
    this.length = 0;
    this.downloaded = 0;
    this.uploaded = 0;
    this.downloadSpeed = 0;
    this.uploadSpeed = 0;
    this.numPeers = 0;
    this.progress = 0;
    this.ready = false;
    this.done = false;
    this.destroyed = false;
  }

  // Metadata arrives: files become known and the torrent is ready to stream.
  simulateMetadata({ name = 'fixture', files = [] } = {}) {
    this.name = name;
    this.files = files.map((file) => (file instanceof FakeFile ? file : new FakeFile(file)));
    this.length = this.files.reduce((total, file) => total + file.length, 0);
    this.ready = true;
    this.emit('metadata');
    this.emit('ready');
  }

  simulateDownload(bytes, { downloadSpeed = bytes, numPeers = this.numPeers } = {}) {
    this.downloaded = Math.min(this.length, this.downloaded + bytes);
    this.downloadSpeed = downloadSpeed;
    this.numPeers = numPeers;
    this.progress = this.length ? this.downloaded / this.length : 0;
    this.emit('download', bytes);
  }

  simulateDone() {
    this.downloaded = this.length;
    this.progress = 1;
    this.done = true;
    this.emit('done');
  }

  simulateNoPeers(announceType = 'tracker') {
    this.emit('noPeers', announceType);
  }

  simulateError(error = new Error('fake torrent error')) {
    this.emit('error', error);
  }

  destroy(opts, callback) {
    const cb = typeof opts === 'function' ? opts : callback;
    this.destroyed = true;
    this.emit('close');
    cb?.(null);
  }
}

export class FakeWebTorrent extends EventEmitter {
  static instances = [];

  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.torrents = [];
    this.destroyed = false;
    FakeWebTorrent.instances.push(this);
  }

  get downloadSpeed() {
    return this.torrents.reduce((total, torrent) => total + torrent.downloadSpeed, 0);
  }

  get uploadSpeed() {
    return this.torrents.reduce((total, torrent) => total + torrent.uploadSpeed, 0);
  }

  get progress() {
    const length = this.torrents.reduce((total, torrent) => total + torrent.length, 0);
    const downloaded = this.torrents.reduce((total, torrent) => total + torrent.downloaded, 0);
    return length ? downloaded / length : 0;
  }

  add(torrentId, opts, ontorrent) {
    const options = typeof opts === 'function' ? {} : (opts ?? {});
    const callback = typeof opts === 'function' ? opts : ontorrent;
    const torrent = new FakeTorrent(torrentId, options);

    this.torrents.push(torrent);
    if (callback) torrent.once('ready', () => callback(torrent));
    this.emit('add', torrent);
    torrent.once('ready', () => this.emit('torrent', torrent));
    return torrent;
  }

  get(torrentId) {
    return this.torrents.find(
      (torrent) =>
        torrent === torrentId || torrent.infoHash === torrentId || torrent.magnetURI === torrentId,
    ) ?? null;
  }

  remove(torrentId, opts, callback) {
    const cb = typeof opts === 'function' ? opts : callback;
    const torrent = this.get(torrentId);
    if (!torrent) {
      cb?.(new Error(`No torrent with id ${torrentId}`));
      return;
    }
    this.torrents = this.torrents.filter((t) => t !== torrent);
    torrent.destroy();
    this.emit('remove', torrent);
    cb?.(null);
  }

  destroy(callback) {
    for (const torrent of this.torrents) torrent.destroy();
    this.torrents = [];
    this.destroyed = true;
    callback?.(null);
  }

  simulateError(error = new Error('fake client error')) {
    this.emit('error', error);
  }

  // Call in afterEach so instances don't leak between tests.
  static reset() {
    FakeWebTorrent.instances = [];
  }
}

export default FakeWebTorrent;
