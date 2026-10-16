import express, { type Express } from 'express';
import { toTorrentFile, type Instance as ParsedTorrent } from 'parse-torrent';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { MAX_TORRENT_FILE_BYTES, torrentsRouter } from './torrents-api.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`;
const DOWNLOAD_DIR = '/srv/downloads';

// A minimal single-file .torrent. Its info hash is the SHA-1 of the info dict.
function torrentFile(name = 'bunny.mp4'): Buffer {
  const info = { name, length: 1000, 'piece length': 16384, pieces: new Uint8Array(20) };
  return Buffer.from(toTorrentFile({ info } as unknown as ParsedTorrent));
}

describe('/api/torrents', () => {
  let client: FakeWebTorrent;
  let app: Express;

  beforeEach(() => {
    client = new FakeWebTorrent();
    app = express();
    app.use(
      '/api/torrents',
      torrentsRouter({ client: client as unknown as WebTorrent, downloadDir: DOWNLOAD_DIR }),
    );
  });

  afterEach(() => {
    FakeWebTorrent.reset();
    vi.restoreAllMocks();
  });

  describe('POST with a magnet link', () => {
    it('adds the torrent to the download directory', async () => {
      const res = await request(app).post('/api/torrents').send({ magnet: MAGNET });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/api/torrents/${HASH}`);
      expect(res.body).toMatchObject({ infoHash: HASH, ready: false, progress: 0 });
      expect(res.body.magnetURI).toContain(HASH);
      expect(client.torrents).toHaveLength(1);
      expect(client.torrents[0]).toMatchObject({
        infoHash: HASH,
        path: DOWNLOAD_DIR,
        destroyStoreOnDestroy: true,
      });
    });

    it('accepts an upper-case or base32 info hash', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .send({ magnet: `magnet:?xt=urn:btih:${'AERUKZ4JVPGW66CKAERUKZ4JVPGW66CK'}` });

      expect(res.status).toBe(201);
      expect(res.body.infoHash).toMatch(/^[0-9a-f]{40}$/);
    });

    it.each([
      ['missing', {}],
      ['not a string', { magnet: 42 }],
      ['a URL', { magnet: 'https://webtorrent.io/torrents/sintel.torrent' }],
      ['a file path', { magnet: '/etc/passwd' }],
      ['without an info hash', { magnet: 'magnet:?dn=Sintel' }],
    ])('rejects a magnet that is %s', async (_label, body) => {
      const res = await request(app).post('/api/torrents').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/magnet/);
      expect(client.torrents).toEqual([]);
    });

    it('rejects malformed JSON', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/json')
        .send('{"magnet":');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/JSON/);
    });

    it('refuses to add the same torrent twice', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });

      const res = await request(app)
        .post('/api/torrents')
        .send({ magnet: `magnet:?xt=urn:btih:${HASH.toUpperCase()}` });

      expect(res.status).toBe(409);
      expect(res.body.torrent.infoHash).toBe(HASH);
      expect(client.torrents).toHaveLength(1);
    });
  });

  describe('POST with a .torrent file', () => {
    it('adds the uploaded torrent', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(torrentFile());

      expect(res.status).toBe(201);
      expect(res.body.infoHash).toMatch(/^[0-9a-f]{40}$/);
      expect(res.body.name).toBe('bunny.mp4');
      expect(client.torrents[0].infoHash).toBe(res.body.infoHash);
      expect(client.torrents[0].path).toBe(DOWNLOAD_DIR);
    });

    it('gives different files different info hashes', async () => {
      const first = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(torrentFile('a.mp4'));
      const second = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(torrentFile('b.mp4'));

      expect(second.status).toBe(201);
      expect(second.body.infoHash).not.toBe(first.body.infoHash);
    });

    it('rejects a file that is not a torrent', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(Buffer.from('not bencode'));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Not a valid .torrent file');
      expect(client.torrents).toEqual([]);
    });

    it('rejects an empty file', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(Buffer.alloc(0));

      expect(res.status).toBe(400);
    });

    it('rejects a file over the size limit', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(Buffer.alloc(MAX_TORRENT_FILE_BYTES + 1));

      expect(res.status).toBe(413);
      expect(client.torrents).toEqual([]);
    });
  });

  it('rejects other content types', async () => {
    const res = await request(app).post('/api/torrents').type('text/plain').send(MAGNET);

    expect(res.status).toBe(415);
  });

  describe('GET', () => {
    it('lists no torrents at first', async () => {
      const res = await request(app).get('/api/torrents');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('lists added torrents with their state', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      const torrent = client.torrents[0];
      torrent.simulateMetadata({ name: 'Sintel', files: [{ name: 'sintel.mp4', length: 1000 }] });
      torrent.simulateDownload(250, { downloadSpeed: 500, numPeers: 3 });

      const res = await request(app).get('/api/torrents');

      expect(res.body).toEqual([
        {
          infoHash: HASH,
          name: 'Sintel',
          magnetURI: torrent.magnetURI,
          ready: true,
          progress: 0.25,
          numPeers: 3,
          downloadSpeed: 500,
          uploadSpeed: 0,
        },
      ]);
    });
  });

  describe('DELETE /:infoHash', () => {
    it('removes the torrent and deletes its files', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      const torrent = client.torrents[0];

      const res = await request(app).delete(`/api/torrents/${HASH.toUpperCase()}`);

      expect(res.status).toBe(204);
      expect(client.torrents).toEqual([]);
      expect(torrent.destroyed).toBe(true);
      expect(torrent.storeDestroyed).toBe(true);
    });

    it('returns 404 for a torrent that was never added', async () => {
      const res = await request(app).delete(`/api/torrents/${HASH}`);

      expect(res.status).toBe(404);
    });

    it('returns 400 for something that is not an info hash', async () => {
      const res = await request(app).delete('/api/torrents/not-a-hash');

      expect(res.status).toBe(400);
    });

    it('returns 500 as JSON if removal fails', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      vi.spyOn(client, 'remove').mockRejectedValue(new Error('disk error'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).delete(`/api/torrents/${HASH}`);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal error' });
    });
  });
});
