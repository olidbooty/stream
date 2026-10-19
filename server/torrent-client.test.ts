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
  peerTransports,
  removeTorrent,
  torrentConfig,
} from './torrent-client.js';

vi.mock('webtorrent', () => import('../test/mocks/webtorrent.js'));

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

afterEach(() => FakeWebTorrent.reset());

describe('torrentConfig', () => {
  it('defaults to ./downloads, fixed ports and no port mapping', () => {
    expect(torrentConfig({})).toEqual({
      downloadDir: DEFAULT_DOWNLOAD_DIR,
      torrentPort: 6881,
      dhtPort: 6882,
      portMapping: false,
    });
    expect(DEFAULT_DOWNLOAD_DIR).toBe(
      resolve(import.meta.dirname, '../downloads'),
    );
  });

  it('reads DOWNLOAD_DIR, TORRENT_PORT, DHT_PORT and PORT_MAPPING', () => {
    expect(
      torrentConfig({
        DOWNLOAD_DIR: 'media',
        TORRENT_PORT: '51413',
        DHT_PORT: '51414',
        PORT_MAPPING: '1',
      }),
    ).toEqual({
      downloadDir: resolve('media'),
      torrentPort: 51413,
      dhtPort: 51414,
      portMapping: true,
    });
  });

  it('takes port 0 as "pick a random port"', () => {
    expect(torrentConfig({ TORRENT_PORT: '0', DHT_PORT: '0' })).toMatchObject({
      torrentPort: 0,
      dhtPort: 0,
    });
  });

  it.each([
    ['', false],
    ['0', false],
    ['1', true],
  ])('reads PORT_MAPPING=%j as %s', (value, expected) => {
    expect(torrentConfig({ PORT_MAPPING: value }).portMapping).toBe(expected);
  });

  it.each(['yes', 'true', '2'])('rejects PORT_MAPPING=%s', (value) => {
    expect(() => torrentConfig({ PORT_MAPPING: value })).toThrow(
      'PORT_MAPPING must be 1 or 0',
    );
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
  const options = {
    torrentPort: 51413,
    dhtPort: 51414,
    portMapping: false,
    webrtc: true,
  };

  it('passes the ports and a WebRTC implementation to WebTorrent', () => {
    createTorrentClient(options);

    const [client] = FakeWebTorrent.instances;
    expect(client.opts).toMatchObject({ torrentPort: 51413, dhtPort: 51414 });
    expect(client.opts.tracker).toHaveProperty('wrtc.RTCPeerConnection');
  });

  it('turns off UPnP and NAT-PMP unless port mapping is on', () => {
    createTorrentClient(options);
    createTorrentClient({ ...options, portMapping: true });

    const [off, on] = FakeWebTorrent.instances;
    expect(off.opts).toMatchObject({ natUpnp: false, natPmp: false });
    expect(on.opts).toMatchObject({ natUpnp: true, natPmp: true });
  });

  it('skips WebSocket trackers without WebRTC', () => {
    createTorrentClient({ ...options, webrtc: false });

    expect(FakeWebTorrent.instances[0].opts.tracker).toEqual({ wrtc: false });
  });
});

describe('peerTransports', () => {
  afterEach(() => {
    FakeWebTorrent.UTP_SUPPORT = true;
  });

  it('lists what the client can use', () => {
    expect(peerTransports(true)).toEqual([
      'TCP',
      'uTP',
      'DHT',
      'LSD',
      'trackers',
      'WebRTC',
    ]);
  });

  it('leaves out uTP and WebRTC when their native modules are missing', () => {
    FakeWebTorrent.UTP_SUPPORT = false;

    expect(peerTransports(false)).toEqual(['TCP', 'DHT', 'LSD', 'trackers']);
  });
});

describe('addTorrent peer addresses', () => {
  it('repairs addresses garbled by bittorrent-tracker before adding them', () => {
    const torrent = addTorrent(
      new FakeWebTorrent() as unknown as WebTorrent,
      MAGNET,
      '/srv/downloads',
    );

    torrent.addPeer('49,56,53,46,49,50,53,46,49,57,48,46,53,57:6944');
    torrent.addPeer('10.0.0.2:6881');

    expect((torrent as unknown as FakeTorrent).addedPeers).toEqual([
      '185.125.190.59:6944',
      '10.0.0.2:6881',
    ]);
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
