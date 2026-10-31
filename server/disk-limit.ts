import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { pauseTorrent, resumeTorrent } from './torrent-client.js';

export interface DiskLimitOptions {
  client: WebTorrent;
  // The limit in bytes, or null for none; read on every check, so a changed
  // setting applies at the next one.
  limit: () => number | null;
  // How often usage is checked. A torrent can go past the limit by what it
  // downloads in this time.
  intervalMs?: number;
}

export interface DiskUsage {
  // Bytes the torrents have on disk.
  used: number;
  limit: number | null;
  reached: boolean;
}

// Decision #36: keeps the torrents' data in DOWNLOAD_DIR under the limit in
// the settings. Once usage reaches it, every torrent still downloading is
// paused and new torrents are refused; when the limit is raised or removed,
// or deleting torrents frees enough, those it paused resume. A torrent the
// user paused is left alone either way.
export class DiskLimit {
  private readonly client: WebTorrent;
  private readonly limit: () => number | null;
  // Whether a torrent still has files to download. A finished one keeps
  // seeding at the limit, since uploading uses no disk. torrentsRouter sets
  // it to follow the selection (Decision #23); torrent.done counts every file.
  downloading: (torrent: Torrent) => boolean = (torrent) => !torrent.done;
  // Paused by the limit rather than by the user. Weak, so a removed torrent
  // leaves nothing behind.
  private readonly paused = new WeakSet<Torrent>();
  private timer: NodeJS.Timeout | null = null;

  constructor({ client, limit, intervalMs = 1000 }: DiskLimitOptions) {
    this.client = client;
    this.limit = limit;
    this.timer = setInterval(() => this.check(), intervalMs);
    // Never keeps the process alive on its own.
    this.timer.unref?.();
  }

  // Counts the pieces each torrent has verified or partly downloaded
  // (WebTorrent's torrent.downloaded), which is what its files hold on disk.
  // Files nothing owns any more aren't counted.
  usage(): DiskUsage {
    let used = 0;
    for (const torrent of this.client.torrents) used += torrent.downloaded;
    const limit = this.limit();
    return { used, limit, reached: limit !== null && used >= limit };
  }

  reached(): boolean {
    return this.usage().reached;
  }

  // Whether the limit, not the user, paused this torrent.
  pausedByLimit(torrent: Torrent): boolean {
    return this.paused.has(torrent);
  }

  // The user paused or resumed it, so it is theirs to control from now on.
  release(torrent: Torrent): void {
    this.paused.delete(torrent);
  }

  // Runs on the timer; call it after anything that changes usage or the
  // limit so the change applies at once.
  check(): void {
    const reached = this.reached();
    for (const torrent of this.client.torrents) {
      if (reached) {
        if (!torrent.paused && this.downloading(torrent)) {
          pauseTorrent(torrent);
          this.paused.add(torrent);
        }
      } else if (this.paused.has(torrent)) {
        this.paused.delete(torrent);
        resumeTorrent(torrent);
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
