import { afterEach, describe, expect, it, vi } from 'vitest';
import WebTorrent from 'webtorrent';
import { FakeWebTorrent } from './webtorrent.js';

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
    expect(torrent.files.map((file) => file.name)).toEqual(['bunny.mp4', 'poster.jpg']);
    expect(torrent.length).toBe(1024);
    expect(await client.get(MAGNET)).toBe(torrent);
  });

  it('can report metadata before the torrent is ready', () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    const onReady = vi.fn();
    torrent.on('ready', onReady);

    expect(torrent.metadata).toBeNull();
    torrent.simulateMetadata({ files: [{ name: 'bunny.mp4', length: 1000 }], ready: false });

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

  it('surfaces errors and supports removal', async () => {
    const client = createClient();
    const torrent = client.add(MAGNET);
    const onError = vi.fn();
    torrent.on('error', onError);

    torrent.simulateError(new Error('boom'));
    await client.remove(MAGNET);

    expect(onError).toHaveBeenCalledWith(new Error('boom'));
    expect(torrent.destroyed).toBe(true);
    expect(torrent.storeDestroyed).toBe(false);
    expect(client.torrents).toEqual([]);
  });

  it('rejects removing an unknown torrent, like the real client', async () => {
    const client = createClient();

    await expect(client.remove(MAGNET)).rejects.toThrow('No torrent with id');
  });

  it('records the download path and whether the store is deleted', async () => {
    const client = createClient();
    const kept = client.add(MAGNET, { path: '/downloads' });
    const deleted = client.add('other', { infoHash: 'f'.repeat(40), destroyStoreOnDestroy: true });

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
    expect(client.add(`magnet:?xt=urn:btih:${'a'.repeat(40)}`).infoHash).toBe('a'.repeat(40));
    expect(client.add(new Uint8Array(4)).infoHash).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('reports its peer port once listening', () => {
    const client = new WebTorrent({ torrentPort: 51413 }) as unknown as FakeWebTorrent;
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
});
