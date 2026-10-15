import { afterEach, describe, expect, it, vi } from 'vitest';
import WebTorrent from 'webtorrent';
import { FakeWebTorrent } from './webtorrent.js';

// The pattern app tests should follow: swap the real module for the fake.
vi.mock('webtorrent', () => import('./webtorrent.js'));

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

describe('WebTorrent mock', () => {
  afterEach(() => {
    FakeWebTorrent.reset();
  });

  it('replaces the real webtorrent module', () => {
    const client = new WebTorrent();

    expect(client).toBeInstanceOf(FakeWebTorrent);
    expect(FakeWebTorrent.instances).toEqual([client]);
  });

  it('emits metadata and ready with the simulated files', () => {
    const client = new WebTorrent();
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
    expect(client.get(MAGNET)).toBe(torrent);
  });

  it('tracks download progress, speed and peers', () => {
    const client = new WebTorrent();
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

  it('surfaces errors and supports removal', () => {
    const client = new WebTorrent();
    const torrent = client.add(MAGNET);
    const onError = vi.fn();
    torrent.on('error', onError);

    torrent.simulateError(new Error('boom'));
    client.remove(MAGNET);

    expect(onError).toHaveBeenCalledWith(new Error('boom'));
    expect(torrent.destroyed).toBe(true);
    expect(client.torrents).toEqual([]);
  });

  it('records the element a file is streamed to', () => {
    const client = new WebTorrent();
    const torrent = client.add(MAGNET);
    torrent.simulateMetadata({ files: [{ name: 'bunny.mp4', length: 1000 }] });
    const video = document.createElement('video');

    torrent.files[0].streamTo(video);

    expect(torrent.files[0].streamedTo).toBe(video);
  });
});
