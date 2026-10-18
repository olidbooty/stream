import { buffer } from 'node:stream/consumers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebTorrent from 'webtorrent';
import { FakeWebTorrent, fakeFileBytes } from './webtorrent.js';

// The pattern app tests should follow: swap the real module for the fake.
vi.mock('webtorrent', () => import('./webtorrent.js'));

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

// Typed as the real client, but under vi.mock the instance is the fake.
function createClient(): FakeWebTorrent {
  return new WebTorrent() as unknown as FakeWebTorrent;
}

describe('WebTorrent mock', () => {
  afterEach(() => {
    FakeWebTorrent.reset();
  });

  it('replaces the real webtorrent module', () => {
    const client = createClient();

    expect(client).toBeInstanceOf(FakeWebTorrent);
    expect(FakeWebTorrent.instances).toEqual([client]);
  });

  it('emits metadata and ready with the simulated files', async () => {
    const client = createClient();
    const onTorrent = vi.fn();
    const torrent = client.add(MAGNET, onTorrent);
    const onMetadata = vi.fn();
    torrent.on('metadata', onMetadata);

    torrent.simulateMetadata({
      name: 'Big Buck Bunny',
      files: [
        { name: 'bunny.mp4', length: 1000 },
        { name: 'poster.jpg', length: 24 },
      ],
    });

    expect(onMetadata).toHaveBeenCalledOnce();
    expect(onTorrent).toHaveBeenCalledWith(torrent);
    expect(torrent.files.map((file) => file.name)).toEqual([
      'bunny.mp4',
      'poster.jpg',
    ]);
    expect(torrent.length).toBe(1024);
    expect(await client.get(MAGNET)).toBe(torrent);
  });

  it('can report metadata before the torrent is ready', () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    const onReady = vi.fn();
    torrent.on('ready', onReady);

    expect(torrent.metadata).toBeNull();
    torrent.simulateMetadata({
      files: [{ name: 'bunny.mp4', length: 1000 }],
      ready: false,
    });

    expect(torrent.metadata).not.toBeNull();
    expect(torrent.ready).toBe(false);
    expect(onReady).not.toHaveBeenCalled();

    torrent.simulateReady();
    expect(torrent.ready).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('tracks download progress, speed and peers', () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    torrent.simulateMetadata({ files: [{ name: 'bunny.mp4', length: 1000 }] });
    const onDownload = vi.fn();
    torrent.on('download', onDownload);

    torrent.simulateDownload(250, { downloadSpeed: 500, numPeers: 3 });

    expect(onDownload).toHaveBeenCalledWith(250);
    expect(torrent.progress).toBe(0.25);
    expect(torrent.numPeers).toBe(3);
    expect(client.downloadSpeed).toBe(500);
    expect(client.progress).toBe(0.25);

    torrent.simulateDone();
    expect(torrent.done).toBe(true);
    expect(torrent.progress).toBe(1);
  });

  it('supports removal', async () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    const onRemove = vi.fn();
    client.on('remove', onRemove);

    await client.remove(MAGNET);

    expect(torrent.destroyed).toBe(true);
    expect(torrent.storeDestroyed).toBe(false);
    expect(client.torrents).toEqual([]);
    expect(onRemove).toHaveBeenCalledWith(torrent);
  });

  it('destroys and removes a torrent that fails, like the real client', () => {
    const client = createClient();
    const torrent = client.add(MAGNET, { destroyStoreOnDestroy: true });
    const events: string[] = [];
    torrent.on('error', (err: Error) => {
      // Already gone from the list by the time 'error' is emitted.
      events.push(`error ${err.message} ${client.torrents.length}`);
    });
    torrent.on('close', () => events.push('close'));

    torrent.simulateError(new Error('boom'));

    expect(events).toEqual(['error boom 0', 'close']);
    expect(torrent.destroyed).toBe(true);
    expect(torrent.storeDestroyed).toBe(true);
  });

  it('sends a torrent error to the client when the torrent has no listener', () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    const onClientError = vi.fn();
    client.on('error', onClientError);

    torrent.simulateError(new Error('boom'));

    expect(onClientError).toHaveBeenCalledWith(new Error('boom'));
    expect(client.torrents).toEqual([]);
  });

  it('counts connected peers and reports when a source finds none', () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    const onWire = vi.fn();
    const onNoPeers = vi.fn();
    torrent.on('wire', onWire);
    torrent.on('noPeers', onNoPeers);

    torrent.simulateNoPeers('dht');
    torrent.simulateWire();
    torrent.simulateWire();

    expect(onNoPeers).toHaveBeenCalledWith('dht');
    expect(onWire).toHaveBeenCalledTimes(2);
    expect(torrent.numPeers).toBe(2);
  });

  it('rejects removing an unknown torrent, like the real client', async () => {
    const client = createClient();

    await expect(client.remove(MAGNET)).rejects.toThrow('No torrent with id');
  });

  it('records the download path and whether the store is deleted', async () => {
    const client = createClient();
    const kept = client.add(MAGNET, { path: '/downloads' });
    const deleted = client.add('other', {
      infoHash: 'f'.repeat(40),
      destroyStoreOnDestroy: true,
    });

    expect(kept.path).toBe('/downloads');
    await client.remove(MAGNET, { destroyStore: true });
    await client.remove('other');

    expect(kept.storeDestroyed).toBe(true);
    expect(deleted.storeDestroyed).toBe(true);
  });

  it('takes the info hash from a parsed torrent or a magnet link', () => {
    const client = createClient();
    const hash = 'f'.repeat(40);

    expect(client.add({ infoHash: hash.toUpperCase() }).infoHash).toBe(hash);
    expect(client.add(`magnet:?xt=urn:btih:${'a'.repeat(40)}`).infoHash).toBe(
      'a'.repeat(40),
    );
    expect(client.add(new Uint8Array(4)).infoHash).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
  });

  it('reports its peer port once listening', () => {
    const client = new WebTorrent({
      torrentPort: 51413,
    }) as unknown as FakeWebTorrent;
    const onListening = vi.fn();
    client.on('listening', onListening);

    expect(client.address()).toBeNull();
    client.simulateListening();

    expect(onListening).toHaveBeenCalledOnce();
    expect(client.address()).toMatchObject({ port: 51413 });

    client.destroy();
    expect(client.address()).toBeNull();
  });

  it('records the element a file is streamed to', () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    torrent.simulateMetadata({ files: [{ name: 'bunny.mp4', length: 1000 }] });
    const video = document.createElement('video');

    torrent.files[0].streamTo(video);

    expect(torrent.files[0].streamedTo).toBe(video);
  });

  it('streams a byte range of a file and records it', async () => {
    const torrent = createClient().add(MAGNET);
    torrent.simulateMetadata({
      files: [{ name: 'bunny.mp4', length: 100_000 }],
    });
    const file = torrent.files[0];

    const bytes = await buffer(file.createReadStream({ start: 10, end: 19 }));

    expect(file.type).toBe('video/mp4');
    expect(bytes).toEqual(fakeFileBytes(10, 20));
    expect(file.readStreams).toMatchObject([{ start: 10, end: 19 }]);
  });

  it('reads to the end for end: 0, like the real file', async () => {
    const torrent = createClient().add(MAGNET);
    torrent.simulateMetadata({ files: [{ name: 'bunny.mp4', length: 300 }] });

    const bytes = await buffer(
      torrent.files[0].createReadStream({ start: 0, end: 0 }),
    );

    expect(bytes).toHaveLength(300);
  });

  it('waits past the available bytes until destroyed', async () => {
    const torrent = createClient().add(MAGNET);
    torrent.simulateMetadata({
      files: [{ name: 'bunny.mp4', length: 300, available: 100 }],
    });
    const stream = torrent.files[0].createReadStream();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));

    await vi.waitFor(() => expect(Buffer.concat(chunks)).toHaveLength(100));
    expect(stream.readableEnded).toBe(false);
    stream.destroy();
    expect(stream.destroyed).toBe(true);
  });
});
