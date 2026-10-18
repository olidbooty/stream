import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import parseTorrent, { type Instance as ParsedTorrent, toTorrentFile } from 'parse-torrent';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { EventStream } from './event-stream.js';
import { MAX_TORRENT_FILE_BYTES, type TorrentFileInfo, torrentsRouter } from './torrents-api.js';

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
          hasMetadata: true,
          ready: true,
          length: 1000,
          progress: 0.25,
          numPeers: 3,
          downloadSpeed: 500,
          uploadSpeed: 0,
          state: 'downloading',
          errorMessage: null,
        },
      ]);
    });
  });

  describe('state', () => {
    const stateOf = async () => (await request(app).get(`/api/torrents/${HASH}`)).body.state;

    beforeEach(async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
    });

    it('goes from connecting to downloading to seeding', async () => {
      const torrent = client.torrents[0];
      expect(await stateOf()).toBe('connecting');

      torrent.simulateWire();
      expect(await stateOf()).toBe('connecting');

      torrent.simulateMetadata({ name: 'Sintel', files: [{ name: 'sintel.mp4', length: 1000 }] });
      expect(await stateOf()).toBe('downloading');

      torrent.simulateDone();
      expect(await stateOf()).toBe('seeding');
    });

    it('reports noPeers once WebTorrent finds none, until a peer connects', async () => {
      const torrent = client.torrents[0];

      torrent.simulateNoPeers('dht');
      expect(await stateOf()).toBe('noPeers');
      const list = await request(app).get('/api/torrents');
      expect(list.body[0].state).toBe('noPeers');

      torrent.simulateWire();
      expect(await stateOf()).toBe('connecting');
    });
  });

  describe('a torrent that fails', () => {
    beforeEach(async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      client.torrents[0].simulateError(new Error('disk full'));
    });

    it('stays listed with its error after WebTorrent drops it', async () => {
      expect(client.torrents).toEqual([]);

      const list = await request(app).get('/api/torrents');
      const one = await request(app).get(`/api/torrents/${HASH}`);

      expect(list.body).toEqual([
        expect.objectContaining({ infoHash: HASH, state: 'error', errorMessage: 'disk full' }),
      ]);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        infoHash: HASH,
        state: 'error',
        files: null,
        mainFile: null,
        videos: null,
      });
    });

    it('can be deleted', async () => {
      const res = await request(app).delete(`/api/torrents/${HASH}`);

      expect(res.status).toBe(204);
      expect((await request(app).get('/api/torrents')).body).toEqual([]);
      expect((await request(app).delete(`/api/torrents/${HASH}`)).status).toBe(404);
    });

    it('can be added again, which replaces the error', async () => {
      const res = await request(app).post('/api/torrents').send({ magnet: MAGNET });

      expect(res.status).toBe(201);
      const list = await request(app).get('/api/torrents');
      expect(list.body).toEqual([expect.objectContaining({ infoHash: HASH, state: 'connecting' })]);
    });
  });

  describe('GET /:infoHash', () => {
    const SINTEL_FILES = [
      { name: 'Sintel.mp4', path: 'Sintel/Sintel.mp4', length: 129241752 },
      { name: 'Sintel.en.srt', path: 'Sintel/Sintel.en.srt', length: 1652 },
      { name: 'poster.jpg', path: 'Sintel/poster.jpg', length: 46115 },
    ];

    beforeEach(async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
    });

    it('reports pending metadata for a new magnet link', async () => {
      const res = await request(app).get(`/api/torrents/${HASH}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        infoHash: HASH,
        hasMetadata: false,
        ready: false,
        length: null,
        files: null,
        mainFile: null,
        videos: null,
      });
    });

    it('lists files and sizes once the metadata arrives', async () => {
      client.torrents[0].simulateMetadata({ name: 'Sintel', files: SINTEL_FILES });

      const res = await request(app).get(`/api/torrents/${HASH.toUpperCase()}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Sintel',
        hasMetadata: true,
        ready: true,
        length: 129241752 + 1652 + 46115,
      });
      expect(res.body.files).toEqual([
        {
          index: 0,
          name: 'Sintel.mp4',
          path: 'Sintel/Sintel.mp4',
          length: 129241752,
          media: 'video',
          sample: false,
        },
        {
          index: 1,
          name: 'Sintel.en.srt',
          path: 'Sintel/Sintel.en.srt',
          length: 1652,
          media: 'subtitle',
          sample: false,
        },
        {
          index: 2,
          name: 'poster.jpg',
          path: 'Sintel/poster.jpg',
          length: 46115,
          media: 'other',
          sample: false,
        },
      ]);
      expect(res.body).toMatchObject({ mainFile: 0, videos: [0] });
    });

    it('picks the video of a single-file torrent', async () => {
      client.torrents[0].simulateMetadata({
        name: 'bunny.mp4',
        files: [{ name: 'bunny.mp4', path: 'bunny.mp4', length: 1000 }],
      });

      const res = await request(app).get(`/api/torrents/${HASH}`);

      expect(res.body.files).toEqual([
        {
          index: 0,
          name: 'bunny.mp4',
          path: 'bunny.mp4',
          length: 1000,
          media: 'video',
          sample: false,
        },
      ]);
      expect(res.body).toMatchObject({ mainFile: 0, videos: [0] });
    });

    // Decision #3: the .mkv is listed as "may not play", and the full-length
    // .mp4 encode is the main file. Videos sort numerically (720p before
    // 1080p), with the sample last.
    it('classifies each file of a multi-file torrent and picks the main one', async () => {
      client.torrents[0].simulateMetadata({
        name: 'Film',
        files: [
          { name: 'Film.1080p.MKV', path: 'Film/Film.1080p.MKV', length: 2000 },
          { name: 'Film.en.srt', path: 'Film/Film.en.srt', length: 50 },
          { name: 'film-sample.mkv', path: 'Film/Sample/film-sample.mkv', length: 40 },
          { name: 'Film.720p.mp4', path: 'Film/Film.720p.mp4', length: 1100 },
        ],
      });

      const res = await request(app).get(`/api/torrents/${HASH}`);

      const files: TorrentFileInfo[] = res.body.files;
      expect(files.map(({ index, media, sample }) => ({ index, media, sample }))).toEqual([
        { index: 0, media: 'video-may-not-play', sample: false },
        { index: 1, media: 'subtitle', sample: false },
        { index: 2, media: 'video-may-not-play', sample: true },
        { index: 3, media: 'video', sample: false },
      ]);
      expect(res.body.mainFile).toBe(3);
      expect(res.body.videos).toEqual([3, 0, 2]);
    });

    it('reports no main file for a torrent without video', async () => {
      client.torrents[0].simulateMetadata({
        name: 'Album',
        files: [
          { name: '01.flac', path: 'Album/01.flac', length: 3000 },
          { name: 'cover.jpg', path: 'Album/cover.jpg', length: 100 },
        ],
      });

      const res = await request(app).get(`/api/torrents/${HASH}`);

      const files: TorrentFileInfo[] = res.body.files;
      expect(files.map((file) => file.media)).toEqual(['other', 'other']);
      expect(res.body).toMatchObject({ mainFile: null, videos: [] });
    });

    it('lists files while existing data is still being verified', async () => {
      client.torrents[0].simulateMetadata({ name: 'Sintel', files: SINTEL_FILES, ready: false });

      const res = await request(app).get(`/api/torrents/${HASH}`);

      expect(res.body).toMatchObject({ hasMetadata: true, ready: false });
      expect(res.body.files).toHaveLength(3);
    });

    // The API reports parse-torrent's paths and WebTorrent stores files under
    // them, so this guards against an upgrade that stops normalising them.
    it('relies on parse-torrent keeping hostile paths inside the download dir', async () => {
      const info = {
        name: '..',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        files: [
          { path: ['..', '..', 'etc', 'evil'], length: 10 },
          { path: ['/abs'], length: 5 },
        ],
      };
      const parsed = await parseTorrent(toTorrentFile({ info } as unknown as ParsedTorrent));

      expect(parsed.files?.map((file) => file.path)).toEqual(['etc/evil', 'abs']);
    });

    it('returns 404 for a torrent that was never added', async () => {
      const res = await request(app).get(`/api/torrents/${'f'.repeat(40)}`);

      expect(res.status).toBe(404);
    });

    it('returns 400 for something that is not an info hash', async () => {
      const res = await request(app).get('/api/torrents/not-a-hash');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /events', () => {
    let server: Server;
    let baseUrl: string;
    let controller: AbortController;

    // Reads one server-sent event, skipping keep-alive comments.
    async function readEvent(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      buffer: { text: string },
    ): Promise<{ event: string; data: unknown }> {
      const decoder = new TextDecoder();
      for (;;) {
        const end = buffer.text.indexOf('\n\n');
        if (end !== -1) {
          const block = buffer.text.slice(0, end);
          buffer.text = buffer.text.slice(end + 2);
          if (block.startsWith(':')) continue;
          const field = (name: string) =>
            block
              .split('\n')
              .find((line) => line.startsWith(`${name}: `))
              ?.slice(name.length + 2) ?? '';
          return { event: field('event'), data: JSON.parse(field('data')) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer.text += decoder.decode(value, { stream: true });
      }
    }

    beforeEach(async () => {
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      controller = new AbortController();
    });

    afterEach(async () => {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it('streams the torrent list now and again when it changes', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });

      const res = await fetch(`${baseUrl}/api/torrents/events`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      const reader = res.body!.getReader();
      const buffer = { text: '' };

      const first = await readEvent(reader, buffer);
      expect(first.event).toBe('torrents');
      expect(first.data).toEqual([
        expect.objectContaining({ infoHash: HASH, state: 'connecting' }),
      ]);

      client.torrents[0].simulateNoPeers();
      const second = await readEvent(reader, buffer);
      expect(second.data).toEqual([expect.objectContaining({ infoHash: HASH, state: 'noPeers' })]);
    });

    it('lets the server close while a stream is open', async () => {
      const res = await fetch(`${baseUrl}/api/torrents/events`, { signal: controller.signal });
      await readEvent(res.body!.getReader(), { text: '' });

      // What server/index.ts does on SIGINT.
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();

      await expect(closed).resolves.toBeUndefined();
    });

    it('unsubscribes when the client goes away', async () => {
      const subscribe = vi.spyOn(EventStream.prototype, 'subscribe');
      const res = await fetch(`${baseUrl}/api/torrents/events`, { signal: controller.signal });
      await readEvent(res.body!.getReader(), { text: '' });
      const stream = subscribe.mock.contexts[0] as EventStream;
      expect(stream.size).toBe(1);

      controller.abort();

      await vi.waitFor(() => expect(stream.size).toBe(0));
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
