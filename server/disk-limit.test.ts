import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { DiskLimit } from './disk-limit.js';
import { SavedTorrents } from './saved-torrents.js';
import { activeDiskLimit, SettingsStore } from './settings.js';
import { settingsRouter } from './settings-api.js';
import { DISK_LIMIT_MESSAGE, torrentsRouter } from './torrents-api.js';

// Decision #36: at the disk limit, torrents still downloading pause and new
// ones are refused; raising the limit or deleting a torrent lets them go on.

const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const THIRD = '1111111111111111111111111111111111111111';
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}&dn=Film`;

describe('disk limit', () => {
  let downloadDir: string;
  let client: FakeWebTorrent;
  let settings: SettingsStore;
  let saved: SavedTorrents;
  let disk: DiskLimit;
  let app: Express;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'stream-disk-'));
    client = new FakeWebTorrent();
    settings = new SettingsStore(downloadDir, {
      diskLimitOn: true,
      diskLimit: 1000,
    });
    saved = new SavedTorrents(downloadDir);
    // Checked by hand in these tests rather than on the timer.
    disk = new DiskLimit({
      client: client as unknown as WebTorrent,
      limit: () => activeDiskLimit(settings.get()),
      intervalMs: 60_000,
    });
    app = express();
    app.use(
      '/api/torrents',
      torrentsRouter({
        client: client as unknown as WebTorrent,
        downloadDir,
        saved,
        disk,
      }),
    );
    app.use(settingsRouter({ settings, disk }));
  });

  afterEach(async () => {
    disk.stop();
    await saved.flush();
    await settings.flush();
    FakeWebTorrent.reset();
    vi.restoreAllMocks();
    rmSync(downloadDir, { recursive: true, force: true });
  });

  // Adds a one-video torrent of `length` bytes with its file list known.
  async function addFilm(hash: string, length = 800) {
    const res = await request(app)
      .post('/api/torrents')
      .send({ magnet: magnet(hash) });
    expect(res.status).toBe(201);
    const torrent = client.torrents.find((each) => each.infoHash === hash);
    if (!torrent) throw new Error('not added');
    torrent.simulateMetadata({
      name: 'Film',
      files: [{ name: 'Film.mp4', path: 'Film/Film.mp4', length }],
    });
    return torrent;
  }
  const stateOf = async (hash: string) =>
    (await request(app).get(`/api/torrents/${hash}`)).body.state;

  it('pauses torrents still downloading once usage reaches the limit', async () => {
    const first = await addFilm(HASH);
    const second = await addFilm(OTHER);
    first.simulateFileDownload(0, 600);
    second.simulateFileDownload(0, 300);
    disk.check();
    expect(first.paused).toBe(false);

    second.simulateFileDownload(0, 100);
    disk.check();
    expect(first.paused).toBe(true);
    expect(second.paused).toBe(true);
    expect(await stateOf(HASH)).toBe('diskFull');
    expect(disk.usage()).toEqual({ used: 1000, limit: 1000, reached: true });
  });

  it('leaves finished and user-paused torrents as they are', async () => {
    const finished = await addFilm(HASH, 500);
    finished.simulateFileDownload(0, 500);
    const mine = await addFilm(OTHER);
    await request(app).post(`/api/torrents/${OTHER}/pause`);
    const busy = await addFilm(THIRD);
    busy.simulateFileDownload(0, 500);

    disk.check();
    expect(finished.paused).toBe(false);
    expect(await stateOf(HASH)).toBe('seeding');
    expect(await stateOf(OTHER)).toBe('paused');
    expect(busy.paused).toBe(true);

    settings.set({ diskLimitOn: false, diskLimit: null });
    disk.check();
    expect(busy.paused).toBe(false);
    // Paused by the user, so it stays paused.
    expect(mine.paused).toBe(true);
  });

  it('refuses new torrents at the limit', async () => {
    const torrent = await addFilm(HASH, 2000);
    torrent.simulateFileDownload(0, 1000);

    const res = await request(app)
      .post('/api/torrents')
      .send({ magnet: magnet(OTHER) });
    expect(res.status).toBe(507);
    expect(res.body.error).toBe(DISK_LIMIT_MESSAGE);
    expect(client.torrents).toHaveLength(1);
  });

  it('refuses to resume a torrent with more to download, but lets the user pause it', async () => {
    const torrent = await addFilm(HASH, 2000);
    torrent.simulateFileDownload(0, 1000);
    disk.check();

    const resumed = await request(app).post(`/api/torrents/${HASH}/resume`);
    expect(resumed.status).toBe(507);
    expect(torrent.paused).toBe(true);

    // Pausing it makes it the user's: raising the limit doesn't resume it.
    await request(app).post(`/api/torrents/${HASH}/pause`);
    expect(await stateOf(HASH)).toBe('paused');
    settings.set({ diskLimitOn: true, diskLimit: 5000 });
    disk.check();
    expect(torrent.paused).toBe(true);
  });

  it('keeps a torrent paused at the limit when a video is played with ?play', async () => {
    const torrent = await addFilm(HASH, 2000);
    torrent.simulateFileDownload(0, 1000);
    disk.check();

    const res = await request(app)
      .get(`/api/torrents/${HASH}/files/0/stream?play`)
      .set('Range', 'bytes=0-9');
    expect(res.status).toBe(206);
    expect(torrent.paused).toBe(true);
  });

  it('resumes what it paused when deleting a torrent frees enough', async () => {
    const first = await addFilm(HASH);
    const second = await addFilm(OTHER);
    first.simulateFileDownload(0, 600);
    second.simulateFileDownload(0, 400);
    disk.check();
    expect(second.paused).toBe(true);

    await request(app).delete(`/api/torrents/${HASH}`);
    expect(second.paused).toBe(false);
  });

  it('does not save a pause by the limit, so a restart starts it again', async () => {
    const torrent = await addFilm(HASH, 2000);
    torrent.simulateFileDownload(0, 1000);
    disk.check();
    // Any save after the pause, such as playing another file.
    await request(app).post(`/api/torrents/${HASH}/files/0/select`);
    await saved.flush();
    const [entry] = await saved.load();
    expect(entry.paused).toBe(false);
  });

  describe('/api/settings', () => {
    it('reports the limit and how much is used', async () => {
      const torrent = await addFilm(HASH);
      torrent.simulateFileDownload(0, 250);
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        diskLimitOn: true,
        diskLimit: 1000,
        diskUsed: 250,
        diskLimitReached: false,
      });
    });

    it('changes the limit at once and saves it', async () => {
      const torrent = await addFilm(HASH, 2000);
      torrent.simulateFileDownload(0, 1000);
      disk.check();
      expect(torrent.paused).toBe(true);

      const res = await request(app)
        .put('/api/settings')
        .send({ diskLimitOn: true, diskLimit: 1500 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        diskLimitOn: true,
        diskLimit: 1500,
        diskUsed: 1000,
        diskLimitReached: false,
      });
      expect(torrent.paused).toBe(false);

      const next = new SettingsStore(downloadDir);
      expect(await next.load()).toEqual({ diskLimitOn: true, diskLimit: 1500 });
    });

    it('takes null for no limit', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ diskLimitOn: false });
      // The number stays for when it is turned on again.
      expect(res.body).toMatchObject({
        diskLimitOn: false,
        diskLimit: 1000,
        diskLimitReached: false,
      });
      expect(disk.usage().limit).toBeNull();
    });

    it('refuses a bad limit and keeps the old one', async () => {
      for (const body of [
        { diskLimitOn: true, diskLimit: -1 },
        { diskLimitOn: true, diskLimit: '5GB' },
        { diskLimitOn: true, diskLimit: null },
        [1],
      ]) {
        const res = await request(app).put('/api/settings').send(body);
        expect(res.status).toBe(400);
      }
      const notJson = await request(app)
        .put('/api/settings')
        .set('Content-Type', 'application/json')
        .send('{oops');
      expect(notJson.status).toBe(400);
      const form = await request(app)
        .put('/api/settings')
        .type('form')
        .send('diskLimit=5');
      expect(form.status).toBe(415);
      expect(settings.get()).toEqual({ diskLimitOn: true, diskLimit: 1000 });
    });
  });
});

describe('DiskLimit timer', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeWebTorrent.reset();
  });

  it('checks usage every interval', () => {
    vi.useFakeTimers();
    const client = new FakeWebTorrent();
    const torrent = client.add(magnet(HASH));
    torrent.length = 100;
    const disk = new DiskLimit({
      client: client as unknown as WebTorrent,
      limit: () => 50,
      intervalMs: 1000,
    });
    torrent.simulateDownload(60);
    expect(torrent.paused).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(torrent.paused).toBe(true);
    disk.stop();
  });
});
