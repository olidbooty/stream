import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import parseTorrent, { type Instance as ParsedTorrent } from 'parse-torrent';
import { writeFileAtomically } from './atomic-file.js';
import { isMagnetURI } from './magnet.js';

// Decision #13: the torrent list survives a restart. Each torrent is saved in
// DOWNLOAD_DIR/.torrents as <infoHash>.json (how to add it again, and what the
// user chose) plus <infoHash>.torrent once its metadata is known, so a magnet
// link doesn't have to fetch it from peers again.
export const SAVED_TORRENTS_DIR = '.torrents';

const INFO_HASH = /^[0-9a-f]{40}$/;

// What is restored besides the torrent itself.
export interface TorrentChoices {
  // When it was added, in ms since the epoch; torrents are restored in this
  // order so the list looks the same after a restart.
  addedAt: number;
  // The magnet link, with the sources filterSources() kept.
  magnetURI: string;
  paused: boolean;
  // Indexes of the files downloading in the background (Decision #18); null
  // until the file list is known.
  selected: number[] | null;
}

export interface SavedTorrent extends TorrentChoices {
  infoHash: string;
  // Parsed from the saved .torrent if there is one, otherwise the magnet.
  parsed: ParsedTorrent;
}

function isChoices(value: unknown): value is TorrentChoices {
  if (typeof value !== 'object' || value === null) return false;
  const { addedAt, magnetURI, paused, selected } = value as Record<
    string,
    unknown
  >;
  return (
    typeof addedAt === 'number' &&
    Number.isFinite(addedAt) &&
    isMagnetURI(magnetURI) &&
    typeof paused === 'boolean' &&
    (selected === null ||
      (Array.isArray(selected) &&
        selected.every((index) => Number.isSafeInteger(index) && index >= 0)))
  );
}

// Writes go through writeFileAtomically(), so a crash mid-write leaves the
// previous version rather than half a file. Writes for one torrent run in
// order, so a quick pause and resume can't land the wrong way round.
export class SavedTorrents {
  readonly dir: string;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(downloadDir: string) {
    this.dir = join(downloadDir, SAVED_TORRENTS_DIR);
  }

  private path(infoHash: string, extension: 'json' | 'torrent'): string {
    if (!INFO_HASH.test(infoHash)) {
      throw new Error(`not an info hash: ${infoHash}`);
    }
    return join(this.dir, `${infoHash}.${extension}`);
  }

  // Runs one write for a torrent after the ones before it. Errors are logged:
  // a torrent that can't be saved still runs, it just isn't restored.
  private queue(infoHash: string, task: () => Promise<void>): Promise<void> {
    const next = (this.pending.get(infoHash) ?? Promise.resolve())
      .then(task)
      .catch((err) => {
        console.error(`saving torrent ${infoHash} failed:`, err);
      });
    this.pending.set(infoHash, next);
    void next.then(() => {
      if (this.pending.get(infoHash) === next) this.pending.delete(infoHash);
    });
    return next;
  }

  save(infoHash: string, choices: TorrentChoices): Promise<void> {
    const path = this.path(infoHash, 'json');
    return this.queue(infoHash, () =>
      writeFileAtomically(path, `${JSON.stringify(choices, null, 2)}\n`),
    );
  }

  saveTorrentFile(infoHash: string, torrentFile: Uint8Array): Promise<void> {
    const path = this.path(infoHash, 'torrent');
    return this.queue(infoHash, () => writeFileAtomically(path, torrentFile));
  }

  delete(infoHash: string): Promise<void> {
    const json = this.path(infoHash, 'json');
    const torrent = this.path(infoHash, 'torrent');
    return this.queue(infoHash, async () => {
      await rm(json, { force: true });
      await rm(torrent, { force: true });
    });
  }

  // Resolves once every write started so far has finished.
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending.values());
    }
  }

  // Every saved torrent, oldest first. One that can't be read is logged and
  // skipped, and left on disk for a person to look at.
  async load(): Promise<SavedTorrent[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const saved: SavedTorrent[] = [];
    for (const name of names) {
      const infoHash = name.slice(0, -'.json'.length);
      if (!name.endsWith('.json') || !INFO_HASH.test(infoHash)) continue;
      try {
        saved.push(await this.loadOne(infoHash));
      } catch (err) {
        console.error(
          `not restoring saved torrent ${infoHash}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return saved.sort((a, b) => a.addedAt - b.addedAt);
  }

  private async loadOne(infoHash: string): Promise<SavedTorrent> {
    const choices: unknown = JSON.parse(
      await readFile(this.path(infoHash, 'json'), 'utf8'),
    );
    if (!isChoices(choices)) throw new Error('unexpected contents');

    let torrentFile: Buffer | undefined;
    try {
      torrentFile = await readFile(this.path(infoHash, 'torrent'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let parsed: ParsedTorrent | undefined;
    if (torrentFile) {
      try {
        parsed = await parseTorrent(torrentFile);
      } catch {
        console.warn(
          `saved .torrent for ${infoHash} is unreadable; using its magnet link`,
        );
      }
    }
    const fromMagnet = await parseTorrent(choices.magnetURI);
    if (fromMagnet.infoHash !== infoHash) {
      throw new Error(
        `it is saved as ${infoHash} but is ${fromMagnet.infoHash}`,
      );
    }
    if (parsed?.infoHash !== infoHash) parsed = fromMagnet;
    // A .torrent has no x.pe= peer addresses, so keep the magnet's.
    else if (fromMagnet.peerAddresses) {
      parsed.peerAddresses = fromMagnet.peerAddresses;
    }
    return {
      infoHash,
      addedAt: choices.addedAt,
      magnetURI: choices.magnetURI,
      paused: choices.paused,
      selected: choices.selected,
      parsed,
    };
  }
}
