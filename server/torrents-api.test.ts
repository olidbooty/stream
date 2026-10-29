import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express, { type Express } from 'express';
import parseTorrent, {
  type Instance as ParsedTorrent,
  toTorrentFile,
} from 'parse-torrent';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import {
  type FakeFileOptions,
  FakeWebTorrent,
  fakeFileBytes,
} from '../test/mocks/webtorrent.js';
import { EventStream } from './event-stream.js';
import { MAX_SUBTITLE_BYTES } from './subtitles.js';
import {
  MAX_EVENT_STREAMS,
  MAX_TORRENT_FILE_BYTES,
  type TorrentFileInfo,
  torrentsRouter,
} from './torrents-api.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`;
const DOWNLOAD_DIR = '/srv/downloads';

// A minimal single-file .torrent. Its info hash is the SHA-1 of the info dict.
function torrentFile(
  name = 'bunny.mp4',
  sources: { announce?: string[]; urlList?: string[] } = {},
): Buffer {
  const info = {
    name,
    length: 1000,
    'piece length': 16384,
    pieces: new Uint8Array(20),
  };
  return Buffer.from(
    toTorrentFile({ info, ...sources } as unknown as ParsedTorrent),
  );
}

describe('/api/torrents', () => {
  let client: FakeWebTorrent;
  let app: Express;

  beforeEach(() => {
    client = new FakeWebTorrent();
    app = express();
    app.use(
      '/api/torrents',
      torrentsRouter({
        client: client as unknown as WebTorrent,
        downloadDir: DOWNLOAD_DIR,
      }),
    );
  });

  afterEach(() => {
    FakeWebTorrent.reset();
    vi.restoreAllMocks();
  });

  describe('POST with a magnet link', () => {
    it('adds the torrent to the download directory', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .send({ magnet: MAGNET });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/api/torrents/${HASH}`);
      expect(res.body).toMatchObject({
        infoHash: HASH,
        ready: false,
        progress: 0,
      });
      expect(res.body.magnetURI).toContain(HASH);
      expect(client.torrents).toHaveLength(1);
      expect(client.torrents[0]).toMatchObject({
        infoHash: HASH,
        path: DOWNLOAD_DIR,
        destroyStoreOnDestroy: true,
      });
    });

    it('drops xs= and trackers and web seeds on local addresses', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const magnet =
        `${MAGNET}&tr=udp%3A%2F%2Ftracker.example.com%3A1337` +
        '&tr=http%3A%2F%2F192.168.1.1%2Fannounce' +
        '&ws=http%3A%2F%2Flocalhost%3A3000%2F' +
        '&xs=http%3A%2F%2F10.0.0.5%2Fx.torrent';

      const res = await request(app).post('/api/torrents').send({ magnet });

      expect(res.status).toBe(201);
      const added = client.torrents[0].torrentId as ParsedTorrent;
      expect(added).not.toHaveProperty('xs');
      expect(added.announce).toEqual(['udp://tracker.example.com:1337']);
      expect(added.urlList).toEqual([]);
      expect(res.body.magnetURI).not.toMatch(/192\.168|localhost|10\.0\.0\.5/);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(HASH),
        'http://10.0.0.5/x.torrent, http://192.168.1.1/announce, http://localhost:3000/',
      );
    });

    it('accepts an upper-case or base32 info hash', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .send({
          magnet: `magnet:?xt=urn:btih:${'AERUKZ4JVPGW66CKAERUKZ4JVPGW66CK'}`,
        });

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

    it('drops trackers and web seeds on local addresses', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await request(app)
        .post('/api/torrents')
        .set('Content-Type', 'application/x-bittorrent')
        .send(
          torrentFile('bunny.mp4', {
            announce: ['http://127.0.0.1:9000/announce', 'udp://t.example:80'],
            urlList: ['http://[::1]/files/', 'https://cdn.example.com/'],
          }),
        );

      const added = client.torrents[0].torrentId as ParsedTorrent;
      expect(added.announce).toEqual(['udp://t.example:80']);
      expect(added.urlList).toEqual(['https://cdn.example.com/']);
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
    const res = await request(app)
      .post('/api/torrents')
      .type('text/plain')
      .send(MAGNET);

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
      torrent.simulateMetadata({
        name: 'Sintel',
        files: [{ name: 'sintel.mp4', length: 1000 }],
      });
      torrent.simulateFileDownload(0, 250);
      torrent.simulateDownload(0, { downloadSpeed: 500, numPeers: 3 });

      const res = await request(app).get('/api/torrents');

      expect(res.body).toEqual([
        {
          infoHash: HASH,
          name: 'Sintel',
          magnetURI: torrent.magnetURI,
          hasMetadata: true,
          ready: true,
          length: 1000,
          selectedLength: 1000,
          progress: 0.25,
          mainFile: 0,
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
    const stateOf = async () =>
      (await request(app).get(`/api/torrents/${HASH}`)).body.state;

    beforeEach(async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
    });

    it('goes from connecting to downloading to seeding', async () => {
      const torrent = client.torrents[0];
      expect(await stateOf()).toBe('connecting');

      torrent.simulateWire();
      expect(await stateOf()).toBe('connecting');

      torrent.simulateMetadata({
        name: 'Sintel',
        files: [{ name: 'sintel.mp4', length: 1000 }],
      });
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
        expect.objectContaining({
          infoHash: HASH,
          state: 'error',
          errorMessage: 'disk full',
        }),
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
      expect((await request(app).delete(`/api/torrents/${HASH}`)).status).toBe(
        404,
      );
    });

    it('can be added again, which replaces the error', async () => {
      const res = await request(app)
        .post('/api/torrents')
        .send({ magnet: MAGNET });

      expect(res.status).toBe(201);
      const list = await request(app).get('/api/torrents');
      expect(list.body).toEqual([
        expect.objectContaining({ infoHash: HASH, state: 'connecting' }),
      ]);
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
      client.torrents[0].simulateMetadata({
        name: 'Sintel',
        files: SINTEL_FILES,
      });

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
          selected: true,
          media: 'video',
          sample: false,
          subtitles: [{ index: 1, language: 'en' }],
        },
        {
          index: 1,
          name: 'Sintel.en.srt',
          path: 'Sintel/Sintel.en.srt',
          length: 1652,
          selected: true,
          media: 'subtitle',
          sample: false,
          subtitles: [],
        },
        {
          index: 2,
          name: 'poster.jpg',
          path: 'Sintel/poster.jpg',
          length: 46115,
          selected: false,
          media: 'other',
          sample: false,
          subtitles: [],
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
          selected: true,
          media: 'video',
          sample: false,
          subtitles: [],
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
          {
            name: 'film-sample.mkv',
            path: 'Film/Sample/film-sample.mkv',
            length: 40,
          },
          { name: 'Film.720p.mp4', path: 'Film/Film.720p.mp4', length: 1100 },
        ],
      });

      const res = await request(app).get(`/api/torrents/${HASH}`);

      const files: TorrentFileInfo[] = res.body.files;
      expect(
        files.map(({ index, media, sample }) => ({ index, media, sample })),
      ).toEqual([
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
      client.torrents[0].simulateMetadata({
        name: 'Sintel',
        files: SINTEL_FILES,
        ready: false,
      });

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
      const parsed = await parseTorrent(
        toTorrentFile({ info } as unknown as ParsedTorrent),
      );

      expect(parsed.files?.map((file) => file.path)).toEqual([
        'etc/evil',
        'abs',
      ]);
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

      const res = await fetch(`${baseUrl}/api/torrents/events`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(
        'text/event-stream; charset=utf-8',
      );
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
      expect(second.data).toEqual([
        expect.objectContaining({ infoHash: HASH, state: 'noPeers' }),
      ]);
    });

    it('lets the server close while a stream is open', async () => {
      const res = await fetch(`${baseUrl}/api/torrents/events`, {
        signal: controller.signal,
      });
      await readEvent(res.body!.getReader(), { text: '' });

      // What server/index.ts does on SIGINT.
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();

      await expect(closed).resolves.toBeUndefined();
    });

    it('unsubscribes when the client goes away', async () => {
      const subscribe = vi.spyOn(EventStream.prototype, 'subscribe');
      const res = await fetch(`${baseUrl}/api/torrents/events`, {
        signal: controller.signal,
      });
      await readEvent(res.body!.getReader(), { text: '' });
      const stream = subscribe.mock.contexts[0] as EventStream;
      expect(stream.size).toBe(1);

      controller.abort();

      await vi.waitFor(() => expect(stream.size).toBe(0));
    });

    it('allows 32 open streams by default', () => {
      expect(MAX_EVENT_STREAMS).toBe(32);
    });

    describe('at the stream limit', () => {
      let limited: Server;
      let limitedUrl: string;

      beforeEach(async () => {
        const capped = express();
        capped.use(
          '/api/torrents',
          torrentsRouter({
            client: client as unknown as WebTorrent,
            downloadDir: DOWNLOAD_DIR,
            maxEventStreams: 2,
          }),
        );
        limited = capped.listen(0, '127.0.0.1');
        await once(limited, 'listening');
        limitedUrl = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/torrents/events`;
      });

      afterEach(async () => {
        limited.closeAllConnections();
        await new Promise((resolve) => limited.close(resolve));
      });

      it('answers 503 with Retry-After until a stream closes', async () => {
        const first = new AbortController();
        const second = new AbortController();
        for (const signal of [first.signal, second.signal]) {
          const res = await fetch(limitedUrl, { signal });
          await readEvent(res.body!.getReader(), { text: '' });
        }

        const refused = await fetch(limitedUrl, { signal: controller.signal });
        expect(refused.status).toBe(503);
        expect(refused.headers.get('retry-after')).toBe('10');
        expect(await refused.json()).toEqual({
          error: 'Too many open event streams',
        });

        first.abort();
        await vi.waitFor(async () => {
          const res = await fetch(limitedUrl, { signal: controller.signal });
          expect(res.status).toBe(200);
        });
        second.abort();
      });
    });
  });

  describe('GET /:infoHash/files/:index/stream', () => {
    const LENGTH = 100_000;
    const STREAM = `/api/torrents/${HASH}/files/0/stream`;

    async function addWithFiles(files: FakeFileOptions[]) {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      const torrent = client.torrents[0];
      torrent.simulateMetadata({ name: 'Sintel', files });
      return torrent;
    }

    // supertest only buffers text and JSON by default.
    function get(path: string, range?: string) {
      const req = request(app)
        .get(path)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      return range === undefined ? req : req.set('Range', range);
    }

    it('sends the whole file without a Range header', async () => {
      await addWithFiles([{ name: 'Sintel.mp4', length: LENGTH }]);

      const res = await get(STREAM);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(LENGTH));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body).toEqual(fakeFileBytes(0, LENGTH));
    });

    it('sends the requested range with 206', async () => {
      const torrent = await addWithFiles([
        { name: 'Sintel.mp4', length: LENGTH },
      ]);

      const res = await get(STREAM, 'bytes=40000-49999');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 40000-49999/${LENGTH}`);
      expect(res.headers['content-length']).toBe('10000');
      expect(res.body).toEqual(fakeFileBytes(40000, 50000));
      // Only that range is read, so WebTorrent prioritises its pieces.
      expect(torrent.files[0].readStreams).toMatchObject([
        { start: 40000, end: 49999 },
      ]);
    });

    it('sends open-ended and suffix ranges', async () => {
      await addWithFiles([{ name: 'Sintel.mp4', length: LENGTH }]);

      const from = await get(STREAM, 'bytes=99000-');
      const last = await get(STREAM, 'bytes=-500');

      expect(from.status).toBe(206);
      expect(from.headers['content-range']).toBe(`bytes 99000-99999/${LENGTH}`);
      expect(from.body).toEqual(fakeFileBytes(99000, LENGTH));
      expect(last.status).toBe(206);
      expect(last.headers['content-range']).toBe(`bytes 99500-99999/${LENGTH}`);
      expect(last.body).toEqual(fakeFileBytes(99500, LENGTH));
    });

    it('sends only the first byte for bytes=0-0', async () => {
      const torrent = await addWithFiles([
        { name: 'Sintel.mp4', length: LENGTH },
      ]);

      const res = await get(STREAM, 'bytes=0-0');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-0/${LENGTH}`);
      expect(res.body).toEqual(fakeFileBytes(0, 1));
      // WebTorrent streams the whole file for end: 0, so the route stops it.
      expect(torrent.files[0].readStreams[0].stream.destroyed).toBe(true);
    });

    it('returns 416 for a range past the end of the file', async () => {
      const torrent = await addWithFiles([
        { name: 'Sintel.mp4', length: LENGTH },
      ]);

      const res = await get(STREAM, `bytes=${LENGTH}-`);

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${LENGTH}`);
      expect(torrent.files[0].readStreams).toEqual([]);
    });

    it.each([
      ['malformed', 'bytes=abc'],
      ['several', 'bytes=0-9, 500-599'],
      ['not in bytes', 'items=0-9'],
    ])('sends the whole file for %s ranges', async (_kind, range) => {
      await addWithFiles([{ name: 'Sintel.mp4', length: LENGTH }]);

      const res = await get(STREAM, range);

      expect(res.status).toBe(200);
      expect(res.headers['content-range']).toBeUndefined();
      expect(res.body).toHaveLength(LENGTH);
    });

    it('answers HEAD without reading the file', async () => {
      const torrent = await addWithFiles([
        { name: 'Sintel.mp4', length: LENGTH },
      ]);

      const res = await request(app).head(STREAM).set('Range', 'bytes=0-99');

      expect(res.status).toBe(206);
      expect(res.headers['content-length']).toBe('100');
      expect(res.headers['content-range']).toBe(`bytes 0-99/${LENGTH}`);
      expect(torrent.files[0].readStreams).toEqual([]);
    });

    it('sends an empty file without reading it', async () => {
      const torrent = await addWithFiles([{ name: 'empty.mp4', length: 0 }]);

      const res = await get(STREAM);

      expect(res.status).toBe(200);
      expect(res.headers['content-length']).toBe('0');
      expect(torrent.files[0].readStreams).toEqual([]);
    });

    it('serves subtitles and audio inline', async () => {
      await addWithFiles([
        { name: 'Sintel.mp4', length: LENGTH },
        { name: 'Sintel.en.vtt', length: 100 },
        { name: 'score.mp3', length: 100 },
      ]);

      const vtt = await get(`/api/torrents/${HASH}/files/1/stream`);
      const mp3 = await get(`/api/torrents/${HASH}/files/2/stream`);

      expect(vtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(vtt.headers['content-disposition']).toBeUndefined();
      expect(mp3.headers['content-type']).toBe('audio/mpeg');
    });

    it('sends other files as downloads, so they cannot run script', async () => {
      await addWithFiles([{ name: 'index.html', length: 100 }]);

      const res = await get(STREAM);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename=index.html',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns 409 while the metadata is pending', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });

      const res = await request(app).get(STREAM);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/still being fetched/);
    });

    it('streams before WebTorrent has checked existing data', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      client.torrents[0].simulateMetadata({
        files: [{ name: 'Sintel.mp4', length: 100 }],
        ready: false,
      });

      const res = await get(STREAM, 'bytes=0-9');

      expect(res.status).toBe(206);
      expect(res.body).toEqual(fakeFileBytes(0, 10));
    });

    it('returns 409 for a failed torrent', async () => {
      const torrent = await addWithFiles([
        { name: 'Sintel.mp4', length: LENGTH },
      ]);
      torrent.simulateError(new Error('disk full'));

      const res = await request(app).get(STREAM);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/failed/);
    });

    it('returns 404 for an unknown torrent or file', async () => {
      const torrent = await request(app).get(STREAM);
      await addWithFiles([{ name: 'Sintel.mp4', length: LENGTH }]);
      const file = await request(app).get(
        `/api/torrents/${HASH}/files/1/stream`,
      );

      expect(torrent.status).toBe(404);
      expect(file.status).toBe(404);
      expect(file.body).toEqual({ error: 'No file with that index' });
    });

    it.each(['abc', '-1', '01', '1.5', '9999999999'])(
      'returns 400 for the file index %s',
      async (index) => {
        await addWithFiles([{ name: 'Sintel.mp4', length: LENGTH }]);

        const res = await request(app).get(
          `/api/torrents/${HASH}/files/${index}/stream`,
        );

        expect(res.status).toBe(400);
      },
    );

    describe('over a connection', () => {
      let server: Server;
      let baseUrl: string;

      beforeEach(async () => {
        server = app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      });

      afterEach(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });

      // Only the first 1000 bytes have "arrived", so the stream then waits.
      async function startStream(signal?: AbortSignal) {
        const torrent = await addWithFiles([
          { name: 'Sintel.mp4', length: LENGTH, available: 1000 },
        ]);
        const res = await fetch(`${baseUrl}${STREAM}`, { signal });
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        expect(value?.length).toBeGreaterThan(0);
        return { reader, file: torrent.files[0] };
      }

      it('destroys the read stream when the browser hangs up', async () => {
        const controller = new AbortController();
        const { file } = await startStream(controller.signal);
        expect(file.readStreams[0].stream.destroyed).toBe(false);

        controller.abort();

        await vi.waitFor(() =>
          expect(file.readStreams[0].stream.destroyed).toBe(true),
        );
      });

      it('drops the connection if the stream stops short', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { reader, file } = await startStream();

        // As when the torrent is removed mid-stream.
        file.readStreams[0].stream.destroy(new Error('torrent removed'));

        await expect(
          (async () => {
            for (;;) if ((await reader.read()).done) return;
          })(),
        ).rejects.toThrow();
      });
    });
  });

  // Decisions #18 and #23.
  describe('selection', () => {
    const SEASON = [
      { name: 'Episode 1.mp4', path: 'Show/Episode 1.mp4', length: 1000 },
      { name: 'Episode 1.en.srt', path: 'Show/Episode 1.en.srt', length: 10 },
      { name: 'Episode 2.mp4', path: 'Show/Episode 2.mp4', length: 1000 },
      { name: 'Episode 2.en.srt', path: 'Show/Episode 2.en.srt', length: 10 },
      { name: 'poster.jpg', path: 'Show/poster.jpg', length: 100 },
    ];
    const selectedFiles = () =>
      client.torrents[0].files.map((file) => file.selected);
    const detail = async () =>
      (await request(app).get(`/api/torrents/${HASH}`)).body;

    beforeEach(async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
    });

    it('downloads only the main video and its subtitles', async () => {
      const torrent = client.torrents[0];
      expect(torrent.deselect).toBe(true);
      expect((await detail()).selectedLength).toBeNull();

      torrent.simulateMetadata({ name: 'Show', files: SEASON });

      expect(selectedFiles()).toEqual([true, true, false, false, false]);
      const body = await detail();
      expect(body.selectedLength).toBe(1010);
      expect(body.length).toBe(2120);
      expect(body.files.map((file: TorrentFileInfo) => file.selected)).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
    });

    it('measures progress over the selection and seeds once it is done', async () => {
      const torrent = client.torrents[0];
      torrent.simulateMetadata({ name: 'Show', files: SEASON });
      torrent.simulateWire();

      torrent.simulateFileDownload(0, 505);
      expect(await detail()).toMatchObject({
        progress: 0.5,
        state: 'downloading',
      });

      torrent.simulateFileDownload(0, 495);
      torrent.simulateFileDownload(1, 10);
      expect(torrent.done).toBe(false);
      expect(await detail()).toMatchObject({ progress: 1, state: 'seeding' });
    });

    it('selects a video streamed with ?play, as the TV playlist does', async () => {
      const torrent = client.torrents[0];
      torrent.simulateMetadata({ name: 'Show', files: SEASON });

      const plain = await request(app)
        .get(`/api/torrents/${HASH}/files/2/stream`)
        .set('Range', 'bytes=0-9');
      expect(plain.status).toBe(206);
      expect(selectedFiles()).toEqual([true, true, false, false, false]);

      const head = await request(app).head(
        `/api/torrents/${HASH}/files/2/stream?play`,
      );
      expect(head.status).toBe(200);
      expect(selectedFiles()).toEqual([true, true, false, false, false]);

      const played = await request(app)
        .get(`/api/torrents/${HASH}/files/2/stream?play`)
        .set('Range', 'bytes=0-9');
      expect(played.status).toBe(206);
      expect(selectedFiles()).toEqual([true, true, true, true, false]);
    });

    it('resumes a paused torrent streamed with ?play', async () => {
      const torrent = client.torrents[0];
      torrent.simulateMetadata({ name: 'Show', files: SEASON });
      await request(app).post(`/api/torrents/${HASH}/pause`);

      await request(app)
        .get(`/api/torrents/${HASH}/files/4/stream?play`)
        .set('Range', 'bytes=0-9');
      expect(torrent.paused).toBe(true);

      await request(app)
        .get(`/api/torrents/${HASH}/files/0/stream?play`)
        .set('Range', 'bytes=0-9');
      expect(torrent.paused).toBe(false);
    });

    it('downloads everything in a torrent with no video', async () => {
      client.torrents[0].simulateMetadata({
        name: 'Album',
        files: [
          { name: '01.flac', length: 100 },
          { name: 'cover.jpg', length: 10 },
        ],
      });

      expect(selectedFiles()).toEqual([true, true]);
      expect((await detail()).selectedLength).toBe(110);
    });

    it('selects another video and its subtitles, keeping the first', async () => {
      client.torrents[0].simulateMetadata({ name: 'Show', files: SEASON });

      const res = await request(app).post(
        `/api/torrents/${HASH}/files/2/select`,
      );

      expect(res.status).toBe(204);
      expect(selectedFiles()).toEqual([true, true, true, true, false]);
      expect((await detail()).selectedLength).toBe(2020);
    });

    it('selects only videos', async () => {
      client.torrents[0].simulateMetadata({ name: 'Show', files: SEASON });

      const subtitle = await request(app).post(
        `/api/torrents/${HASH}/files/3/select`,
      );
      const missing = await request(app).post(
        `/api/torrents/${HASH}/files/9/select`,
      );

      expect(subtitle.status).toBe(400);
      expect(subtitle.body).toEqual({ error: 'Only a video can be selected' });
      expect(missing.status).toBe(404);
      expect(selectedFiles()).toEqual([true, true, false, false, false]);
    });

    it('returns 409 until the file list is known', async () => {
      const res = await request(app).post(
        `/api/torrents/${HASH}/files/0/select`,
      );

      expect(res.status).toBe(409);
    });
  });

  // Decision #20.
  describe('GET /:infoHash/files/:index/subtitles.vtt', () => {
    const SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n';

    async function addSubtitles(
      files: (FakeFileOptions & { content?: Buffer })[],
    ) {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      const torrent = client.torrents[0];
      torrent.simulateMetadata({ name: 'Sintel', files });
      // Serve each file's own content rather than the fake's byte pattern.
      files.forEach(({ content }, index) => {
        if (!content) return;
        torrent.files[index].createReadStream = () =>
          Readable.from([content]) as never;
      });
      return torrent;
    }

    it('converts a .srt file to WebVTT', async () => {
      await addSubtitles([
        { name: 'Sintel.mp4', length: 1000 },
        {
          name: 'Sintel.en.srt',
          length: SRT.length,
          content: Buffer.from(SRT),
        },
      ]);

      const res = await request(app).get(
        `/api/torrents/${HASH}/files/1/subtitles.vtt`,
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(res.text).toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n',
      );
    });

    it('serves a .vtt file as is', async () => {
      const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n';
      await addSubtitles([
        { name: 'Sintel.vtt', length: vtt.length, content: Buffer.from(vtt) },
      ]);

      const res = await request(app).get(
        `/api/torrents/${HASH}/files/0/subtitles.vtt`,
      );

      expect(res.text).toBe(vtt);
    });

    it('refuses files that are not subtitles, or too large', async () => {
      await addSubtitles([
        { name: 'Sintel.mp4', length: 1000 },
        { name: 'huge.srt', length: MAX_SUBTITLE_BYTES + 1 },
      ]);

      const video = await request(app).get(
        `/api/torrents/${HASH}/files/0/subtitles.vtt`,
      );
      const huge = await request(app).get(
        `/api/torrents/${HASH}/files/1/subtitles.vtt`,
      );

      expect(video.status).toBe(400);
      expect(huge.status).toBe(413);
    });

    it('waits for the pieces and stops reading when the request is dropped', async () => {
      const torrent = await addSubtitles([
        { name: 'Sintel.srt', length: 100, available: 10 },
      ]);
      const server = app.listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        const controller = new AbortController();
        const pending = fetch(
          `http://127.0.0.1:${port}/api/torrents/${HASH}/files/0/subtitles.vtt`,
          { signal: controller.signal },
        ).catch(() => 'aborted');
        await vi.waitFor(() =>
          expect(torrent.files[0].readStreams).toHaveLength(1),
        );
        controller.abort();
        expect(await pending).toBe('aborted');
        await vi.waitFor(() =>
          expect(torrent.files[0].readStreams[0].stream.destroyed).toBe(true),
        );
      } finally {
        server.close();
      }
    });
  });

  describe('POST /:infoHash/pause and /resume', () => {
    it('pauses and resumes a torrent', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      const torrent = client.torrents[0];
      torrent.simulateMetadata({
        files: [{ name: 'Sintel.mp4', length: 1000 }],
      });
      torrent.simulateWire();
      torrent.simulateDownload(100, { downloadSpeed: 500 });
      const summary = async () =>
        (await request(app).get(`/api/torrents/${HASH}`)).body;
      expect((await summary()).state).toBe('downloading');

      const paused = await request(app).post(`/api/torrents/${HASH}/pause`);
      expect(paused.status).toBe(204);
      expect(torrent.numPeers).toBe(0);
      expect(await summary()).toMatchObject({
        state: 'paused',
        downloadSpeed: 0,
        uploadSpeed: 0,
      });
      // Pausing twice is fine.
      expect(
        (await request(app).post(`/api/torrents/${HASH}/pause`)).status,
      ).toBe(204);

      const resumed = await request(app).post(`/api/torrents/${HASH}/resume`);
      expect(resumed.status).toBe(204);
      expect(torrent.paused).toBe(false);
      expect(torrent.addedPeers).toEqual(['127.0.0.1:6881']);
    });

    it('refuses a failed or unknown torrent', async () => {
      const unknown = await request(app).post(`/api/torrents/${HASH}/pause`);
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      client.torrents[0].simulateError(new Error('disk full'));
      const failed = await request(app).post(`/api/torrents/${HASH}/resume`);

      expect(unknown.status).toBe(404);
      expect(failed.status).toBe(409);
    });
  });

  describe('DELETE /:infoHash', () => {
    it('removes the torrent and deletes its files', async () => {
      await request(app).post('/api/torrents').send({ magnet: MAGNET });
      const torrent = client.torrents[0];

      const res = await request(app).delete(
        `/api/torrents/${HASH.toUpperCase()}`,
      );

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
