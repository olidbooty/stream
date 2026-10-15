import type { Express } from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('createApp', () => {
  let staticDir: string;
  let app: Express;

  beforeAll(() => {
    // A fixture directory keeps these tests independent of `npm run build`.
    staticDir = mkdtempSync(join(tmpdir(), 'stream-public-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>stream</title>');
    app = createApp({ staticDir });
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
});
