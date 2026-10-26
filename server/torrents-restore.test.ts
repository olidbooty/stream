import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Instance as ParsedTorrent } from 'parse-torrent';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { SAVED_TORRENTS_DIR, SavedTorrents } from './saved-torrents.js';
import { torrentsRouter } from './torrents-api.js';

// Decision #13: torrents are saved as they change and added again on the next
// start, as the user left them.

const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const magnet = (hash: string, name = 'Show') =>
  `magnet:?xt=urn:btih:${hash}&dn=${name}`;
const SEASON = [
  { name: 'Episode 1.mp4', path: 'Show/Episode 1.mp4', length: 1000 },
  { name: 'Episode 1.en.srt', path: 'Show/Episode 1.en.srt', length: 10 },
  { name: 'Episode 2.mp4', path: 'Show/Episode 2.mp4', length: 1000 },
];
const TORRENT_FILE = new Uint8Array([100, 101]);

describe('saving and restoring torrents', () => {
  let downloadDir: string;
  let client: FakeWebTorrent;
  let saved: SavedTorrents;
  let app: Express;

  // A fresh client and router, like the server starting again.
  async function startServer(): Promise<void> {
    client = new FakeWebTorrent();
    saved = new SavedTorrents(downloadDir);
    const restore = await saved.load();
    app = express();
    app.use(
      '/api/torrents',
      torrentsRouter({
        client: client as unknown as WebTorrent,
        downloadDir,
        saved,
        restore,
      }),
    );
  }

  const savedJSON = (hash = HASH) =>
    JSON.parse(
      readFileSync(
        join(downloadDir, SAVED_TORRENTS_DIR, `${hash}.json`),
        'utf8',
      ),
    );
  const savedPath = (extension: string, hash = HASH) =>
    join(downloadDir, SAVED_TORRENTS_DIR, `${hash}.${extension}`);
  const add = (hash = HASH, name?: string) =>
    request(app)
      .post('/api/torrents')
      .send({ magnet: magnet(hash, name) });

  beforeEach(async () => {
    downloadDir = mkdtempSync(join(tmpdir(), 'stream-restore-'));
    await startServer();
  });

  afterEach(() => {
    FakeWebTorrent.reset();
    vi.restoreAllMocks();
    rmSync(downloadDir, { recursive: true, force: true });
  });

  it('saves a torrent when it is added', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    await add();
    await saved.flush();

    expect(savedJSON()).toEqual({
      addedAt: 1234,
      magnetURI: expect.stringContaining(HASH),
      paused: false,
      selected: null,
    });
    expect(existsSync(savedPath('torrent'))).toBe(false);
  });

  // The real torrent's infoHash is empty until WebTorrent parses it, a tick
  // after add().
  it('saves a torrent whose info hash is not set yet', async () => {
    const addToClient = client.add.bind(client);
    vi.spyOn(client, 'add').mockImplementation((...args) => {
      const torrent = addToClient(...args);
      torrent.infoHash = '';
      return torrent;
    });

    await add();
    await saved.flush();

    expect(savedJSON().magnetURI).toContain(HASH);
  });

  it('saves the .torrent and the selection once the metadata arrives', async () => {
    await add();
    client.torrents[0].simulateMetadata({
      name: 'Show',
      files: SEASON,
      metadata: TORRENT_FILE,
    });
    await saved.flush();

    expect(readFileSync(savedPath('torrent'))).toEqual(
      Buffer.from(TORRENT_FILE),
    );
    expect(savedJSON().selected).toEqual([0, 1]);

    await request(app).post(`/api/torrents/${HASH}/files/2/select`);
    await saved.flush();

    expect(savedJSON().selected).toEqual([0, 1, 2]);
  });

  it('saves pause and resume', async () => {
    await add();

    await request(app).post(`/api/torrents/${HASH}/pause`);
    await saved.flush();
    expect(savedJSON().paused).toBe(true);

    await request(app).post(`/api/torrents/${HASH}/resume`);
    await saved.flush();
    expect(savedJSON().paused).toBe(false);
  });

  it('forgets a torrent when it is removed', async () => {
    await add();
    client.torrents[0].simulateMetadata({ files: SEASON });

    await request(app).delete(`/api/torrents/${HASH}`);
    await saved.flush();

    expect(existsSync(savedPath('json'))).toBe(false);
    expect(existsSync(savedPath('torrent'))).toBe(false);
  });

  it('forgets a torrent that fails (Decision #22)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await add();

    client.torrents[0].simulateError(new Error('disk full'));
    await saved.flush();

    expect(existsSync(savedPath('json'))).toBe(false);
  });

  it('adds the saved torrents again on the next start, in order', async () => {
    // OTHER is added first, though its info hash sorts last.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    await add(OTHER, 'Second');
    now.mockReturnValue(2);
    await add(HASH, 'First');
    await saved.flush();

    await startServer();

    expect(client.torrents.map((torrent) => torrent.infoHash)).toEqual([
      OTHER,
      HASH,
    ]);
    expect(client.torrents[0]).toMatchObject({
      path: downloadDir,
      deselect: true,
    });
    // The fake leaves name unset; the real client takes it from the
    // parsed magnet link it was given.
    expect(
      client.torrents.map(
        (torrent) => (torrent.torrentId as ParsedTorrent).name,
      ),
    ).toEqual(['Second', 'First']);
  });

  it('restores the selection and paused state', async () => {
    // The fake's .torrent bytes don't parse, so the magnet link is used.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await add();
    client.torrents[0].simulateMetadata({
      name: 'Show',
      files: SEASON,
      metadata: TORRENT_FILE,
    });
    await request(app).post(`/api/torrents/${HASH}/files/2/select`);
    await request(app).post(`/api/torrents/${HASH}/pause`);
    await saved.flush();

    await startServer();
    const torrent = client.torrents[0];
    expect(torrent.paused).toBe(true);
    torrent.simulateMetadata({ name: 'Show', files: SEASON });

    expect(torrent.files.map((file) => file.selected)).toEqual([
      true,
      true,
      true,
    ]);
    const detail = await request(app).get(`/api/torrents/${HASH}`);
    expect(detail.body).toMatchObject({
      state: 'paused',
      selectedLength: 2010,
    });
  });

  it('chooses the files again if the saved selection no longer fits', async () => {
    await add();
    client.torrents[0].simulateMetadata({ files: SEASON });
    await saved.flush();
    await saved.save(HASH, { ...savedJSON(), selected: [7] });

    await startServer();
    client.torrents[0].simulateMetadata({ files: SEASON });

    expect(client.torrents[0].files.map((file) => file.selected)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('starts with nothing when nothing was saved', () => {
    expect(client.torrents).toEqual([]);
  });

  it('saves nothing without a store', async () => {
    client = new FakeWebTorrent();
    app = express();
    app.use(
      '/api/torrents',
      torrentsRouter({ client: client as unknown as WebTorrent, downloadDir }),
    );

    await add();

    expect(existsSync(join(downloadDir, SAVED_TORRENTS_DIR))).toBe(false);
  });
});
