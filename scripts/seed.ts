import { resolve } from 'node:path';
import WebTorrent, { type Torrent } from 'webtorrent';

// Step 4.1: seeds a file or folder (such as the codec clips) from a separate
// WebTorrent client on this machine, so the app can download and play it
// with no trackers, DHT or internet. Prints a magnet link that names this
// seeder's address (x.pe=); paste it into the app running on the same
// machine. Ctrl+C stops seeding.
//
//   npm run seed -- <file or folder>

async function main(argv: string[]): Promise<void> {
  const input = argv[0];
  if (!input) {
    console.error('Usage: npm run seed -- <file or folder>');
    process.exitCode = 2;
    return;
  }
  // Port 0: never clashes with the app's TORRENT_PORT.
  const client = new WebTorrent({
    dht: false,
    lsd: false,
    tracker: false,
    natUpnp: false,
    natPmp: false,
    torrentPort: 0,
  });
  client.on('error', (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
  const torrent = await new Promise<Torrent>((done) => {
    client.seed(resolve(input), { announce: [] }, done);
  });
  const port = (client.address() as { port: number }).port;
  console.log(`Seeding ${torrent.name} (${torrent.files.length} files)`);
  console.log(`${torrent.magnetURI}&x.pe=127.0.0.1:${port}`);

  const stop = () => client.destroy(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
