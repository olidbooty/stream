import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import type WebTorrent from 'webtorrent';
import { SAVED_TORRENTS_DIR } from './saved-torrents.js';
import { SETTINGS_FILE } from './settings.js';

// Ours, never listed: the saved torrents and the settings, and the temporary
// file a settings write goes through.
const OWN_ENTRIES = new Set([
  SAVED_TORRENTS_DIR,
  SETTINGS_FILE,
  `${SETTINGS_FILE}.tmp`,
]);

// A file or folder at the top of DOWNLOAD_DIR that no torrent owns, e.g. what
// an older run, a failed delete or a crash left behind.
export interface Leftover {
  name: string;
  folder: boolean;
  // What it takes on disk, like du: torrent files are sparse, so their
  // apparent size can be far larger.
  bytes: number;
}

export interface LeftoversInfo {
  // True while a torrent's file list is unknown: it may own any entry, so
  // nothing is listed until every torrent has its metadata.
  pending: boolean;
  leftovers: Leftover[];
}

// The top-level names the running torrents' files are under.
export function ownedNames(client: WebTorrent): Set<string> | null {
  const names = new Set<string>();
  for (const torrent of client.torrents) {
    if (!torrent.metadata) return null;
    for (const file of torrent.files) {
      names.add(file.path.split(/[/\\]/)[0]);
    }
  }
  return names;
}

// Bytes on disk under `path`. Symbolic links count as themselves and are
// never followed.
async function diskBytes(path: string): Promise<number> {
  const stats = await lstat(path);
  // Windows has no block count, so the apparent size stands in.
  const own =
    typeof stats.blocks === 'number' ? stats.blocks * 512 : stats.size;
  if (!stats.isDirectory()) return own;
  let total = 0;
  for (const name of await readdir(path)) {
    total += await diskBytes(join(path, name));
  }
  return total;
}

export async function findLeftovers(
  downloadDir: string,
  owned: ReadonlySet<string>,
): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  for (const entry of await readdir(downloadDir, { withFileTypes: true })) {
    if (OWN_ENTRIES.has(entry.name) || owned.has(entry.name)) continue;
    const path = join(downloadDir, entry.name);
    try {
      leftovers.push({
        name: entry.name,
        folder: entry.isDirectory(),
        bytes: await diskBytes(path),
      });
    } catch {
      // Gone or unreadable since readdir; it isn't listed.
    }
  }
  return leftovers.sort((a, b) => b.bytes - a.bytes);
}

// Removes `path` if it is a folder holding only empty folders, deepest first.
// Anything with a file in it stays. Decision #35: a removed multi-file
// torrent's store deletes its files but not their folders.
export async function removeEmptyFolders(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    return;
  }
  if (!stats.isDirectory()) return;
  for (const name of await readdir(path)) {
    await removeEmptyFolders(join(path, name));
  }
  try {
    await rmdir(path);
  } catch {
    // Not empty.
  }
}

export interface LeftoversRouterOptions {
  client: WebTorrent;
  downloadDir: string;
}

// Decision #38: leftovers are listed under Settings and only deleted when the
// user presses Delete, one at a time, since DOWNLOAD_DIR may also hold the
// user's own files.
export function leftoversRouter({
  client,
  downloadDir,
}: LeftoversRouterOptions): Router {
  const router = Router();

  const info = async (): Promise<LeftoversInfo> => {
    const owned = ownedNames(client);
    if (!owned) return { pending: true, leftovers: [] };
    return {
      pending: false,
      leftovers: await findLeftovers(downloadDir, owned),
    };
  };

  router.get('/api/leftovers', async (_req, res, next) => {
    try {
      res.json(await info());
    } catch (err) {
      next(err);
    }
  });

  // Only a name the list shows right now can be deleted, which also rules out
  // paths such as "../x" or ".torrents".
  router.delete('/api/leftovers/:name', async (req, res, next) => {
    try {
      const current = await info();
      if (current.pending) {
        return res.status(409).json({
          error:
            'A torrent is still fetching its file list, so leftovers can’t be told apart yet',
        });
      }
      const name = String(req.params.name);
      if (!current.leftovers.some((leftover) => leftover.name === name)) {
        return res.status(404).json({ error: 'No leftover with that name' });
      }
      await rm(join(downloadDir, name), { recursive: true, force: true });
      console.log(`deleted leftover ${join(downloadDir, name)}`);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
