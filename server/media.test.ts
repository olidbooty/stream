import { describe, expect, it } from 'vitest';
import {
  type MediaFileInput,
  matchSubtitles,
  mediaKind,
  selectMedia,
} from './media.js';

const MB = 1024 * 1024;

// Builds the files a torrent would report, indexed in the order given.
function files(...entries: [path: string, length: number][]): MediaFileInput[] {
  return entries.map(([path, length], index) => ({
    index,
    name: path.split('/').at(-1) ?? path,
    path,
    length,
  }));
}

describe('mediaKind', () => {
  it.each(['a.mp4', 'a.m4v', 'a.webm'])('expects %s to play', (name) => {
    expect(mediaKind(name)).toBe('video');
  });

  it.each([
    'a.mkv',
    'a.avi',
    'a.mov',
    'a.wmv',
    'a.flv',
    'a.ts',
    'a.m2ts',
    'a.mpg',
    'a.mpeg',
    'a.vob',
    'a.ogv',
    'a.3gp',
    'a.rmvb',
  ])('lists %s as a video that may not play', (name) => {
    expect(mediaKind(name)).toBe('video-may-not-play');
  });

  it.each(['a.srt', 'a.vtt'])('flags %s as subtitles', (name) => {
    expect(mediaKind(name)).toBe('subtitle');
  });

  it.each([
    'poster.jpg',
    'README',
    'notes.txt',
    'movie.mp4.part',
    'movie.mkv.rar',
    '.mp4',
    'mp4',
  ])('treats %s as something else', (name) => {
    expect(mediaKind(name)).toBe('other');
  });

  it('ignores case', () => {
    expect(mediaKind('MOVIE.MP4')).toBe('video');
    expect(mediaKind('Movie.MkV')).toBe('video-may-not-play');
    expect(mediaKind('Movie.EN.SRT')).toBe('subtitle');
  });
});

describe('selectMedia', () => {
  it('picks the only video of a single-file torrent', () => {
    const result = selectMedia(files(['bunny.mp4', 100 * MB]));

    expect(result).toEqual({
      files: [
        {
          index: 0,
          name: 'bunny.mp4',
          path: 'bunny.mp4',
          length: 100 * MB,
          media: 'video',
          sample: false,
        },
      ],
      mainFile: 0,
      videos: [0],
    });
  });

  it('keeps the input order and fields of every file', () => {
    const input = files(
      ['Film/poster.jpg', MB],
      ['Film/film.mp4', 700 * MB],
      ['Film/film.srt', 1],
    );

    const result = selectMedia(input);

    expect(result.files.map(({ index, path }) => ({ index, path }))).toEqual(
      input.map(({ index, path }) => ({ index, path })),
    );
    expect(result.files.map((file) => file.media)).toEqual([
      'other',
      'video',
      'subtitle',
    ]);
  });

  it('reports no main file when there is no video', () => {
    const result = selectMedia(
      files(['Album/01.flac', 30 * MB], ['Album/cover.jpg', MB]),
    );

    expect(result.mainFile).toBeNull();
    expect(result.videos).toEqual([]);
  });

  it('handles a torrent with no files', () => {
    expect(selectMedia([])).toEqual({ files: [], mainFile: null, videos: [] });
  });

  it('prefers a video that should play over a similar-sized one that may not', () => {
    const result = selectMedia(
      files(
        ['Film/Film.1080p.mkv', 2000 * MB],
        ['Film/Film.720p.mp4', 1100 * MB],
      ),
    );

    expect(result.mainFile).toBe(1);
  });

  it('falls back to a video that may not play', () => {
    const result = selectMedia(
      files(['Film/Film.avi', 700 * MB], ['Film/Film.nfo', 1]),
    );

    expect(result.mainFile).toBe(0);
    expect(result.files[0].media).toBe('video-may-not-play');
  });

  it('keeps an episode next to a double-length finale among the main videos', () => {
    const result = selectMedia(
      files(
        ['Show/E02 Finale.mp4', 700 * MB],
        ['Show/E01.mp4', 350 * MB],
        ['Show/Extra.mp4', 60 * MB],
      ),
    );

    expect(result.videos).toEqual([1, 0, 2]);
    expect(result.mainFile).toBe(1);
  });

  it('does not let a short .mp4 trailer beat a full-length .mkv', () => {
    const result = selectMedia(
      files(['Film/Film.mkv', 2000 * MB], ['Film/Trailer.mp4', 80 * MB]),
    );

    expect(result.mainFile).toBe(0);
    expect(result.videos).toEqual([0, 1]);
  });

  it('flags samples, lists them last and never picks them', () => {
    const result = selectMedia(
      files(
        ['Film/Sample/film-sample.mkv', 50 * MB],
        ['Film/film.mkv', 1500 * MB],
        ['Film/film.sample.mp4', 30 * MB],
      ),
    );

    expect(result.files.map((file) => file.sample)).toEqual([
      true,
      false,
      true,
    ]);
    expect(result.mainFile).toBe(1);
    expect(result.videos).toEqual([1, 2, 0]);
  });

  it('does not treat a full-length film with "sample" in its title as a sample', () => {
    const result = selectMedia(
      files(
        ['The Sample/The.Sample.2020.mp4', 900 * MB],
        ['The Sample/Sample.mp4', 40 * MB],
      ),
    );

    expect(result.files.map((file) => file.sample)).toEqual([false, true]);
    expect(result.mainFile).toBe(0);
  });

  it('plays a sample when it is the only video', () => {
    const result = selectMedia(files(['film-sample.mkv', 20 * MB]));

    expect(result.files[0].sample).toBe(false);
    expect(result.mainFile).toBe(0);
  });

  it('does not match "sample" inside another word', () => {
    const result = selectMedia(
      files(['Resampled.mp4', 10 * MB], ['Big.mp4', 900 * MB]),
    );

    expect(result.files[0].sample).toBe(false);
  });

  it('orders episodes numerically and starts with the first', () => {
    const result = selectMedia(
      files(
        ['Show/Show.S01E10.mkv', 350 * MB],
        ['Show/Show.S01E02.mkv', 360 * MB],
        ['Show/Show.S01E01.mkv', 340 * MB],
        ['Show/Extras/Making of.mkv', 90 * MB],
      ),
    );

    expect(result.videos).toEqual([2, 1, 0, 3]);
    expect(result.mainFile).toBe(2);
  });

  it('orders numbers in names by value, not as text', () => {
    const result = selectMedia(
      files(
        ['Episode 10.mp4', MB],
        ['Episode 9.mp4', MB],
        ['episode 1.mp4', MB],
      ),
    );

    expect(result.videos).toEqual([2, 1, 0]);
  });

  it('starts a film split in two at the first part', () => {
    const result = selectMedia(
      files(['Film/CD2/film.avi', 690 * MB], ['Film/CD1/film.avi', 700 * MB]),
    );

    expect(result.mainFile).toBe(1);
  });

  it('keeps file order for videos with the same path', () => {
    const input = files(['a.mp4', MB], ['a.mp4', MB]);

    expect(selectMedia(input).videos).toEqual([0, 1]);
  });
});

