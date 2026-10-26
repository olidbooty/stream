import { describe, expect, it } from 'vitest';
import type { Torrent } from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import type { MediaFileInput } from './media.js';
import {
  initialSelection,
  playbackFiles,
  selectionProgress,
  TorrentSelection,
} from './torrent-selection.js';

function files(...names: [name: string, length: number][]): MediaFileInput[] {
  return names.map(([name, length], index) => ({
    index,
    name,
    path: `Film/${name}`,
    length,
  }));
}

describe('playbackFiles and initialSelection', () => {
  const film = files(
    ['Film.mp4', 1000],
    ['Film.en.srt', 10],
    ['Film.de.srt', 10],
    ['Trailer.mp4', 100],
    ['Trailer.srt', 5],
  );

  it('picks a video and its subtitles', () => {
    expect(playbackFiles(film, 3)).toEqual([3, 4]);
  });

  it('starts with the main video and its subtitles', () => {
    expect(initialSelection(film)).toEqual([0, 2, 1]);
  });

  it('selects every file when there is no video', () => {
    expect(initialSelection(files(['a.iso', 10], ['README', 1]))).toEqual([
      0, 1,
    ]);
  });
});

describe('selectionProgress', () => {
  const state = [
    { length: 100, downloaded: 50, done: false },
    { length: 10, downloaded: 10, done: true },
    { length: 1000, downloaded: 0, done: false },
  ];

  it('counts only the selected files', () => {
    expect(selectionProgress(state, [0, 1])).toEqual({
      selectedLength: 110,
      progress: 60 / 110,
      done: false,
    });
    expect(selectionProgress(state, [1])).toEqual({
      selectedLength: 10,
      progress: 1,
      done: true,
    });
  });

  it('treats an empty selection as done', () => {
    expect(selectionProgress(state, [])).toEqual({
      selectedLength: 0,
      progress: 1,
      done: true,
    });
  });

  it('ignores indexes past the end', () => {
    expect(selectionProgress(state, [1, 7]).selectedLength).toBe(10);
  });
});

describe('TorrentSelection', () => {
  function addTorrent() {
    const client = new FakeWebTorrent();
    const torrent = client.add(`magnet:?xt=urn:btih:${'a'.repeat(40)}`, {
      deselect: true,
    });
    return { fake: torrent, torrent: torrent as unknown as Torrent };
  }

  it('selects once the metadata arrives', () => {
    const { fake, torrent } = addTorrent();
    const selection = new TorrentSelection();
    selection.watch(torrent);
    expect(selection.get(torrent)).toBeUndefined();

    fake.simulateMetadata({
      files: [
        { name: 'Film.mp4', length: 1000 },
        { name: 'poster.jpg', length: 10 },
      ],
    });

    expect([...(selection.get(torrent) ?? [])]).toEqual([0]);
    expect(fake.files.map((file) => file.selected)).toEqual([true, false]);
  });

  it('selects at once when the metadata is already there', () => {
    const { fake, torrent } = addTorrent();
    fake.simulateMetadata({ files: [{ name: 'Film.mp4', length: 1000 }] });
    const selection = new TorrentSelection();

    selection.watch(torrent);

    expect([...(selection.get(torrent) ?? [])]).toEqual([0]);
  });

  it('adds videos without dropping earlier ones', () => {
    const { fake, torrent } = addTorrent();
    const selection = new TorrentSelection();
    selection.watch(torrent);
    fake.simulateMetadata({
      files: [
        { name: 'Episode 1.mp4', length: 1000 },
        { name: 'Episode 2.mp4', length: 1000 },
        { name: 'Episode 2.srt', length: 10 },
      ],
    });

    selection.selectVideo(torrent, 1);

    expect([...(selection.get(torrent) ?? [])]).toEqual([0, 1, 2]);
    expect(fake.files.every((file) => file.selected)).toBe(true);
  });
});
