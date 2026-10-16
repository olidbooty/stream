// Decides which files in a torrent are worth playing (Decision #3). Pure, so
// it is tested without a client or a swarm.
//
// Classification is by file extension only. The container doesn't settle
// whether a browser can decode what's inside (HEVC in .mp4 often fails, H.264
// in .mkv often plays), so "video" means "should play" and
// "video-may-not-play" means "worth trying". Codec checks come with 4.1.

// 'video': should play in current browsers. 'video-may-not-play': video in a
// container browsers don't promise to support. 'subtitle': a text track 3.4
// could attach to the <video>.
export type MediaKind = 'video' | 'video-may-not-play' | 'subtitle' | 'other';

// The containers every current browser plays. .m4v is MP4 under another name.
const PLAYABLE_VIDEO = new Set(['mp4', 'm4v', 'webm']);

// Video containers browsers may refuse. .mkv and .mov often play in Chrome
// when they hold H.264 or VP9. .ogv is here too: Safari has never played Ogg
// and Chrome has deprecated Theora.
const OTHER_VIDEO = new Set([
  '3g2',
  '3gp',
  'asf',
  'avi',
  'divx',
  'f4v',
  'flv',
  'm2ts',
  'mkv',
  'mov',
  'mpeg',
  'mpg',
  'mts',
  'ogm',
  'ogv',
  'rm',
  'rmvb',
  'ts',
  'vob',
  'wmv',
]);

// WebVTT plays as a <track> as is; SRT needs converting first.
const SUBTITLES = new Set(['vtt', 'srt']);

// "sample" or "samples" as a word in the name or a folder, e.g.
// "Movie.Sample.mkv" or "Sample/movie.mkv", but not "Resampled".
const SAMPLE = /(^|[^a-z0-9])samples?([^a-z0-9]|$)/i;

// A sample is cut from the main video, so it's far smaller. Without the size
// check a film whose title contains "Sample" would be skipped.
const SAMPLE_MAX_FRACTION = 0.25;

// Videos at least this share of the largest one count as main features: both
// halves of a CD1/CD2 film, every episode of a season (even next to a
// double-length finale), two encodes of a film. Trailers and most extras fall
// below it.
const MAIN_MIN_FRACTION = 1 / 3;

// Numeric-aware, so "Episode 2" sorts before "Episode 10". A fixed locale keeps
// the order the same on every server.
const pathOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export interface MediaFileInput {
  index: number;
  name: string;
  path: string;
  length: number;
}

export interface FileMedia {
  media: MediaKind;
  // A short sample clip of another video in the torrent. Only videos can be samples.
  sample: boolean;
}

export interface MediaSelection<F extends MediaFileInput> {
  // The input files in their original order, each with its classification.
  files: (F & FileMedia)[];
  // Index of the file to play by default, or null if there's no video.
  mainFile: number | null;
  // Indexes of all videos: main-sized ones, then the smaller ones such as
  // extras, then samples, each group in path order.
  videos: number[];
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function mediaKind(name: string): MediaKind {
  const ext = extension(name);
  if (PLAYABLE_VIDEO.has(ext)) return 'video';
  if (OTHER_VIDEO.has(ext)) return 'video-may-not-play';
  if (SUBTITLES.has(ext)) return 'subtitle';
  return 'other';
}

function isVideo(media: MediaKind): boolean {
  return media === 'video' || media === 'video-may-not-play';
}

// Main file: among the main-sized videos, the first in path order that should
// play, or else the first that may not. So a film's .mp4 encode wins over its
// .mkv one, a season starts at episode 1, and a short .mp4 trailer never
// beats a full-length .mkv.
export function selectMedia<F extends MediaFileInput>(files: readonly F[]): MediaSelection<F> {
  const classified = files.map((file) => ({ ...file, media: mediaKind(file.name), sample: false }));
  const videos = classified.filter((file) => isVideo(file.media));
  // reduce rather than Math.max(...): a torrent can hold more files than a
  // call can take arguments.
  const largest = videos.reduce((max, file) => Math.max(max, file.length), 0);

  for (const video of videos) {
    video.sample = SAMPLE.test(video.path) && video.length < largest * SAMPLE_MAX_FRACTION;
  }

  // 0: main-sized, 1: smaller (extras), 2: sample. A sample is under
  // SAMPLE_MAX_FRACTION, so it is never main-sized.
  const group = (file: FileMedia & MediaFileInput): number =>
    file.sample ? 2 : file.length >= largest * MAIN_MIN_FRACTION ? 0 : 1;
  const ordered = videos.toSorted(
    (a, b) => group(a) - group(b) || pathOrder.compare(a.path, b.path) || a.index - b.index,
  );
  const candidates = ordered.filter((file) => group(file) === 0);
  const main = candidates.find((file) => file.media === 'video') ?? candidates[0];

  return {
    files: classified,
    mainFile: main?.index ?? null,
    videos: ordered.map((file) => file.index),
  };
}
