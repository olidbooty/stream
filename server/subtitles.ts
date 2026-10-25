import type { Response } from 'express';
import type { TorrentFile } from 'webtorrent';

// Decision #20: subtitles reach the <video> as WebVTT. A .vtt file is served
// as is; a .srt file is converted. Both are decoded as UTF-8, falling back to
// Windows-1252, which most older .srt files use.

// Subtitles are a few hundred kilobytes at most. The cap stops a torrent from
// making the server buffer a large file it labelled .srt.
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

// Windows-1252's 0x80-0x9F, where it differs from Latin-1. Node's own
// TextDecoder('windows-1252') decodes these as Latin-1 control characters
// unless it has full ICU. Unassigned bytes stay as they are.
const CP1252_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

function decodeWindows1252(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text +=
      byte >= 0x80 && byte <= 0x9f
        ? CP1252_HIGH[byte - 0x80]
        : String.fromCharCode(byte);
  }
  return text;
}

export function decodeSubtitle(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = decodeWindows1252(bytes);
  }
  // TextDecoder drops a UTF-8 BOM itself; a BOM written as text survives.
  return text.replace(/^\uFEFF/, '');
}

const SRT_TIMING =
  /^\s*(\d+:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d+:\d{2}:\d{2})[,.](\d{3})/;

// SubRip to WebVTT: a header, `.` instead of `,` in timestamps, and no cue
// numbers. Coordinates after the timings (X1:…) are dropped; SRT's <i>, <b>
// and <u> tags are WebVTT tags too. Blocks without a timing line are skipped.
export function srtToVtt(srt: string): string {
  const blocks = srt
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.split('\n').filter((line) => line.trim() !== ''));
  const cues: string[] = [];
  for (const lines of blocks) {
    const timing = lines.findIndex((line) => SRT_TIMING.test(line));
    // The timing is the first line, or the second after a cue number.
    if (timing === -1 || timing > 1) continue;
    const [, start, startMs, end, endMs] = SRT_TIMING.exec(
      lines[timing],
    ) as RegExpExecArray;
    const text = lines.slice(timing + 1).map((line) =>
      // "-->" ends a cue's settings in WebVTT, so it can't appear in text.
      line.replaceAll('-->', '->'),
    );
    cues.push(
      [`${pad(start)}.${startMs} --> ${pad(end)}.${endMs}`, ...text].join('\n'),
    );
  }
  return `WEBVTT\n\n${cues.map((cue) => `${cue}\n\n`).join('')}`;
}

// WebVTT needs two-digit hours; SRT writers sometimes use one.
function pad(time: string): string {
  return time.length === 7 ? `0${time}` : time;
}

export function toVtt(name: string, bytes: Uint8Array): string {
  const text = decodeSubtitle(bytes);
  return name.toLowerCase().endsWith('.srt') ? srtToVtt(text) : text;
}

// Reads the whole file (WebTorrent fetches its pieces first) and sends it as
// WebVTT. If the browser gives up, the read stream is destroyed so its pieces
// stop being prioritised.
export function serveSubtitle(res: Response, file: TorrentFile): void {
  if (file.length > MAX_SUBTITLE_BYTES) {
    res.status(413).json({
      error: `Subtitle files over ${MAX_SUBTITLE_BYTES} bytes aren't served`,
    });
    return;
  }
  const send = (bytes: Uint8Array) => {
    res
      .type('text/vtt; charset=utf-8')
      .set('X-Content-Type-Options', 'nosniff')
      .send(toVtt(file.name, bytes));
  };
  if (file.length === 0) {
    send(new Uint8Array(0));
    return;
  }

  const source = file.createReadStream();
  const chunks: Uint8Array[] = [];
  let received = 0;
  res.on('close', () => source.destroy());
  source.on('data', (chunk: Uint8Array) => {
    chunks.push(chunk);
    received += chunk.length;
    if (received >= file.length) {
      source.destroy();
      send(Buffer.concat(chunks).subarray(0, file.length));
    }
  });
  source.on('error', (err) => {
    console.error('subtitle read error:', err);
  });
  // Ended or destroyed short of the file, e.g. the torrent was removed.
  source.on('close', () => {
    if (received < file.length && !res.headersSent) res.destroy();
  });
}
