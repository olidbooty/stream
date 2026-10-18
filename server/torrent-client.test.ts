import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { type FakeTorrent, FakeWebTorrent } from '../test/mocks/webtorrent.js';
import {
  addTorrent,
  createTorrentClient,
  DEFAULT_DOWNLOAD_DIR,
  destroyTorrentClient,
  ensureDownloadDir,
  removeTorrent,
  torrentConfig,
} from './torrent-client.js';

vi.mock('webtorrent', () => import('../test/mocks/webtorrent.js'));

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

afterEach(() => FakeWebTorrent.reset());

describe('torrentConfig', () => {
  it('defaults to ./downloads and OS-assigned ports', () => {
    expect(torrentConfig({})).toEqual({
      downloadDir: DEFAULT_DOWNLOAD_DIR,
      torrentPort: 0,
      dhtPort: 0,
    });
    expect(DEFAULT_DOWNLOAD_DIR).toBe(
      resolve(import.meta.dirname, '../downloads'),
    );
  });

  it('reads DOWNLOAD_DIR, TORRENT_PORT and DHT_PORT', () => {
    expect(
      torrentConfig({
        DOWNLOAD_DIR: 'media',
        TORRENT_PORT: '51413',
        DHT_PORT: '51414',
      }),
    ).toEqual({
      downloadDir: resolve('media'),
      torrentPort: 51413,
      dhtPort: 51414,
    });
  });

  it.each(['abc', '-1', '65536', '1.5'])('rejects the port %s', (port) => {
    expect(() => torrentConfig({ TORRENT_PORT: port })).toThrow(
      'TORRENT_PORT must be a port',
    );
    expect(() => torrentConfig({ DHT_PORT: port })).toThrow(
      'DHT_PORT must be a port',
    );
  });
});

describe('ensureDownloadDir', () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'stream-downloads-'));
  });

  afterEach(() => {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  });

  it('creates a missing directory', async () => {
    const dir = join(parent, 'nested', 'downloads');

    await ensureDownloadDir(dir);

    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('rejects a path that is a file', async () => {
    const file = join(parent, 'not-a-dir');
    writeFileSync(file, '');

    await expect(ensureDownloadDir(file)).rejects.toThrow(
      `DOWNLOAD_DIR ${file} is not a writable directory`,
    );
  });

  // root can write anywhere, so this only means something as a normal user.
  it.skipIf(process.getuid?.() === 0)(
    'rejects a directory it cannot write to',
    async () => {
      chmodSync(parent, 0o500);

      await expect(ensureDownloadDir(parent)).rejects.toThrow(
        'is not a writable directory',
      );
    },
  );
});

describe('createTorrentClient', () => {
  it('passes the ports and a WebRTC implementation to WebTorrent', () => {
    createTorrentClient({ torrentPort: 51413, dhtPort: 51414 });

    const [client] = FakeWebTorrent.instances;
    expect(client.opts).toMatchObject({ torrentPort: 51413, dhtPort: 51414 });
    expect(client.opts.tracker).toHaveProperty('wrtc.RTCPeerConnection');
  });
});

describe('addTorrent and removeTorrent', () => {
  it('stores files in the download directory and deletes them on removal', async () => {
    const fake = new FakeWebTorrent();
    const client = fake as unknown as WebTorrent;

    const torrent = addTorrent(
      client,
      MAGNET,
      '/srv/downloads',
    ) as unknown as FakeTorrent;
    expect(torrent.path).toBe('/srv/downloads');
    expect(torrent.listenerCount('error')).toBe(1);

    await removeTorrent(client, MAGNET);

    expect(torrent.destroyed).toBe(true);
    expect(torrent.storeDestroyed).toBe(true);
    expect(fake.torrents).toEqual([]);
  });

  it('keeps a torrent error off the client', () => {
    const fake = new FakeWebTorrent();
    const onClientError = vi.fn();
    fake.on('error', onClientError);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const torrent = addTorrent(
      fake as unknown as WebTorrent,
      MAGNET,
      '/srv/downloads',
    ) as unknown as FakeTorrent;

    torrent.simulateError(new Error('disk full'));

    expect(onClientError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      new Error('disk full'),
    );
    consoleError.mockRestore();
  });

  it('rejects removing a torrent the client does not have', async () => {
    const client = new FakeWebTorrent() as unknown as WebTorrent;

    await expect(removeTorrent(client, MAGNET)).rejects.toThrow(
      'No torrent with id',
    );
  });
});

describe('destroyTorrentClient', () => {
  it('destroys the client and its torrents', async () => {
    const fake = new FakeWebTorrent();
    const torrent = fake.add(MAGNET);
    fake.simulateListening();

    await destroyTorrentClient(fake as unknown as WebTorrent);

    expect(fake.destroyed).toBe(true);
    expect(fake.listening).toBe(false);
    expect(torrent.destroyed).toBe(true);
  });
});
