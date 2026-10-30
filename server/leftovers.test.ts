import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { leftoversRouter, removeEmptyFolders } from './leftovers.js';
import { torrentsRouter } from './torrents-api.js';

// Decision #37: files and folders in DOWNLOAD_DIR that no torrent owns are
// listed, and deleted only when asked, one at a time.

const HASH = '0123456789abcdef0123456789abcdef01234567';
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}&dn=Show`;
const SHOW = [
  { name: 'Episode 1.mp4', path: 'Show/Episode 1.mp4', length: 10 },
  { name: 'Episode 2.mp4', path: 'Show/Season/Episode 2.mp4', length: 10 },
];

describe('leftover files', () => {
  let downloadDir: string;
  let client: FakeWebTorrent;
  let app: Express;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'stream-leftovers-'));
    client = new FakeWebTorrent();
    app = express();
    app.use(
      '/api/torrents',
      torrentsRouter({ client: client as unknown as WebTorrent, downloadDir }),
    );
    app.use(
      leftoversRouter({ client: client as unknown as WebTorrent, downloadDir }),
    );
  });

  afterEach(() => {
    FakeWebTorrent.reset();
    vi.restoreAllMocks();
    rmSync(downloadDir, { recursive: true, force: true });
  });

  const write = (path: string, bytes = 5000) => {
    const full = join(downloadDir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, Buffer.alloc(bytes, 1));
  };
  async function addShow(hash = HASH) {
    await request(app)
      .post('/api/torrents')
      .send({ magnet: magnet(hash) });
    return client.torrents[client.torrents.length - 1];
  }
  const list = async () => (await request(app).get('/api/leftovers')).body;

  it('lists what no torrent owns, biggest first, and never its own files', async () => {
    const torrent = await addShow();
    torrent.simulateMetadata({ name: 'Show', files: SHOW });
    write('Show/Episode 1.mp4');
    write('Old Film/Old Film.mkv', 50_000);
    write('stray.mp4', 5000);
    mkdirSync(join(downloadDir, 'Empty'));
    write('.torrents/x.json', 10);
    write('.settings.json', 10);

    const body = await list();
    expect(body.pending).toBe(false);
    expect(body.leftovers.map((each: { name: string }) => each.name)).toEqual([
      'Old Film',
      'stray.mp4',
      'Empty',
    ]);
    expect(body.leftovers[0]).toMatchObject({ folder: true });
    expect(body.leftovers[0].bytes).toBeGreaterThanOrEqual(50_000);
    expect(body.leftovers[2]).toEqual({
      name: 'Empty',
      folder: true,
      bytes: 0,
    });
  });

  it('lists nothing while a torrent has no file list yet', async () => {
    await addShow();
    write('Show/Episode 1.mp4');
    expect(await list()).toEqual({ pending: true, leftovers: [] });
    const res = await request(app).delete('/api/leftovers/Show');
    expect(res.status).toBe(409);
    expect(existsSync(join(downloadDir, 'Show'))).toBe(true);
  });

  it('deletes one leftover when asked', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    write('Old Film/Old Film.mkv');
    write('keep.mp4');
    const res = await request(app).delete('/api/leftovers/Old%20Film');
    expect(res.status).toBe(204);
    expect(existsSync(join(downloadDir, 'Old Film'))).toBe(false);
    expect(existsSync(join(downloadDir, 'keep.mp4'))).toBe(true);
  });

  it('refuses anything that is not listed', async () => {
    const torrent = await addShow();
    torrent.simulateMetadata({ name: 'Show', files: SHOW });
    write('Show/Episode 1.mp4');
    write('.torrents/x.json', 10);
    for (const name of ['Show', '.torrents', '..', '%2E%2E%2Fetc', 'missing']) {
      const res = await request(app).delete(`/api/leftovers/${name}`);
      expect(res.status).not.toBe(204);
    }
    expect(existsSync(join(downloadDir, 'Show/Episode 1.mp4'))).toBe(true);
    expect(existsSync(join(downloadDir, '.torrents/x.json'))).toBe(true);
  });

  it('deletes a symbolic link, not what it points to', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const outside = mkdtempSync(join(tmpdir(), 'stream-outside-'));
    writeFileSync(join(outside, 'precious'), 'x');
    symlinkSync(outside, join(downloadDir, 'link'));
    const res = await request(app).delete('/api/leftovers/link');
    expect(res.status).toBe(204);
    expect(existsSync(join(outside, 'precious'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('removes the empty folders a removed multi-file torrent leaves', async () => {
    const torrent = await addShow();
    torrent.simulateMetadata({ name: 'Show', files: SHOW });
    // The store deleted the files but left their folders.
    mkdirSync(join(downloadDir, 'Show/Season'), { recursive: true });
    await request(app).delete(`/api/torrents/${HASH}`);
    expect(existsSync(join(downloadDir, 'Show'))).toBe(false);
  });

  it('keeps a removed torrent’s folder if anything is still in it', async () => {
    const torrent = await addShow();
    torrent.simulateMetadata({ name: 'Show', files: SHOW });
    mkdirSync(join(downloadDir, 'Show/Season'), { recursive: true });
    write('Show/notes.txt', 3);
    await request(app).delete(`/api/torrents/${HASH}`);
    expect(existsSync(join(downloadDir, 'Show/notes.txt'))).toBe(true);
    expect(existsSync(join(downloadDir, 'Show/Season'))).toBe(false);
  });

  it('removeEmptyFolders ignores a missing path and a file', async () => {
    await removeEmptyFolders(join(downloadDir, 'nope'));
    write('file.mp4', 1);
    await removeEmptyFolders(join(downloadDir, 'file.mp4'));
    expect(existsSync(join(downloadDir, 'file.mp4'))).toBe(true);
  });
});
