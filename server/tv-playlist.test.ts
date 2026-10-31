import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { createApp } from './app.js';
import { m3u } from './tv-playlist.js';

const FILM = '08ada5a7a6183aae1e09d831df6748d566095a10';
const SHOW = 'c9e15763f722f23e98a29decdfae341b98d53056';
const PENDING = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const MB = 1024 * 1024;

describe('m3u', () => {
  it('names each entry on its own #EXTINF line', () => {
    expect(
      m3u([
        { title: 'Sintel', url: 'http://192.168.1.20:1234/a' },
        { title: 'Two\r\nlines', url: 'http://192.168.1.20:1234/b' },
      ]),
    ).toBe(
      '#EXTM3U\n' +
        '#EXTINF:-1,Sintel\nhttp://192.168.1.20:1234/a\n' +
        '#EXTINF:-1,Two lines\nhttp://192.168.1.20:1234/b\n',
    );
  });

  it('is just the header with nothing to play', () => {
    expect(m3u([])).toBe('#EXTM3U\n');
  });
});

describe('TV playlist routes', () => {
  let client: FakeWebTorrent;
  let addresses: string[];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    client = new FakeWebTorrent();
    addresses = ['192.168.1.20'];
    app = createApp({
      client: client as unknown as WebTorrent,
      downloadDir: join(tmpdir(), 'stream-tv-test'),
      lanAddresses: () => addresses,
    });
  });

  // supertest only buffers text/* bodies as text by itself.
  const getPlaylist = (host: string) =>
    request(app)
      .get('/tv.m3u')
      .set('Host', host)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => done(null, text));
      });

  function addTorrents(): void {
    // A film with a sample clip and subtitles, a season of two episodes, and
    // a magnet link still fetching its metadata.
    client.add(`magnet:?xt=urn:btih:${FILM}`).simulateMetadata({
      name: 'Sintel',
      files: [
        { name: 'Sintel.mkv', path: 'Sintel/Sintel.mkv', length: 700 * MB },
        { name: 'Sintel.en.srt', path: 'Sintel/Sintel.en.srt', length: 50 },
        {
          name: 'sample.mkv',
          path: 'Sintel/Sample/sample.mkv',
          length: 10 * MB,
        },
      ],
    });
    client.add(`magnet:?xt=urn:btih:${SHOW}`).simulateMetadata({
      name: 'Show S01',
      files: [
        { name: 'Show.E02.mp4', path: 'Show S01/Show.E02.mp4', length: MB },
        { name: 'Show.E01.mp4', path: 'Show S01/Show.E01.mp4', length: MB },
      ],
    });
    client.add(`magnet:?xt=urn:btih:${PENDING}`);
  }

  it('lists every video by name with LAN stream URLs', async () => {
    addTorrents();

    const res = await getPlaylist('192.168.1.20:1234');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/x-mpegurl; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(
      '#EXTM3U\n' +
        `#EXTINF:-1,Sintel\nhttp://192.168.1.20:1234/api/torrents/${FILM}/files/0/stream?play\n` +
        `#EXTINF:-1,Show.E01\nhttp://192.168.1.20:1234/api/torrents/${SHOW}/files/1/stream?play\n` +
        `#EXTINF:-1,Show.E02\nhttp://192.168.1.20:1234/api/torrents/${SHOW}/files/0/stream?play\n`,
    );
  });

  it('keeps the host it was fetched on, such as a .local name', async () => {
    addTorrents();

    const res = await getPlaylist('studio.local:1234');

    expect(res.body).toContain(
      `http://studio.local:1234/api/torrents/${FILM}/files/0/stream?play`,
    );
  });

  it('uses the LAN address rather than localhost', async () => {
    addTorrents();

    const res = await getPlaylist('localhost:5173');

    // The port the request reached, not the one in Host: in development
    // that is Vite's, which VLC shouldn't depend on.
    expect(res.body).toMatch(
      new RegExp(
        `^http://192\\.168\\.1\\.20:\\d+/api/torrents/${FILM}/files/0/stream\\?play$`,
        'm',
      ),
    );
    expect(res.body).not.toContain('localhost');
  });

  it('falls back to localhost with no network', async () => {
    addresses = [];
    addTorrents();

    const res = await getPlaylist('127.0.0.1:1234');

    expect(res.body).toContain(
      `http://127.0.0.1:1234/api/torrents/${FILM}/files/0/stream?play`,
    );
  });

  it('answers 400 for a Host it cannot use', async () => {
    addresses = [];

    const res = await getPlaylist('a b');

    expect(res.status).toBe(400);
  });

  it('lists no entries without torrents', async () => {
    const res = await getPlaylist('192.168.1.20:1234');

    expect(res.body).toBe('#EXTM3U\n');
  });

  it('gives the playlist address on each LAN address', async () => {
    addresses = ['192.168.1.20', '10.0.0.5'];

    const res = await request(app).get('/api/tv').set('Host', '[::1]:1234');

    expect(res.status).toBe(200);
    expect(res.body.playlistUrls).toHaveLength(2);
    expect(res.body.playlistUrls[0]).toMatch(
      /^http:\/\/192\.168\.1\.20:\d+\/tv\.m3u$/,
    );
    expect(res.body.playlistUrls[1]).toMatch(
      /^http:\/\/10\.0\.0\.5:\d+\/tv\.m3u$/,
    );
  });

  it('gives the address the page was opened on from another device', async () => {
    const res = await request(app)
      .get('/api/tv')
      .set('Host', '192.168.1.20:1234');

    expect(res.body).toEqual({
      playlistUrls: ['http://192.168.1.20:1234/tv.m3u'],
      dlnaName: null,
      dlnaOn: false,
    });
  });

  it('gives the DLNA server’s name when it is on', async () => {
    const withDlna = createApp({
      client: client as unknown as WebTorrent,
      downloadDir: join(tmpdir(), 'stream-tv-test'),
      lanAddresses: () => addresses,
      dlna: {
        uuid: '4f7ad604-67ef-5958-a706-c60b14eadd08',
        name: 'stream on studio',
      },
    });

    const res = await request(withDlna)
      .get('/api/tv')
      .set('Host', '192.168.1.20:1234');

    expect(res.body.dlnaName).toBe('stream on studio');
    expect(res.body.dlnaOn).toBe(true);
  });
});
