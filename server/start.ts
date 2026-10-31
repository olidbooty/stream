import { hostname } from 'node:os';
import { createApp } from './app.js';
import {
  type DeviceInfo,
  deviceName,
  deviceUuid,
  dlnaEnabled,
} from './dlna.js';
import { lanAddresses, lanInterfaces } from './network.js';
import { SavedTorrents } from './saved-torrents.js';
import {
  activeDiskLimit,
  defaultSettings,
  GB,
  SettingsStore,
} from './settings.js';
import { SsdpServer } from './ssdp.js';
import {
  createTorrentClient,
  destroyTorrentClient,
  ensureDownloadDir,
  peerTransports,
  torrentConfig,
} from './torrent-client.js';

// Runs the server. Imported by server/index.ts once it knows whether WebRTC
// can load.
export async function start({ webrtc }: { webrtc: boolean }): Promise<void> {
  const port = Number(process.env.PORT) || 1234;
  // 0.0.0.0 exposes the server to other devices on the LAN; set HOST=127.0.0.1 to keep it local.
  const host = process.env.HOST || '0.0.0.0';
  const config = torrentConfig();
  const dlna = dlnaDevice(host, port);
  await ensureDownloadDir(config.downloadDir);
  // Decision #13: add the torrents from before the last shutdown again.
  const saved = new SavedTorrents(config.downloadDir);
  const restore = await saved.load();
  // Decision #36: settings changed on the page, over DISK_LIMIT_GB.
  const settings = new SettingsStore(config.downloadDir, defaultSettings());
  await settings.load();

  const client = createTorrentClient({ ...config, webrtc });

  client.on('listening', () => {
    const address = client.address();
    const peerPort =
      address && typeof address === 'object'
        ? address.port
        : config.torrentPort;
    console.log(`torrent client listening for peers on port ${peerPort}`);
    console.log(`  peers over ${peerTransports(webrtc).join(', ')}`);
    if (config.portMapping) {
      console.log(
        '  asking the router to forward the peer port (PORT_MAPPING=1)',
      );
    } else if (config.torrentPort === 0 || config.dhtPort === 0) {
      console.log(
        '  random peer ports change on every start; set TORRENT_PORT and DHT_PORT to forward them',
      );
    } else {
      console.log(
        `  forward TCP and UDP ${peerPort} and UDP ${config.dhtPort} on your router for more peers`,
      );
    }
    console.log(`  downloads go to ${config.downloadDir}`);
    const diskLimit = activeDiskLimit(settings.get());
    if (diskLimit !== null) {
      console.log(`  limited to ${diskLimit / GB} GB (change it in Settings)`);
    }
  });

  // The client only emits 'error' when it can't continue, e.g. the peer port is
  // taken. addTorrent() keeps per-torrent errors off it.
  client.on('error', (err) => {
    console.error('torrent client failed:', err);
    const { code, port } = err as NodeJS.ErrnoException & { port?: number };
    if (code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use. Set TORRENT_PORT and DHT_PORT to free ports, or 0 for random ones.`,
      );
    }
    process.exit(1);
  });

  if (restore.length > 0) {
    console.log(
      `restoring ${restore.length} torrent${restore.length === 1 ? '' : 's'} from ${saved.dir}`,
    );
  }
  const app = createApp({
    client,
    downloadDir: config.downloadDir,
    saved,
    restore,
    dlna,
    settings,
  });
  let ssdp: SsdpServer | undefined;
  const server = app.listen(port, host, () => {
    console.log(`stream listening on http://localhost:${port}`);
    if (host === '0.0.0.0') {
      for (const address of lanAddresses()) {
        console.log(`  on your network: http://${address}:${port}`);
      }
    }
    if (dlna) {
      const address = server.address();
      ssdp = new SsdpServer({
        uuid: dlna.uuid,
        port: address && typeof address === 'object' ? address.port : port,
        // HOST set to one LAN address keeps DLNA to that network too.
        interfaces: () =>
          lanInterfaces().filter(
            (iface) => host === '0.0.0.0' || iface.address === host,
          ),
      });
      void ssdp.start().then((started) => {
        if (started) {
          console.log(
            `  in VLC on a TV: Browse > Local network > ${dlna.name} (DLNA=0 turns this off)`,
          );
        }
      });
    }
  });

  let shuttingDown = false;

  // Stop announcing to trackers and the DHT before exiting. A second signal exits at once.
  async function shutDown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    server.close();
    server.closeAllConnections();
    try {
      // Tells players on the network the server is gone.
      await ssdp?.stop();
      await destroyTorrentClient(client);
      await saved.flush();
      await settings.flush();
      process.exit(0);
    } catch (err) {
      console.error('error destroying torrent client:', err);
      process.exit(1);
    }
  }

  process.on('SIGINT', (signal) => void shutDown(signal));
  process.on('SIGTERM', (signal) => void shutDown(signal));
}

// Step 3.12: the DLNA server, unless DLNA=0 or HOST keeps the HTTP port off
// the network, where players couldn't reach it anyway.
function dlnaDevice(host: string, port: number): DeviceInfo | undefined {
  if (!dlnaEnabled(process.env.DLNA)) return undefined;
  if (host !== '0.0.0.0' && !lanAddresses().includes(host)) {
    console.log(`DLNA off: HOST=${host} isn't reachable from the network`);
    return undefined;
  }
  return { uuid: deviceUuid(hostname(), port), name: deviceName(hostname()) };
}
