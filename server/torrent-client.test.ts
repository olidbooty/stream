import { getDefaultResultOrder, setDefaultResultOrder } from 'node:dns';
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
import type { Torrent } from 'webtorrent';
import { type FakeTorrent, FakeWebTorrent } from '../test/mocks/webtorrent.js';
import {
  addTorrent,
  createTorrentClient,
  DEFAULT_DOWNLOAD_DIR,
  DHT_BOOTSTRAP,
  destroyTorrentClient,
  ensureDownloadDir,
  pauseTorrent,
  peerTransports,
  removeTorrent,
  resumeTorrent,
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

  it('bootstraps the DHT from IPv4 addresses of a wider router list', () => {
    setDefaultResultOrder('verbatim');
    createTorrentClient(options);

    expect(FakeWebTorrent.instances[0].opts.dht).toEqual({
      bootstrap: DHT_BOOTSTRAP,
    });
    expect(DHT_BOOTSTRAP).toContain('dht.libtorrent.org:25401');
    expect(getDefaultResultOrder()).toBe('ipv4first');
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
    expect(torrent.deselect).toBe(true);
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

  // Decision #13: the files stay so the torrent can be restored on the next
  // start. Only DELETE removes them.
  it('keeps the downloaded files', async () => {
    const fake = new FakeWebTorrent();
    const torrent = addTorrent(
      fake as unknown as WebTorrent,
      MAGNET,
      '/srv/downloads',
    ) as unknown as FakeTorrent;

    await destroyTorrentClient(fake as unknown as WebTorrent);

    expect(torrent.destroyed).toBe(true);
    expect(torrent.storeDestroyed).toBe(false);
  });
});

describe('pauseTorrent and resumeTorrent', () => {
  function connected() {
    const fake = new FakeWebTorrent();
    const torrent = fake.add(MAGNET);
    torrent.urlList = ['https://seed.example.com/'];
    torrent.simulateWire('203.0.113.5:6881', 'tcpOutgoing');
    torrent.simulateWire('[2001:db8::1]:51413', 'utpOutgoing');
    torrent.simulateWire('198.51.100.7:40123', 'tcpIncoming');
    torrent.simulateWire('https://seed.example.com/', 'webSeed');
    return torrent;
  }

  it('drops every peer and refuses new ones while paused', () => {
    const torrent = connected();

    pauseTorrent(torrent as unknown as Torrent);

    expect(torrent.paused).toBe(true);
    expect(torrent.wires).toEqual([]);
    expect(torrent.numPeers).toBe(0);
    expect(torrent.addPeer('192.0.2.1:6881')).toBe(false);
  });

  it('calls back the peers it dialled and the web seeds on resume', () => {
    const torrent = connected();
    pauseTorrent(torrent as unknown as Torrent);

    resumeTorrent(torrent as unknown as Torrent);

    expect(torrent.paused).toBe(false);
    expect(torrent.addedPeers).toEqual([
      '203.0.113.5:6881',
      '[2001:db8::1]:51413',
    ]);
    expect(torrent.addedWebSeeds).toEqual(['https://seed.example.com/']);
  });

  // A torrent restored as paused (Decision #13) never got to try them.
  it("tries the magnet link's x.pe peers on resume", () => {
    const torrent = new FakeWebTorrent().add(MAGNET);
    Object.assign(torrent, { peerAddresses: ['192.0.2.9:7001'] });
    pauseTorrent(torrent as unknown as Torrent);

    resumeTorrent(torrent as unknown as Torrent);

    expect(torrent.addedPeers).toEqual(['192.0.2.9:7001']);
  });

  it('does nothing when already in that state', () => {
    const torrent = connected();

    resumeTorrent(torrent as unknown as Torrent);
    pauseTorrent(torrent as unknown as Torrent);
    torrent.simulateWire();
    pauseTorrent(torrent as unknown as Torrent);

    expect(torrent.addedPeers).toEqual([]);
    expect(torrent.wires).toHaveLength(1);
  });
});
