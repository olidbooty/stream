import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import type WebTorrent from 'webtorrent';
import { torrentsRouter } from './torrents-api.js';

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export interface AppOptions {
  // Passed in rather than created here, so tests can hand in FakeWebTorrent.
  client: WebTorrent;
  // Where added torrents store their files (DOWNLOAD_DIR).
  downloadDir: string;
  staticDir?: string;
}

// Build the Express app without binding a port, so tests can drive it with supertest.
export function createApp({
  client,
  downloadDir,
  staticDir = DEFAULT_STATIC_DIR,
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.static(staticDir));

  // Whether the torrent client is up and which peer port to forward (see 2.6).
  app.get('/api/client', (req, res) => {
    const address = client.address();
    res.json({
      listening: address !== null,
      peerPort: address && typeof address === 'object' ? address.port : null,
      torrents: client.torrents.length,
      downloadSpeed: client.downloadSpeed,
      uploadSpeed: client.uploadSpeed,
    });
  });

  app.use('/api/torrents', torrentsRouter({ client, downloadDir }));

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}
