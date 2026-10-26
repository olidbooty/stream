import type { TorrentSummary } from '../../server/torrents-api.js';
import type { Api } from './api.js';
import { el } from './ui/dom.js';
import { fileList } from './ui/file-list.js';
import { type TorrentRow, torrentRow } from './ui/torrent-row.js';

export interface TorrentListOptions {
  api: Pick<
    Api,
    | 'getTorrent'
    | 'removeTorrent'
    | 'addMagnet'
    | 'pauseTorrent'
    | 'resumeTorrent'
  >;
  // Asks before Remove, which deletes the downloaded files.
  confirm(message: string): Promise<boolean>;
  // Called after a pause, resume, remove or retry, e.g. to refresh the list at once.
  onChanged(): void;
}

export interface TorrentList {
  element: HTMLElement;
  update(torrents: TorrentSummary[]): void;
  // Dims the list while live updates are down, as it may be out of date.
  setStale(stale: boolean): void;
}

interface Entry {
  row: TorrentRow;
  torrent: TorrentSummary;
  // The expanded file list is still waiting for the metadata.
  filesPending: boolean;
  loading: boolean;
}

function note(text: string): HTMLParagraphElement {
  return el('p', { className: 'torrent__files-note', text });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function torrentList({
  api,
  confirm,
  onChanged,
}: TorrentListOptions): TorrentList {
  const entries = new Map<string, Entry>();
  const items = el('ul', { className: 'torrent-list__items' });
  const empty = el('p', {
    className: 'torrent-list__empty',
    text: 'No torrents yet. Add a magnet link or a .torrent file above.',
  });
  const element = el(
    'section',
    { className: 'torrent-list', attrs: { 'aria-labelledby': 'list-heading' } },
    el('h2', { text: 'Torrents', attrs: { id: 'list-heading' } }),
    empty,
    items,
  );

  // Fetched only when a row is opened, then again only once the metadata
  // turns up, rather than every second.
  async function loadFiles(entry: Entry): Promise<void> {
    const { row } = entry;
    entry.loading = true;
    if (!entry.filesPending) row.setFiles(note('Loading files…'));
    try {
      const detail = await api.getTorrent(entry.torrent.infoHash);
      if (detail.state === 'error') {
        entry.filesPending = false;
        row.setFiles(note('This torrent failed, so it has no files.'));
      } else if (!detail.hasMetadata || !detail.files) {
        entry.filesPending = true;
        row.setFiles(
          note('File list not known yet: it is still coming from peers.'),
        );
      } else {
        entry.filesPending = false;
        row.setFiles(
          detail.files.length > 0 ? fileList(detail) : note('No files.'),
        );
      }
    } catch (err) {
      entry.filesPending = false;
      row.setFiles(note(`Couldn't load the files: ${errorMessage(err)}`));
    } finally {
      entry.loading = false;
    }
  }

  async function remove(entry: Entry): Promise<void> {
    const name = entry.torrent.name ?? entry.torrent.infoHash;
    const ok = await confirm(
      `Remove ${name}? Its downloaded files will be deleted.`,
    );
    if (!ok) return;
    entry.row.setActionError(null);
    try {
      await api.removeTorrent(entry.torrent.infoHash);
      onChanged();
    } catch (err) {
      entry.row.setActionError(`Couldn't remove it: ${errorMessage(err)}`);
    }
  }

  // Decision #22: adding a failed torrent again is how it is retried.
  async function retry(entry: Entry): Promise<void> {
    entry.row.setActionError(null);
    try {
      await api.addMagnet(entry.torrent.magnetURI);
      onChanged();
    } catch (err) {
      entry.row.setActionError(`Couldn't retry: ${errorMessage(err)}`);
    }
  }

  async function togglePause(entry: Entry): Promise<void> {
    const paused = entry.torrent.state === 'paused';
    const { infoHash } = entry.torrent;
    entry.row.setActionError(null);
    try {
      await (paused ? api.resumeTorrent(infoHash) : api.pauseTorrent(infoHash));
      onChanged();
    } catch (err) {
      entry.row.setActionError(
        `Couldn't ${paused ? 'resume' : 'pause'} it: ${errorMessage(err)}`,
      );
    }
  }

  function create(torrent: TorrentSummary): Entry {
    const entry: Entry = {
      torrent,
      filesPending: false,
      loading: false,
      row: torrentRow(torrent, {
        onToggle: (expanded) => {
          if (expanded) void loadFiles(entry);
        },
        onRemove: () => void remove(entry),
        onRetry: () => void retry(entry),
        onTogglePause: () => void togglePause(entry),
      }),
    };
    return entry;
  }

  return {
    element,
    update(torrents) {
      const seen = new Set<string>();
      let previous: Element | null = null;
      for (const torrent of torrents) {
        seen.add(torrent.infoHash);
        let entry = entries.get(torrent.infoHash);
        if (entry) {
          const wasFailed = entry.torrent.state === 'error';
          const wasSeeding = entry.torrent.state === 'seeding';
          entry.torrent = torrent;
          entry.row.update(torrent);
          const metadataArrived = entry.filesPending && torrent.hasMetadata;
          const retried = wasFailed && torrent.state !== 'error';
          // The file list marks files Downloading or Downloaded.
          const finished = !wasSeeding && torrent.state === 'seeding';
          if (
            entry.row.expanded &&
            !entry.loading &&
            (metadataArrived || retried || finished)
          ) {
            void loadFiles(entry);
          }
        } else {
          entry = create(torrent);
          entries.set(torrent.infoHash, entry);
        }
        // Only move rows that are out of place: moving an element drops focus.
        const expected: Element | null = previous
          ? previous.nextElementSibling
          : items.firstElementChild;
        if (expected !== entry.row.element) {
          if (previous) previous.after(entry.row.element);
          else items.prepend(entry.row.element);
        }
        previous = entry.row.element;
      }
      for (const [infoHash, entry] of entries) {
        if (!seen.has(infoHash)) {
          entry.row.element.remove();
          entries.delete(infoHash);
        }
      }
      empty.hidden = torrents.length > 0;
      items.hidden = torrents.length === 0;
    },
    setStale(stale) {
      element.dataset.stale = String(stale);
    },
  };
}