describe('matchSubtitles', () => {
  it('matches a subtitle with the same name, with or without a language', () => {
    const torrent = files(
      ['Sintel/Sintel.mp4', 100 * MB],
      ['Sintel/Sintel.srt', 1000],
      ['Sintel/Sintel.en.srt', 1000],
      ['Sintel/Sintel.pt_BR.vtt', 1000],
    );
    expect(matchSubtitles(torrent, 0)).toEqual([
      { index: 2, language: 'en' },
      { index: 3, language: 'pt-br' },
      { index: 1, language: null },
    ]);
  });

  it('finds subtitles in another folder', () => {
    const torrent = files(
      ['Sintel/Sintel.mp4', 100 * MB],
      ['Sintel/Subs/Sintel.de.srt', 1000],
    );
    expect(matchSubtitles(torrent, 0)).toEqual([{ index: 1, language: 'de' }]);
  });

  it('ignores case in names but keeps them apart from other videos', () => {
    const torrent = files(
      ['Show/Episode 1.mkv', 100 * MB],
      ['Show/Episode 2.mkv', 100 * MB],
      ['Show/episode 1.EN.srt', 1000],
      ['Show/Episode 2.srt', 1000],
    );
    expect(matchSubtitles(torrent, 0)).toEqual([{ index: 2, language: 'en' }]);
    expect(matchSubtitles(torrent, 1)).toEqual([{ index: 3, language: null }]);
  });

  it('skips near misses and files that are not subtitles', () => {
    const torrent = files(
      ['Sintel.mp4', 100 * MB],
      ['Sintel 2.srt', 1000],
      ['Sintel.english.srt', 1000],
      ['Sintel.en.txt', 1000],
      ['Sintel.nfo', 1000],
    );
    expect(matchSubtitles(torrent, 0)).toEqual([]);
  });

  it('returns nothing for an unknown index', () => {
    expect(matchSubtitles(files(['Sintel.srt', 1000]), 5)).toEqual([]);
  });
});
