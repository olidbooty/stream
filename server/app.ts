import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type WebTorrent from 'webtorrent';
import { DiskLimit } from './disk-limit.js';
import type { SavedTorrent, SavedTorrents } from './saved-torrents.js';
import { SettingsStore } from './settings.js';
import { settingsRouter } from './settings-api.js';
import { torrentsRouter } from './torrents-api.js';
import { tvRouter } from './tv-playlist.js';

export const DEFAULT_STATIC_DIR = fileURLToPath(
  new URL('../public', import.meta.url),
);

export interface AppOptions {
  // Passed in rather than created here, so tests can hand in FakeWebTorrent.
  client: WebTorrent;
  // Where added torrents store their files (DOWNLOAD_DIR).
  downloadDir: string;
  staticDir?: string;
  // Decision #13: saves torrents across restarts, and those to add again now.
  saved?: SavedTorrents;
  restore?: readonly SavedTorrent[];
  // The machine's LAN addresses, for the TV playlist; tests pass their own.
  lanAddresses?: () => string[];
  // Decision #36: the user's settings, loaded at startup. Without it they
  // start as defaults and are saved in downloadDir.
  settings?: SettingsStore;
}

// Build the Express app without binding a port, so tests can drive it with supertest.
export function createApp({
  client,
  downloadDir,
  staticDir = DEFAULT_STATIC_DIR,
  saved,
  restore,
  lanAddresses,
  settings = new SettingsStore(downloadDir),
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.static(staticDir));

  // Whether the torrent client is up and which peer port to forward (see 2.6).
  app.get('/api/client', (_req, res) => {
    const address = client.address();
    res.json({
      listening: address !== null,
      peerPort: address && typeof address === 'object' ? address.port : null,
      torrents: client.torrents.length,
      downloadSpeed: client.downloadSpeed,
      uploadSpeed: client.uploadSpeed,
    });
  });

  const disk = new DiskLimit({
    client,
    limit: () => settings.get().diskLimit,
  });
  app.use(
    '/api/torrents',
    torrentsRouter({ client, downloadDir, saved, restore, disk }),
  );
  app.use(settingsRouter({ settings, disk }));

  // Step 3.11: /tv.m3u for VLC on a TV, and /api/tv with its address.
  app.use(tvRouter({ client, lanAddresses }));

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}
