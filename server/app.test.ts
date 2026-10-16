import type { Express } from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type WebTorrent from 'webtorrent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { createApp } from './app.js';

describe('createApp', () => {
  let staticDir: string;
  let client: FakeWebTorrent;
  let app: Express;

  beforeAll(() => {
    // A fixture directory keeps these tests independent of `npm run build`.
    staticDir = mkdtempSync(join(tmpdir(), 'stream-public-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>stream</title>');
    client = new FakeWebTorrent();
    app = createApp({
      staticDir,
      downloadDir: join(staticDir, 'downloads'),
      client: client as unknown as WebTorrent,
    });
  });

  afterAll(() => {
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('serves index.html at /', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('<title>stream</title>');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
  });

  it('does not advertise Express', async () => {
    const res = await request(app).get('/');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  describe('GET /api/client', () => {
    it('reports a client that is not listening yet', async () => {
      const res = await request(app).get('/api/client');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        listening: false,
        peerPort: null,
        torrents: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
      });
    });

    it('reports the peer port and torrent count once listening', async () => {
      client.simulateListening(51413);
      const torrent = client.add('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
      torrent.simulateMetadata({ files: [{ name: 'bunny.mp4', length: 1000 }] });
      torrent.simulateDownload(100, { downloadSpeed: 2048 });

      const res = await request(app).get('/api/client');

      expect(res.body).toMatchObject({
        listening: true,
        peerPort: 51413,
        torrents: 1,
        downloadSpeed: 2048,
      });
    });
  });
});
