import type {
  TorrentDetail,
  TorrentSummary,
} from '../../server/torrents-api.js';

// Made-up torrents for tests (and the 2.7 component gallery), shaped like
// the server's answers. Never imported by main.ts.

export const SAMPLE_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';

export function sampleSummary(
  overrides: Partial<TorrentSummary> = {},
): TorrentSummary {
  return {
    infoHash: SAMPLE_HASH,
    name: 'Sintel',
    magnetURI: `magnet:?xt=urn:btih:${SAMPLE_HASH}&dn=Sintel`,
    hasMetadata: true,
    ready: true,
    // Sintel.mp4 and its subtitles are downloading; the extras aren't.
    length: 231_243_404,
    selectedLength: 129_243_404,
    progress: 0.42,
    numPeers: 7,
    downloadSpeed: 1_250_000,
    uploadSpeed: 64_000,
    state: 'downloading',
    errorMessage: null,
    ...overrides,
  };
}

export function sampleDetail(
  overrides: Partial<TorrentDetail> = {},
): TorrentDetail {
  return {
    ...sampleSummary(),
    files: [
      {
        index: 0,
        name: 'Sintel.de.srt',
        path: 'Sintel/Sintel.de.srt',
        length: 1_652,
        selected: true,
        media: 'subtitle',
        sample: false,
      },
      {
        index: 1,
        name: 'Sintel.mp4',
        path: 'Sintel/Sintel.mp4',
        length: 129_241_752,
        selected: true,
        media: 'video',
        sample: false,
      },
      {
        index: 2,
        name: 'Sintel.mkv',
        path: 'Sintel/Extras/Sintel.mkv',
        length: 98_000_000,
        selected: false,
        media: 'video-may-not-play',
        sample: false,
      },
      {
        index: 3,
        name: 'sample.mp4',
        path: 'Sintel/Sample/sample.mp4',
        length: 4_000_000,
        selected: false,
        media: 'video',
        sample: true,
      },
    ],
    mainFile: 1,
    videos: [1, 2, 3],
    ...overrides,
  };
}
