import type { Torrent } from 'webtorrent';
import {
  type MediaFileInput,
  matchSubtitles,
  mediaKind,
  selectMedia,
} from './media.js';

// Decision #18: torrents are added with nothing selected, and only the video
// being watched and its subtitles download. Streaming still fetches any range
// that is played, selected or not; the selection decides what keeps
// downloading in the background.

// The video and the subtitles that go with it.
export function playbackFiles(
  files: readonly MediaFileInput[],
  videoIndex: number,
): number[] {
  return [
    videoIndex,
    ...matchSubtitles(files, videoIndex).map((match) => match.index),
  ];
}

// What to download once the file list is known: the main video and its
// subtitles, or every file of a torrent with no video (music, an ISO), which
// has nothing to choose between.
export function initialSelection(files: readonly MediaFileInput[]): number[] {
  const { mainFile } = selectMedia(files);
  if (mainFile === null) return files.map((file) => file.index);
  return playbackFiles(files, mainFile);
}

export function isVideoFile(name: string): boolean {
  const kind = mediaKind(name);
  return kind === 'video' || kind === 'video-may-not-play';
}

export interface SelectableFile {
  length: number;
  downloaded: number;
  done: boolean;
}

export interface SelectionProgress {
  // Bytes in the selected files.
  selectedLength: number;
  // Share of those bytes on disk, 0 to 1.
  progress: number;
  // Every selected file is on disk.
  done: boolean;
}

// Decision #23: progress and `seeding` follow the selection, not the whole
// torrent, so a film is finished when the film is, whatever extras it skipped.
export function selectionProgress(
  files: readonly SelectableFile[],
  selected: Iterable<number>,
): SelectionProgress {
  let selectedLength = 0;
  let downloaded = 0;
  let done = true;
  for (const index of selected) {
    const file = files[index];
    if (!file) continue;
    selectedLength += file.length;
    downloaded += Math.min(file.downloaded, file.length);
    done &&= file.done;
  }
  return {
    selectedLength,
    progress: selectedLength ? downloaded / selectedLength : done ? 1 : 0,
    done,
  };
}

export function mediaInputs(torrent: Torrent): MediaFileInput[] {
  return torrent.files.map((file, index) => ({
    index,
    name: file.name,
    path: file.path,
    length: file.length,
  }));
}

// Remembers which files of each torrent are selected, since WebTorrent's files
// don't say. Weak, so a removed torrent leaves nothing behind.
export class TorrentSelection {
  private readonly selected = new WeakMap<Torrent, Set<number>>();
  private readonly onChange: (torrent: Torrent) => void;

  // onChange runs whenever a torrent's selection grows, so it can be saved.
  constructor(onChange: (torrent: Torrent) => void = () => {}) {
    this.onChange = onChange;
  }

  // Call right after adding a torrent with `deselect: true`. Selects the
  // initial files as soon as the file list is known: at once if it already
  // is, otherwise when a magnet link's metadata arrives. A torrent restored
  // after a restart passes the files it had selected instead.
  watch(torrent: Torrent, restored?: readonly number[] | null): void {
    const start = () => {
      if (this.selected.has(torrent)) return;
      const files = mediaInputs(torrent);
      const saved = restored?.filter((index) => index < files.length);
      this.selectFiles(
        torrent,
        saved?.length ? saved : initialSelection(files),
      );
    };
    if (torrent.metadata) start();
    else torrent.once('metadata', start);
  }

  // Adds a video and its subtitles to the selection. Nothing already selected
  // is dropped, so switching episodes keeps a partial download going.
  selectVideo(torrent: Torrent, videoIndex: number): void {
    this.selectFiles(torrent, playbackFiles(mediaInputs(torrent), videoIndex));
  }

  // The selected file indexes, or undefined before the file list is known.
  get(torrent: Torrent): ReadonlySet<number> | undefined {
    return this.selected.get(torrent);
  }

  private selectFiles(torrent: Torrent, indexes: number[]): void {
    let selected = this.selected.get(torrent);
    if (!selected) {
      selected = new Set();
      this.selected.set(torrent, selected);
    }
    const before = selected.size;
    for (const index of indexes) {
      if (selected.has(index)) continue;
      torrent.files[index]?.select();
      selected.add(index);
    }
    if (selected.size !== before) this.onChange(torrent);
  }
}
