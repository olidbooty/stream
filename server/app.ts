import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type WebTorrent from 'webtorrent';
import { DiskLimit } from './disk-limit.js';
import { type DeviceInfo, dlnaRouter } from './dlna.js';
import { leftoversRouter } from './leftovers.js';
import type { SavedTorrent, SavedTorrents } from './saved-torrents.js';
import { activeDiskLimit, SettingsStore } from './settings.js';
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
  // Step 3.12: the DLNA server's name and UDN, or none to leave it off.
  dlna?: DeviceInfo;
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
  dlna,
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
    limit: () => activeDiskLimit(settings.get()),
  });
  app.use(
    '/api/torrents',
    torrentsRouter({ client, downloadDir, saved, restore, disk }),
  );
  app.use(settingsRouter({ settings, disk }));
  app.use(leftoversRouter({ client, downloadDir }));

  // Step 3.11: /tv.m3u for VLC on a TV, and /api/tv with its address.
  app.use(tvRouter({ client, lanAddresses, dlnaName: dlna?.name }));

  // Step 3.12: VLC's Browse > Local network lists each torrent as a folder.
  if (dlna) app.use(dlnaRouter({ client, device: dlna, lanAddresses }));

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}
