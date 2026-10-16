import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import parseTorrent, { toMagnetURI, type Instance as ParsedTorrent } from 'parse-torrent';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { EventStream, SSE_HEADERS } from './event-stream.js';
import { isMagnetURI } from './magnet.js';
import { addTorrent, removeTorrent } from './torrent-client.js';
import { TorrentWatch, torrentState, type TorrentState } from './torrent-state.js';

// A .torrent file holds 20 bytes per piece, so even a 100 GB torrent with
// 256 KiB pieces needs about 8 MB. Most are well under 1 MB.
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;

const INFO_HASH = /^[0-9a-f]{40}$/i;

export interface TorrentsRouterOptions {
  client: WebTorrent;
  downloadDir: string;
}

// What the list and the event stream show per torrent.
export interface TorrentSummary {
  infoHash: string;
  name: string | null;
  magnetURI: string;
  // False while a magnet link's metadata is still being fetched from peers.
  hasMetadata: boolean;
  // True once WebTorrent has also checked any data already on disk, so the
  // files can be streamed. Can lag hasMetadata for a large existing download.
  ready: boolean;
  // Total size in bytes; null until the metadata arrives.
  length: number | null;
  progress: number;
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
  // See torrentState(). An `error` torrent is no longer in the client; it is
  // listed until it is deleted or added again.
  state: TorrentState;
  // Why it failed; null unless state is `error`.
  errorMessage: string | null;
}

export interface TorrentFileInfo {
  // Position in the torrent; stable, so later steps can address files by it.
  index: number;
  name: string;
  // Relative to DOWNLOAD_DIR, e.g. "Sintel/Sintel.mp4" for a multi-file torrent.
  path: string;
  length: number;
}

// One torrent with its files; files is null while the metadata is pending.
export interface TorrentDetail extends TorrentSummary {
  files: TorrentFileInfo[] | null;
}

// `metadata` is set as soon as the info dictionary arrives. `ready` comes
// later, after WebTorrent verifies existing data, so it would hide the files
// of a large torrent for no reason.
function hasMetadata(torrent: Torrent): boolean {
  return torrent.metadata != null;
}

// Right after add() the real client hasn't parsed the torrent yet, so the
// caller passes the parsed torrent it already has.
function summarize(torrent: Torrent, watch: TorrentWatch, parsed?: ParsedTorrent): TorrentSummary {
  return {
    infoHash: torrent.infoHash || (parsed?.infoHash ?? ''),
    name: torrent.name || parsed?.name || null,
    magnetURI: torrent.magnetURI || (parsed ? toMagnetURI(parsed) : ''),
    hasMetadata: hasMetadata(torrent),
    ready: torrent.ready,
    length: hasMetadata(torrent) ? torrent.length : null,
    progress: torrent.progress,
    numPeers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    state: torrentState({
      failed: false,
      done: torrent.done,
      hasMetadata: hasMetadata(torrent),
      numPeers: torrent.numPeers,
      noPeersReported: watch.noPeersReported(torrent),
    }),
    errorMessage: null,
  };
}

function describe(torrent: Torrent, watch: TorrentWatch): TorrentDetail {
  return {
    ...summarize(torrent, watch),
    files: hasMetadata(torrent)
      ? torrent.files.map((file, index) => ({
          index,
          name: file.name,
          path: file.path,
          length: file.length,
        }))
      : null,
  };
}

function sendError(res: Response, status: number, error: string, extra: object = {}): void {
  res.status(status).json({ error, ...extra });
}

