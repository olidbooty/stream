import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import type { TorrentSummary } from './torrents-api.js';

// What the UI shows for a torrent. `noPeers` is Decision #15: no peer is
// connected and WebTorrent's own check has found none since the last one left.
// `diskFull` is Decision #36: paused because downloads reached the disk limit.
export type TorrentState =
  | 'paused'
  | 'diskFull'
  | 'connecting'
  | 'downloading'
  | 'seeding'
  | 'noPeers'
  | 'error';

export interface TorrentStateInput {
  // WebTorrent hit an error and destroyed the torrent.
  failed: boolean;
  // Paused by the user: no peers, nothing transferred.
  paused: boolean;
  // Paused by the disk limit instead (DiskLimit); paused is true as well.
  diskFull?: boolean;
  // Every selected file is on disk (Decision #23).
  done: boolean;
  hasMetadata: boolean;
  // Connected peers (wires), not peers merely discovered.
  numPeers: number;
  // A `noPeers` event has fired since the last peer connected.
  noPeersReported: boolean;
}

// Derived from fields rather than from the order events arrived in, so the
// list, the detail route and the event stream always agree.
export function torrentState({
  failed,
  paused,
  diskFull = false,
  done,
  hasMetadata,
  numPeers,
  noPeersReported,
}: TorrentStateInput): TorrentState {
  if (failed) return 'error';
  if (diskFull) return 'diskFull';
  // Paused beats the rest: it has no peers on purpose, and a paused finished
  // torrent isn't uploading.
  if (paused) return 'paused';
  // A finished torrent keeps uploading while it is in the client, with or
  // without peers, so having none isn't a problem worth showing.
  if (done) return 'seeding';
  if (numPeers === 0) return noPeersReported ? 'noPeers' : 'connecting';
  // Peers are connected but a magnet link's metadata hasn't arrived yet.
  return hasMetadata ? 'downloading' : 'connecting';
}

// Failed torrents are kept until deleted; this bounds a client that keeps
// adding torrents that fail and never deletes them.
export const MAX_FAILED_TORRENTS = 50;

// Remembers what WebTorrent only reports through events: whether a torrent has
// gone without peers, and torrents that failed. A failed torrent is destroyed
// and dropped from client.torrents, so without this it would just vanish.
export class TorrentWatch {
  private readonly client: WebTorrent;
  // Weak, so a removed torrent leaves nothing behind.
  private readonly withoutPeers = new WeakSet<Torrent>();
  private readonly failures = new Map<string, TorrentSummary>();

  constructor(client: WebTorrent) {
    this.client = client;
  }

  // `snapshot` gives the torrent's summary when it fails, while its name and
  // progress are still readable. A new torrent replaces an earlier failure of
  // the same info hash, so adding it again is how the user retries.
  watch(
    torrent: Torrent,
    infoHash: string,
    snapshot: () => TorrentSummary,
  ): void {
    this.failures.delete(infoHash);

    // WebTorrent checks every 30 seconds and emits once per discovery source
    // with no peers. LSD and PEX report none for almost every torrent, so the
    // source says little; it only matters while no peer is connected.
    torrent.on('noPeers', () => this.withoutPeers.add(torrent));
    torrent.on('wire', () => this.withoutPeers.delete(torrent));

    // addTorrent() also listens for 'error' and logs it, which keeps the error
    // off the client either way.
    torrent.once('error', (err) => {
      // Adding a torrent twice at the same instant makes WebTorrent destroy one
      // of them (not always the later one). The other is still running, so
      // that isn't a failure.
      if (this.client.torrents.some((other) => other.infoHash === infoHash))
        return;
      this.failures.set(infoHash, {
        ...snapshot(),
        infoHash,
        state: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        ready: false,
        numPeers: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
      });
      const oldest = this.failures.keys().next().value;
      if (this.failures.size > MAX_FAILED_TORRENTS && oldest !== undefined) {
        this.failures.delete(oldest);
      }
    });
  }

  noPeersReported(torrent: Torrent): boolean {
    return this.withoutPeers.has(torrent);
  }

  failed(): TorrentSummary[] {
    return [...this.failures.values()];
  }

  getFailed(infoHash: string): TorrentSummary | undefined {
    return this.failures.get(infoHash);
  }

  // Nothing else to clean up: WebTorrent deleted the files when the torrent
  // failed (destroyStoreOnDestroy).
  forget(infoHash: string): boolean {
    return this.failures.delete(infoHash);
  }
}
