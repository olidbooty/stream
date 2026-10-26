import { execFile } from 'node:child_process';

// Step 4.1: what a media file holds, from ffprobe. The codec audit uses it
// through `npm run probe`, and 4.2b will probe a torrent file through its own
// stream URL before playing it. ffprobe is optional (Decision #17), so
// nothing at startup needs it.

const FFPROBE_ARGS = [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
];

export const PROBE_TIMEOUT_MS = 15_000;

// ffprobe's JSON for a file with a dozen streams is a few kilobytes; the
// limit only stops a broken file from filling memory.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProbeOptions {
  command?: string;
  // Arguments before ffprobe's own, so tests can run a stand-in script.
  prefixArgs?: string[];
  timeoutMs?: number;
}

export class ProbeError extends Error {}

// Runs ffprobe on a path or an http(s) URL and returns its parsed JSON.
// The input is one argument of an array, never a shell string, so a file
// name can't run commands. Rejects with a ProbeError if ffprobe is missing,
// times out, fails or prints something that isn't JSON.
export function runFfprobe(
  input: string,
  {
    command = 'ffprobe',
    prefixArgs = [],
    timeoutMs = PROBE_TIMEOUT_MS,
  }: ProbeOptions = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      // `--` isn't understood by ffprobe; `file:` keeps a name that starts
      // with `-` from being read as an option.
      [...prefixArgs, ...FFPROBE_ARGS, inputArg(input)],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const message =
            code === 'ENOENT'
              ? `${command} not found; install ffmpeg to probe files`
              : error.killed
                ? `${command} timed out after ${timeoutMs} ms`
                : stderr.trim() || error.message;
          reject(new ProbeError(message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new ProbeError(`${command} printed invalid JSON`));
        }
      },
    );
  });
}

function inputArg(input: string): string {
  return /^https?:\/\//i.test(input) || input.startsWith('file:')
    ? input
    : `file:${input}`;
}

export interface VideoStream {
  codec: string;
  profile: string | null;
  // Bits per sample, from the pixel format: 10-bit H.264 (High 10) plays in
  // far fewer browsers than 8-bit.
  bitDepth: number | null;
  width: number | null;
  height: number | null;
}

export interface AudioStream {
  codec: string;
  profile: string | null;
  channels: number | null;
  language: string | null;
}

export interface SubtitleStream {
  codec: string;
  language: string | null;
}

export interface ProbeSummary {
  // ffprobe's format_name, such as `matroska,webm` or `mov,mp4,m4a,3gp,3g2,mj2`.
  container: string | null;
  durationSeconds: number | null;
  // The first real video stream. Cover art (an attached picture) is skipped.
  video: VideoStream | null;
  audio: AudioStream[];
  subtitles: SubtitleStream[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value !== 'unknown'
    ? value
    : null;
}

// ffprobe prints some numbers as strings (duration, bits_per_raw_sample).
function number(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function language(stream: Json): string | null {
  const tags = isObject(stream.tags) ? stream.tags : {};
  const lang = text(tags.language);
  return lang === 'und' ? null : lang;
}

// yuv420p10le -> 10; yuv420p, nv12 -> 8.
function bitDepth(stream: Json): number | null {
  const raw = number(stream.bits_per_raw_sample);
  if (raw !== null) return raw;
  const format = text(stream.pix_fmt);
  if (format === null) return null;
  const match = /p(\d+)(?:le|be)$/.exec(format);
  return match ? Number(match[1]) : 8;
}

function isAttachedPicture(stream: Json): boolean {
  return isObject(stream.disposition) && stream.disposition.attached_pic === 1;
}

// Reduces ffprobe's JSON to what decides whether a browser plays the file.
// Pure, so the rules 4.2b builds on it are tested on stored ffprobe output
// and the tests never need ffprobe.
export function summarizeProbe(json: unknown): ProbeSummary {
  const root = isObject(json) ? json : {};
  const format = isObject(root.format) ? root.format : {};
  const streams = Array.isArray(root.streams)
    ? root.streams.filter(isObject)
    : [];

  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && !isAttachedPicture(s),
  );
  return {
    container: text(format.format_name),
    durationSeconds: number(format.duration),
    video: videoStream
      ? {
          codec: text(videoStream.codec_name) ?? 'unknown',
          profile: text(videoStream.profile),
          bitDepth: bitDepth(videoStream),
          width: number(videoStream.width),
          height: number(videoStream.height),
        }
      : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        codec: text(s.codec_name) ?? 'unknown',
        profile: text(s.profile),
        channels: number(s.channels),
        language: language(s),
      })),
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        codec: text(s.codec_name) ?? 'unknown',
        language: language(s),
      })),
  };
}
