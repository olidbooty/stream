import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runFfprobe } from '../server/probe.js';

// Step 4.1: short synthetic clips covering the container and codec pairs
// torrents commonly hold, for the browser support matrix in ARCHITECTURE.md.
// Made with ffmpeg so nothing copyrighted is shared.
//
//   npm run codec-clips [-- <dir>]              clips into <dir> (default codec-clips/)
//   npm run codec-clips -- <dir> --fixtures <d> also save each clip's ffprobe JSON

const run = promisify(execFile);

const SECONDS = '10';
const PICTURE = `testsrc2=size=640x360:rate=25:duration=${SECONDS}`;
const SOUND = `sine=frequency=440:beep_factor=4:duration=${SECONDS}`;

const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
// Safari only plays HEVC in MP4 tagged hvc1; ffmpeg's default is hev1.
const HEVC = [
  '-c:v',
  'libx265',
  '-preset',
  'fast',
  '-x265-params',
  'log-level=error',
];
const AAC = ['-c:a', 'aac', '-b:a', '128k'];
const SURROUND = ['-ac', '6'];
// ffmpeg's built-in Vorbis encoder, because Homebrew's ffmpeg has no
// libvorbis. It is marked experimental and only encodes stereo.
const VORBIS = ['-c:a', 'vorbis', '-strict', '-2', '-ac', '2'];

interface Clip {
  file: string;
  args: string[];
}

export const CLIPS: Clip[] = [
  { file: 'mp4-h264-aac.mp4', args: [...H264, ...AAC] },
  {
    file: 'mp4-h264high10-aac.mp4',
    args: [
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p10le',
      ...AAC,
    ],
  },
  { file: 'mp4-hevc-aac.mp4', args: [...HEVC, '-tag:v', 'hvc1', ...AAC] },
  {
    file: 'mp4-av1-opus.mp4',
    args: ['-c:v', 'libsvtav1', '-preset', '10', '-c:a', 'libopus'],
  },
  { file: 'mp4-h264-mp3.mp4', args: [...H264, '-c:a', 'libmp3lame'] },
  { file: 'mp4-h264-ac3.mp4', args: [...H264, '-c:a', 'ac3', ...SURROUND] },
  { file: 'mp4-h264-eac3.mp4', args: [...H264, '-c:a', 'eac3', ...SURROUND] },
  { file: 'mkv-h264-aac.mkv', args: [...H264, ...AAC] },
  { file: 'mkv-h264-ac3.mkv', args: [...H264, '-c:a', 'ac3', ...SURROUND] },
  {
    file: 'mkv-h264-dts.mkv',
    args: [...H264, '-c:a', 'dca', '-strict', '-2', ...SURROUND],
  },
  { file: 'mkv-h264-flac.mkv', args: [...H264, '-c:a', 'flac'] },
  { file: 'mkv-hevc-aac.mkv', args: [...HEVC, ...AAC] },
  {
    file: 'webm-vp9-opus.webm',
    args: [
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '1M',
      '-c:a',
      'libopus',
    ],
  },
  {
    file: 'webm-vp8-vorbis.webm',
    args: [
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '1M',
      ...VORBIS,
    ],
  },
  {
    file: 'webm-av1-opus.webm',
    args: ['-c:v', 'libsvtav1', '-preset', '10', '-c:a', 'libopus'],
  },
  {
    file: 'avi-xvid-mp3.avi',
    // ffmpeg's own MPEG-4 Part 2 encoder tagged as Xvid, which is what
    // players see in an Xvid file; libxvid isn't in every ffmpeg build.
    args: ['-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '5', '-c:a', 'libmp3lame'],
  },
  { file: 'mov-h264-aac.mov', args: [...H264, ...AAC] },
  { file: 'ts-h264-aac.ts', args: [...H264, ...AAC] },
  {
    file: 'ogv-theora-vorbis.ogv',
    // Theora has no built-in encoder: this clip needs libtheora.
    args: ['-c:v', 'libtheora', '-q:v', '6', ...VORBIS],
  },
];

const INSTALL_FFMPEG = `ffmpeg not found. Install it and run this again:
  macOS:                 brew install ffmpeg
  Debian, Ubuntu, Pi OS: sudo apt install ffmpeg`;

async function makeClip(dir: string, clip: Clip): Promise<string> {
  const output = join(dir, clip.file);
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    PICTURE,
    '-f',
    'lavfi',
    '-i',
    SOUND,
    ...clip.args,
    // MP4 and MOV: index first, so playback starts before the whole file is
    // there, as with most files made for streaming.
    ...(/\.(mp4|mov)$/.test(clip.file) ? ['-movflags', '+faststart'] : []),
    output,
  ]);
  return output;
}

// ffprobe's JSON with the path left out, so fixtures don't depend on where
// the clips were made.
function fixture(json: unknown): string {
  const copy = structuredClone(json) as { format?: { filename?: string } };
  if (copy.format) copy.format.filename = undefined;
  return `${JSON.stringify(copy, null, 2)}\n`;
}

async function main(argv: string[]): Promise<void> {
  const fixturesAt = argv.indexOf('--fixtures');
  const fixturesDir =
    fixturesAt === -1 ? null : resolve(argv.splice(fixturesAt, 2)[1] ?? '');
  const dir = resolve(argv[0] ?? 'codec-clips');
  try {
    await run('ffmpeg', ['-version']);
  } catch {
    console.error(INSTALL_FFMPEG);
    process.exitCode = 1;
    return;
  }
  await mkdir(dir, { recursive: true });
  if (fixturesDir) await mkdir(fixturesDir, { recursive: true });

  const failed: string[] = [];
  for (const clip of CLIPS) {
    let output: string;
    try {
      output = await makeClip(dir, clip);
    } catch (error) {
      // Usually an encoder this ffmpeg build lacks; the other clips still
      // make a useful matrix.
      const stderr = (error as { stderr?: string }).stderr?.trim();
      console.error(`${clip.file}: ${stderr || String(error)}`);
      failed.push(clip.file);
      continue;
    }
    console.log(output);
    if (fixturesDir) {
      const json = await runFfprobe(output);
      await writeFile(
        join(fixturesDir, `${parse(clip.file).name}.json`),
        fixture(json),
      );
    }
  }
  if (failed.length > 0) {
    console.error(
      `${failed.length} of ${CLIPS.length} clips failed, most likely an ` +
        'encoder missing from this ffmpeg build. The others are ready.',
    );
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
