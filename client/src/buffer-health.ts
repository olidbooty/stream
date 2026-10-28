import { formatSpeed } from './format.js';

// Step 3.5: how far ahead of the playhead the browser has the video, and
// whether the download behind it keeps up with playback.

// Below this many seconds ahead, a download slower than the video's bitrate
// gets a warning.
export const LOW_AHEAD_S = 10;
// Once this far ahead (or downloading fast enough), the warning goes again.
// The gap between the two stops it flickering as the speed wobbles.
export const HEALTHY_AHEAD_S = 30;
// Browsers can start a buffered range a fraction after currentTime, for
// example right after a seek.
const RANGE_SLACK_S = 0.5;

// What <video>.buffered gives: TimeRanges, or anything shaped like it.
export interface BufferedRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

// Seconds buffered from the playhead on, counting only the range it is in.
// 0 when the playhead sits in a gap, as after a seek past the buffer.
export function bufferedAhead(
  buffered: BufferedRanges,
  currentTime: number,
): number {
  for (let i = 0; i < buffered.length; i += 1) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (start <= currentTime + RANGE_SLACK_S && end >= currentTime) {
      return Math.max(end - currentTime, 0);
    }
  }
  return 0;
}

export interface BufferState {
  // From bufferedAhead().
  ahead: number;
  currentTime: number;
  // <video>.duration: NaN until the metadata loads, Infinity for a stream
  // of unknown length.
  duration: number;
  // The file's size in bytes, for its average bitrate.
  fileLength: number;
  // The torrent's download speed in bytes per second.
  downloadSpeed: number;
  // True once every selected file is on disk (state `seeding`), so the
  // speed no longer matters.
  downloaded: boolean;
}

// Bytes per second the video plays through, on average; null until its
// duration is known.
export function playbackRate(
  state: Pick<BufferState, 'duration' | 'fileLength'>,
): number | null {
  const { duration, fileLength } = state;
  if (!Number.isFinite(duration) || duration <= 0 || fileLength <= 0) {
    return null;
  }
  return fileLength / duration;
}

// True while the download is too slow to keep the buffer from running out:
// slower than the video's average bitrate with under LOW_AHEAD_S buffered.
// `wasSlow` is the last answer, so the warning stays until the buffer is
// back to HEALTHY_AHEAD_S or the speed catches up. The bitrate is an
// average, so a variable-bitrate video can stall a little before or after
// this says so.
export function isDownloadSlow(state: BufferState, wasSlow: boolean): boolean {
  const rate = playbackRate(state);
  if (state.downloaded || rate === null) return false;
  // Buffered to the end: nothing left to wait for.
  if (state.currentTime + state.ahead >= state.duration - RANGE_SLACK_S) {
    return false;
  }
  if (state.downloadSpeed >= rate) return false;
  return state.ahead < (wasSlow ? HEALTHY_AHEAD_S : LOW_AHEAD_S);
}

// The warning shown while isDownloadSlow() holds.
export function slowDownloadMessage(
  state: Pick<BufferState, 'duration' | 'fileLength' | 'downloadSpeed'>,
): string {
  const rate = playbackRate(state);
  if (state.downloadSpeed <= 0) {
    return 'Nothing is downloading: no peer is sending data right now.';
  }
  const needed = rate === null ? '' : ` of the ${formatSpeed(rate)} it needs`;
  return `Downloading at ${formatSpeed(state.downloadSpeed)}${needed}, so the video may stop to buffer.`;
}
