import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import BittorrentProtocol from 'bittorrent-protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import WebTorrent, { type Torrent } from 'webtorrent';
import { guardPeerHandshake } from './peer-handshake.js';
import { pauseTorrent } from './torrent-client.js';

// The protocol encryption (MSE) side of a wire, which @types/bittorrent-protocol
// leaves out.
type EncryptingWire = Duplex & {
  startEncryption(infoHash: string): void;
};
const Wire = BittorrentProtocol as unknown as new (
  type: string,
  peEnabled: number,
) => EncryptingWire;

// A real client on a loopback connection: the crash is in WebTorrent's own
// peer code, which the fake doesn't run. DHT, trackers and LSD are off, so
// nothing leaves the machine.
let client: WebTorrent;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-handshake-'));
  client = new WebTorrent({
    torrentPort: 0,
    dht: false,
    tracker: false,
    lsd: false,
    utp: false,
  } as ConstructorParameters<typeof WebTorrent>[0]);
});

afterEach(async () => {
  await new Promise<void>((done) => client.destroy(() => done()));
  rmSync(dir, { recursive: true, force: true });
});

function seed(): Promise<Torrent> {
  return new Promise((done) => {
    client.seed(Buffer.from('stream'.repeat(1000)), { path: dir }, done);
  });
}

// Dial the client as an encrypting peer and resolve once it hangs up.
function connectEncrypted(port: number, infoHash: string): Promise<void> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1', () => {
      const wire = new Wire('tcpOutgoing', 1);
      socket.pipe(wire).pipe(socket);
      wire.on('error', () => {});
      wire.startEncryption(infoHash);
    });
    socket.on('error', () => {});
    socket.on('close', () => done());
  });
}

it('turns away an encrypted peer of a paused torrent without crashing', async () => {
  guardPeerHandshake();
  const torrent = await seed();
  pauseTorrent(torrent);

  const { port } = client.address() as { port: number };
  await connectEncrypted(port, torrent.infoHash);

  expect(torrent.numPeers).toBe(0);
});
