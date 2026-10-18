import type { Request, Response } from 'express';
import type { TorrentFile } from 'webtorrent';

// Types a browser may render or play from our origin. Anything else in a
// torrent, such as an .html or .svg file, is sent as a download, so it can't
// run script on the page that controls the API.
const INLINE_TYPE = /^(video|audio)\/|^text\/vtt$/;

function contentType(file: Pick<TorrentFile, 'type'>): string {
  return INLINE_TYPE.test(file.type) ? file.type : 'application/octet-stream';
}

// Serves one file of a torrent, or the byte range a Range header asks for.
// file.createReadStream() makes WebTorrent fetch that range's pieces first,
// so a <video> can start and seek before the download is done.
export function streamFile(
  req: Request,
  res: Response,
  file: TorrentFile,
): void {
  const type = contentType(file);
  res.set({
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  });
  if (type === 'application/octet-stream') res.attachment(file.name);
  // After attachment(), which sets a type from the name.
  res.type(type);

  // undefined: no Range header. -2: malformed, which a server ignores, as it
  // does a unit other than bytes. Several ranges (rare; browsers ask for one)
  // also get the whole file rather than a multipart response.
  const ranges = req.range(file.length, { combine: true });
  if (ranges === -1) {
    res.status(416).set('Content-Range', `bytes */${file.length}`).end();
    return;
  }
  let start = 0;
  let end = file.length - 1;
  if (
    ranges !== undefined &&
    ranges !== -2 &&
    ranges.type === 'bytes' &&
    ranges.length === 1
  ) {
    ({ start, end } = ranges[0]);
    res
      .status(206)
      .set('Content-Range', `bytes ${start}-${end}/${file.length}`);
  }
  const length = end - start + 1;
  res.set('Content-Length', String(length));

  // A HEAD request, or an empty file, has no body; don't make WebTorrent
  // start fetching pieces for nothing.
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  sendStream(file.createReadStream({ start, end }), res, length);
}

// Copies exactly `length` bytes to the response. Not stream.pipeline(): it
// doesn't destroy WebTorrent's streamx streams when the response closes, and
// a stream left running keeps its pieces prioritised. Every seek in a <video>
// aborts one request and starts another.
function sendStream(
  source: ReturnType<TorrentFile['createReadStream']>,
  res: Response,
  length: number,
): void {
  let left = length;

  res.on('close', () => source.destroy());
  res.on('drain', () => source.resume());

  source.on('data', (chunk: Uint8Array) => {
    if (left === 0) return;
    // WebTorrent reads `end: 0` as "to the end of the file", so a request
    // for just the first byte gets more than it asked for.
    const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
    left -= part.length;
    if (left === 0) {
      res.end(part);
      source.destroy();
    } else if (!res.write(part)) {
      source.pause();
    }
  });
  source.on('error', (err) => {
    console.error('torrent file stream error:', err);
  });
  // The stream ended or was destroyed short of the range: the torrent was
  // removed, or reading the store failed. Drop the connection so the browser
  // sees an error rather than a body cut short with no warning.
  source.on('close', () => {
    if (left > 0) res.destroy();
  });
}
