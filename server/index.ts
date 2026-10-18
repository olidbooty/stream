import { createApp } from './app.js';
import { lanAddresses } from './network.js';
import {
  createTorrentClient,
  destroyTorrentClient,
  ensureDownloadDir,
  torrentConfig,
} from './torrent-client.js';

const port = Number(process.env.PORT) || 3000;
// 0.0.0.0 exposes the server to other devices on the LAN; set HOST=127.0.0.1 to keep it local.
const host = process.env.HOST || '0.0.0.0';
const config = torrentConfig();
await ensureDownloadDir(config.downloadDir);

const client = createTorrentClient(config);

client.on('listening', () => {
  const address = client.address();
  const peerPort =
    address && typeof address === 'object' ? address.port : config.torrentPort;
  console.log(`torrent client listening for peers on port ${peerPort}`);
  console.log(`  downloads go to ${config.downloadDir}`);
});

// The client only emits 'error' when it can't continue, e.g. the peer port is
// taken. addTorrent() keeps per-torrent errors off it.
client.on('error', (err) => {
  console.error('torrent client failed:', err);
  process.exit(1);
});

const server = createApp({ client, downloadDir: config.downloadDir }).listen(
  port,
  host,
  () => {
    console.log(`stream listening on http://localhost:${port}`);
    if (host === '0.0.0.0') {
      for (const address of lanAddresses()) {
        console.log(`  on your network: http://${address}:${port}`);
      }
    }
  },
);

let shuttingDown = false;

// Stop announcing to trackers and the DHT before exiting. A second signal exits at once.
async function shutDown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  server.closeAllConnections();
  try {
    await destroyTorrentClient(client);
    process.exit(0);
  } catch (err) {
    console.error('error destroying torrent client:', err);
    process.exit(1);
  }
}

process.on('SIGINT', (signal) => void shutDown(signal));
process.on('SIGTERM', (signal) => void shutDown(signal));
