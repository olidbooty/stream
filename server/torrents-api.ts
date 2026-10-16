import express, { Router, type ErrorRequestHandler, type Response } from 'express';
import parseTorrent, { toMagnetURI, type Instance as ParsedTorrent } from 'parse-torrent';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { isMagnetURI } from './magnet.js';
import { addTorrent, removeTorrent } from './torrent-client.js';

// A .torrent file holds 20 bytes per piece, so even a 100 GB torrent with
// 256 KiB pieces needs about 8 MB. Most are well under 1 MB.
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;

const INFO_HASH = /^[0-9a-f]{40}$/i;

export interface TorrentsRouterOptions {
  client: WebTorrent;
  downloadDir: string;
}

// What the list shows per torrent. Files and sizes come with metadata in 2.3,
// and live progress is pushed in 2.4.
export interface TorrentSummary {
  infoHash: string;
  name: string | null;
  magnetURI: string;
  ready: boolean;
  progress: number;
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
}

// Right after add() the real client hasn't parsed the torrent yet, so the
// caller passes the parsed torrent it already has.
function summarize(torrent: Torrent, parsed?: ParsedTorrent): TorrentSummary {
  return {
    infoHash: torrent.infoHash || (parsed?.infoHash ?? ''),
    name: torrent.name || parsed?.name || null,
    magnetURI: torrent.magnetURI || (parsed ? toMagnetURI(parsed) : ''),
    ready: torrent.ready,
    progress: torrent.progress,
    numPeers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
  };
}

function sendError(res: Response, status: number, error: string, extra: object = {}): void {
  res.status(status).json({ error, ...extra });
}

export function torrentsRouter({ client, downloadDir }: TorrentsRouterOptions): Router {
  const router = Router();

  const findTorrent = (infoHash: string): Torrent | undefined =>
    client.torrents.find((torrent) => torrent.infoHash === infoHash);

  router.get('/', (req, res) => {
    res.json(client.torrents.map((torrent) => summarize(torrent)));
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
          torrent: summarize(existing),
        });
      }

      // Hand over the parsed torrent so WebTorrent never re-reads the input.
      const torrent = addTorrent(client, parsed, downloadDir);
      res
        .status(201)
        .location(`${req.baseUrl}/${parsed.infoHash}`)
        .json(summarize(torrent, parsed));
    },
  );

  router.delete('/:infoHash', async (req, res) => {
    const { infoHash } = req.params;
    if (!INFO_HASH.test(infoHash)) {
      return sendError(res, 400, 'infoHash must be 40 hex characters');
    }
    if (!findTorrent(infoHash.toLowerCase())) {
      return sendError(res, 404, 'No torrent with that info hash');
    }
    await removeTorrent(client, infoHash.toLowerCase());
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