export function torrentsRouter({ client, downloadDir }: TorrentsRouterOptions): Router {
  const router = Router();
  const watch = new TorrentWatch(client);

  const findTorrent = (infoHash: string): Torrent | undefined =>
    client.torrents.find((torrent) => torrent.infoHash === infoHash);

  // Resolves :infoHash to a running torrent or a failed one, or sends the
  // 400/404 and returns undefined.
  const torrentFromParams = (
    req: Request,
    res: Response,
  ): { torrent?: Torrent; failed?: TorrentSummary } | undefined => {
    const infoHash = String(req.params.infoHash);
    if (!INFO_HASH.test(infoHash)) {
      sendError(res, 400, 'infoHash must be 40 hex characters');
      return undefined;
    }
    const torrent = findTorrent(infoHash.toLowerCase());
    if (torrent) return { torrent };
    const failed = watch.getFailed(infoHash.toLowerCase());
    if (failed) return { failed };
    sendError(res, 404, 'No torrent with that info hash');
    return undefined;
  };

  const list = (): TorrentSummary[] => [
    ...client.torrents.map((torrent) => summarize(torrent, watch)),
    ...watch.failed(),
  ];

  const events = new EventStream('torrents', list);

  router.get('/', (req, res) => {
    res.json(list());
  });

  // Server-sent events: the same list as GET /, sent at once and then
  // whenever it changes, checked once a second. Registered before /:infoHash,
  // which would answer 400 for "events".
  router.get('/events', (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    events.subscribe(res);
  });

  // Takes JSON { "magnet": "magnet:?..." } or a .torrent file sent as the raw
  // body with Content-Type application/x-bittorrent.
  router.post(
    '/',
    express.json(),
    express.raw({ type: 'application/x-bittorrent', limit: MAX_TORRENT_FILE_BYTES }),
    async (req, res) => {
      let torrentId: string | Uint8Array;
      if (req.is('application/x-bittorrent')) {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return sendError(res, 400, 'The .torrent file is empty');
        }
        torrentId = req.body;
      } else if (req.is('application/json')) {
        const magnet: unknown = req.body?.magnet;
        if (!isMagnetURI(magnet)) {
          return sendError(res, 400, 'magnet must be a magnet: link with a BitTorrent info hash');
        }
        torrentId = magnet;
      } else {
        return sendError(
          res,
          415,
          'Send JSON {"magnet": "..."} or a .torrent file as application/x-bittorrent',
        );
      }

      let parsed: ParsedTorrent;
      try {
        parsed = await parseTorrent(torrentId);
      } catch {
        return sendError(res, 400, 'Not a valid .torrent file');
      }

      const existing = findTorrent(parsed.infoHash);
      if (existing) {
        return sendError(res, 409, 'This torrent has already been added', {
          torrent: summarize(existing, watch),
        });
      }

      // Hand over the parsed torrent so WebTorrent never re-reads the input.
      const torrent = addTorrent(client, parsed, downloadDir);
      watch.watch(torrent, parsed.infoHash, () => summarize(torrent, watch, parsed));
      res
        .status(201)
        .location(`${req.baseUrl}/${parsed.infoHash}`)
        .json(summarize(torrent, watch, parsed));
    },
  );

  // 200 either way: a torrent still fetching its metadata is a normal state,
  // reported as hasMetadata: false with files and length null. A failed
  // torrent has no files any more, so they are null too.
  router.get('/:infoHash', (req, res) => {
    const found = torrentFromParams(req, res);
    if (found?.torrent) res.json(describe(found.torrent, watch));
    else if (found?.failed) res.json({ ...found.failed, files: null } satisfies TorrentDetail);
  });

  router.delete('/:infoHash', async (req, res) => {
    const found = torrentFromParams(req, res);
    if (!found) return;
    if (found.torrent) await removeTorrent(client, found.torrent.infoHash);
    else if (found.failed) watch.forget(found.failed.infoHash);
    res.status(204).end();
  });

  // Body parser errors carry a status: 413 for an oversized .torrent file,
  // 400 for malformed JSON. Anything else is ours.
  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.too.large') {
      return sendError(res, 413, `The .torrent file is larger than ${MAX_TORRENT_FILE_BYTES} bytes`);
    }
    if (err?.type === 'entity.parse.failed') {
      return sendError(res, 400, 'The request body is not valid JSON');
    }
    console.error('torrent API error:', err);
    sendError(res, 500, 'Internal error');
  };
  router.use(onError);

  return router;
}
