import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProbeError, runFfprobe, summarizeProbe } from './probe.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'probe');

async function probeFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('summarizeProbe', () => {
  // ffprobe output for the step 4.1 clips (npm run codec-clips).
  it.each([
    ['mp4-h264-aac', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'High', 8, 'aac'],
    [
      'mp4-h264high10-aac',
      'mov,mp4,m4a,3gp,3g2,mj2',
      'h264',
      'High 10',
      10,
      'aac',
    ],
    ['mp4-hevc-aac', 'mov,mp4,m4a,3gp,3g2,mj2', 'hevc', 'Main', 8, 'aac'],
    ['mp4-av1-opus', 'mov,mp4,m4a,3gp,3g2,mj2', 'av1', 'Main', 8, 'opus'],
    ['mp4-h264-mp3', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'High', 8, 'mp3'],
    ['mp4-h264-ac3', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'High', 8, 'ac3'],
    ['mp4-h264-eac3', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'High', 8, 'eac3'],
    ['mkv-h264-aac', 'matroska,webm', 'h264', 'High', 8, 'aac'],
    ['mkv-h264-ac3', 'matroska,webm', 'h264', 'High', 8, 'ac3'],
    ['mkv-h264-dts', 'matroska,webm', 'h264', 'High', 8, 'dts'],
    ['mkv-h264-flac', 'matroska,webm', 'h264', 'High', 8, 'flac'],
    ['mkv-hevc-aac', 'matroska,webm', 'hevc', 'Main', 8, 'aac'],
    ['webm-vp9-opus', 'matroska,webm', 'vp9', 'Profile 0', 8, 'opus'],
    ['webm-vp8-vorbis', 'matroska,webm', 'vp8', '0', 8, 'vorbis'],
    ['webm-av1-opus', 'matroska,webm', 'av1', 'Main', 8, 'opus'],
    ['avi-xvid-mp3', 'avi', 'mpeg4', 'Simple Profile', 8, 'mp3'],
    ['mov-h264-aac', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'High', 8, 'aac'],
    ['ts-h264-aac', 'mpegts', 'h264', 'High', 8, 'aac'],
    ['ogv-theora-vorbis', 'ogg', 'theora', null, 8, 'vorbis'],
  ])('%s', async (name, container, codec, profile, bitDepth, audio) => {
    const summary = summarizeProbe(await probeFixture(name));
    expect(summary.container).toBe(container);
    expect(summary.durationSeconds).toBeCloseTo(10, 0);
    expect(summary.video).toMatchObject({
      codec,
      profile,
      bitDepth,
      width: 640,
      height: 360,
    });
    expect(summary.audio.map((a) => a.codec)).toEqual([audio]);
    expect(summary.subtitles).toEqual([]);
  });

  it('reports surround sound channels', async () => {
    const summary = summarizeProbe(await probeFixture('mkv-h264-dts'));
    expect(summary.audio[0]).toMatchObject({ profile: 'DTS', channels: 6 });
  });

  it('skips cover art and lists every audio and subtitle stream', () => {
    const summary = summarizeProbe({
      format: { format_name: 'matroska,webm', duration: '5400.5' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: 'video',
          codec_name: 'hevc',
          profile: 'Main 10',
          pix_fmt: 'yuv420p10le',
          width: 1920,
          height: 1080,
        },
        {
          codec_type: 'audio',
          codec_name: 'eac3',
          channels: 6,
          tags: { language: 'eng' },
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          profile: 'LC',
          channels: 2,
          tags: { language: 'und' },
        },
        {
          codec_type: 'subtitle',
          codec_name: 'subrip',
          tags: { language: 'fre' },
        },
        { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
        { codec_type: 'data', codec_name: 'bin_data' },
      ],
    });
    expect(summary).toEqual({
      container: 'matroska,webm',
      durationSeconds: 5400.5,
      video: {
        codec: 'hevc',
        profile: 'Main 10',
        bitDepth: 10,
        width: 1920,
        height: 1080,
      },
      audio: [
        { codec: 'eac3', profile: null, channels: 6, language: 'eng' },
        { codec: 'aac', profile: 'LC', channels: 2, language: null },
      ],
      subtitles: [
        { codec: 'subrip', language: 'fre' },
        { codec: 'hdmv_pgs_subtitle', language: null },
      ],
    });
  });

  it('prefers bits_per_raw_sample over the pixel format', () => {
    const summary = summarizeProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          bits_per_raw_sample: '10',
          pix_fmt: 'yuv420p',
        },
      ],
    });
    expect(summary.video?.bitDepth).toBe(10);
  });

  it('returns an empty summary for a file with no streams', () => {
    expect(summarizeProbe({ format: { format_name: 'mp3' } })).toEqual({
      container: 'mp3',
      durationSeconds: null,
      video: null,
      audio: [],
      subtitles: [],
    });
  });

  it.each([
    null,
    'text',
    [],
    { streams: 'x', format: [] },
    {
      streams: [null, 1, { codec_type: 'video' }],
      format: { duration: 'N/A' },
    },
  ])('tolerates malformed output %j', (json) => {
    const summary = summarizeProbe(json);
    expect(summary.container).toBeNull();
    expect(summary.durationSeconds).toBeNull();
    expect(summary.audio).toEqual([]);
    if (summary.video) expect(summary.video.codec).toBe('unknown');
  });
});

// A stand-in for ffprobe: a Node script run through prefixArgs, so these
// tests never need ffmpeg installed.
describe('runFfprobe', () => {
  let dir: string;
  let fake: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'probe-test-'));
    fake = join(dir, 'fake-ffprobe.mjs');
    await writeFile(
      fake,
      `const args = process.argv.slice(2);
const input = args.at(-1);
if (input.endsWith('fail')) { console.error('Invalid data found'); process.exit(1); }
if (input.endsWith('garbage')) { console.log('not json'); process.exit(0); }
if (input.endsWith('slow')) setTimeout(() => {}, 10_000);
else console.log(JSON.stringify({ args }));
`,
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const options = () => ({
    command: process.execPath,
    prefixArgs: [fake],
  });

  it('passes the input as one argument after the JSON options', async () => {
    const result = await runFfprobe('My Film; rm -rf ~.mkv', options());
    expect(result).toEqual({
      args: [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'file:My Film; rm -rf ~.mkv',
      ],
    });
  });

  it('reads a name starting with a dash as a file', async () => {
    const result = (await runFfprobe('-i.mp4', options())) as {
      args: string[];
    };
    expect(result.args.at(-1)).toBe('file:-i.mp4');
  });

  it('passes URLs as they are', async () => {
    const url = 'http://127.0.0.1:1234/api/torrents/abc/files/0/stream';
    const result = (await runFfprobe(url, options())) as { args: string[] };
    expect(result.args.at(-1)).toBe(url);
  });

  it("rejects with ffprobe's message when it fails", async () => {
    await expect(runFfprobe('x.fail', options())).rejects.toThrow(
      new ProbeError('Invalid data found'),
    );
  });

  it('rejects when the output is not JSON', async () => {
    await expect(runFfprobe('x.garbage', options())).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it('rejects when ffprobe takes too long', async () => {
    await expect(
      runFfprobe('x.slow', { ...options(), timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200 ms/);
  });

  it('says so when ffprobe is not installed', async () => {
    await expect(
      runFfprobe('x.mp4', { command: join(dir, 'no-such-ffprobe') }),
    ).rejects.toThrow(/not found; install ffmpeg/);
  });
});
