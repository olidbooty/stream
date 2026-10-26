import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  Router,
} from 'express';
import parseTorrent, {
  type Instance as ParsedTorrent,
  toMagnetURI,
} from 'parse-torrent';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { EventStream, SSE_HEADERS } from './event-stream.js';
import { streamFile } from './file-stream.js';
import { isMagnetURI } from './magnet.js';
import {
  type FileMedia,
  type MediaFileInput,
  type MediaSelection,
  matchSubtitles,
  mediaKind,
  type SubtitleMatch,
  selectMedia,
} from './media.js';
import type { SavedTorrent, SavedTorrents } from './saved-torrents.js';
import { serveSubtitle } from './subtitles.js';
import {
  addTorrent,
  pauseTorrent,
  removeTorrent,
  resumeTorrent,
} from './torrent-client.js';
import {
  isVideoFile,
  mediaInputs,
  selectionProgress,
  TorrentSelection,
} from './torrent-selection.js';
import { filterSources } from './torrent-sources.js';
import {
  type TorrentState,
  TorrentWatch,
  torrentState,
} from './torrent-state.js';

// A .torrent file holds 20 bytes per piece, so even a 100 GB torrent with
// 256 KiB pieces needs about 8 MB. Most are well under 1 MB.
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;

// Decision #21: each open event stream holds a socket and costs a JSON
// serialisation per second, so the server limits them. One per visible tab is
// far below this on a home LAN.
export const MAX_EVENT_STREAMS = 32;

// How long a refused event stream client should wait before trying again.
const EVENT_STREAM_RETRY_SECONDS = 10;

const INFO_HASH = /^[0-9a-f]{40}$/i;
const FILE_INDEX = /^(0|[1-9][0-9]{0,8})$/;

export interface TorrentsRouterOptions {
  client: WebTorrent;
  downloadDir: string;
  // Open event streams allowed at once; tests lower it.
  maxEventStreams?: number;
  // Decision #13: where torrents are saved so they survive a restart, and the
  // ones saved last time, to add again now. Without it nothing is saved.
  saved?: SavedTorrents;
  restore?: readonly SavedTorrent[];
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
  // Bytes in the files being downloaded (Decision #18): the main video and
  // its subtitles, plus any other video played. Null until the metadata
  // arrives.
  selectedLength: number | null;
  // Share of the selected bytes on disk, 0 to 1 (Decision #23).
  progress: number;
  // Index of the file to play by default; null until the metadata arrives,
  // and for a torrent with no video.
  mainFile: number | null;
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
  // See torrentState(). An `error` torrent is no longer in the client; it is
  // listed until it is deleted or added again.
  state: TorrentState;
  // Why it failed; null unless state is `error`.
  errorMessage: string | null;
}

// media and sample come from selectMedia() (server/media.ts).
export interface TorrentFileInfo extends FileMedia {
  // Position in the torrent; stable, so later steps can address files by it.
  index: number;
  name: string;
  // Relative to DOWNLOAD_DIR, e.g. "Sintel/Sintel.mp4" for a multi-file torrent.
  path: string;
  length: number;
  // Downloading in the background, rather than only fetched while played.
  selected: boolean;
  // For a video, the subtitle files that go with it (Decision #20); empty
  // for anything else.
  subtitles: SubtitleMatch[];
}

// One torrent with its files. files and videos are null while the metadata
// is pending.
export interface TorrentDetail extends TorrentSummary {
  files: TorrentFileInfo[] | null;
  // Indexes of every video file, in the order to list them.
  videos: number[] | null;
}

// `metadata` is set as soon as the info dictionary arrives. `ready` comes
// later, after WebTorrent verifies existing data, so it would hide the files
// of a large torrent for no reason.
function hasMetadata(torrent: Torrent): boolean {
  return torrent.metadata != null;
}

// Right after add() the real client hasn't parsed the torrent yet, so the
// caller passes the parsed torrent it already has.
// What the router remembers about its torrents beyond WebTorrent's fields.
interface Tracking {
  watch: TorrentWatch;
  selection: TorrentSelection;
  // selectMedia() per torrent: the file list never changes once known, and
  // the list is summarised every second.
  media: WeakMap<Torrent, MediaSelection<MediaFileInput>>;
}

function mediaOf(
  torrent: Torrent,
  media: Tracking['media'],
): MediaSelection<MediaFileInput> {
  let result = media.get(torrent);
  if (!result) {
    result = selectMedia(mediaInputs(torrent));
    media.set(torrent, result);
  }
  return result;
}

function summarize(
  torrent: Torrent,
  { watch, selection, media }: Tracking,
  parsed?: ParsedTorrent,
): TorrentSummary {
  const selected = hasMetadata(torrent) ? selection.get(torrent) : undefined;
  const progress = selected
    ? selectionProgress(torrent.files, selected)
    : undefined;
  return {
    infoHash: torrent.infoHash || (parsed?.infoHash ?? ''),
    name: torrent.name || parsed?.name || null,
    magnetURI: torrent.magnetURI || (parsed ? toMagnetURI(parsed) : ''),
    hasMetadata: hasMetadata(torrent),
    ready: torrent.ready,
    length: hasMetadata(torrent) ? torrent.length : null,
    selectedLength: progress?.selectedLength ?? null,
    progress: progress?.progress ?? torrent.progress,
    mainFile: hasMetadata(torrent) ? mediaOf(torrent, media).mainFile : null,
    numPeers: torrent.numPeers,
    // WebTorrent's speeds are moving averages that take seconds to fall to 0
    // after a pause, though nothing is transferring.
    downloadSpeed: torrent.paused ? 0 : torrent.downloadSpeed,
    uploadSpeed: torrent.paused ? 0 : torrent.uploadSpeed,
    state: torrentState({
      failed: false,
      paused: torrent.paused,
      done: progress?.done ?? torrent.done,
      hasMetadata: hasMetadata(torrent),
      numPeers: torrent.numPeers,
      noPeersReported: watch.noPeersReported(torrent),
    }),
    errorMessage: null,
  };
}

function describe(torrent: Torrent, tracking: Tracking): TorrentDetail {
  if (!hasMetadata(torrent)) {
    return {
      ...summarize(torrent, tracking),
      files: null,
      videos: null,
    };
  }
  const selected = tracking.selection.get(torrent);
  const { files, videos } = mediaOf(torrent, tracking.media);
  return {
    ...summarize(torrent, tracking),
    files: files.map((file) => ({
      ...file,
      selected: selected?.has(file.index) ?? false,
      subtitles: isVideoFile(file.name)
        ? matchSubtitles(files, file.index)
        : [],
    })),
    videos,
  };
}

function sendError(
  res: Response,
  status: number,
  error: string,
  extra: object = {},
): void {
  res.status(status).json({ error, ...extra });
}

export function torrentsRouter({
  client,
  downloadDir,
  maxEventStreams = MAX_EVENT_STREAMS,
  saved,
  restore = [],
}: TorrentsRouterOptions): Router {
  const router = Router();
  const watch = new TorrentWatch(client);
  // For saving: when each torrent was added and its filtered magnet link. The
  // real torrent's infoHash is only set once WebTorrent has parsed it, a tick
  // after add(), so it is kept here too.
  const origins = new WeakMap<
    Torrent,
    { infoHash: string; addedAt: number; magnetURI: string }
  >();

  // Saves what a restart needs to add the torrent again as the user left it.
  const save = (torrent: Torrent): void => {
    const origin = origins.get(torrent);
    if (!saved || !origin || !client.torrents.includes(torrent)) return;
    const { infoHash, ...choices } = origin;
    const selected = selection.get(torrent);
    void saved.save(infoHash, {
      ...choices,
      paused: torrent.paused,
      selected: selected ? [...selected].sort((a, b) => a - b) : null,
    });
  };

  const selection = new TorrentSelection(save);
  const tracking: Tracking = { watch, selection, media: new WeakMap() };

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

  // Adds a torrent that passed the checks in POST /, or one saved before the
  // last restart with what the user had chosen for it.
  const start = (parsed: ParsedTorrent, restored?: SavedTorrent): Torrent => {
    // Hand over the parsed torrent so WebTorrent never re-reads the input.
    const torrent = addTorrent(client, parsed, downloadDir);
    const { infoHash } = parsed;
    origins.set(torrent, {
      infoHash,
      addedAt: restored?.addedAt ?? Date.now(),
      magnetURI: toMagnetURI(parsed),
    });
    selection.watch(torrent, restored?.selected);
    watch.watch(torrent, infoHash, () => summarize(torrent, tracking, parsed));
    if (restored?.paused) pauseTorrent(torrent);
    if (!saved) return torrent;

    save(torrent);
    // The .torrent, so a magnet link needn't fetch its metadata again.
    const saveMetadata = () => {
      if (torrent.metadata && client.torrents.includes(torrent)) {
        void saved.saveTorrentFile(infoHash, torrent.metadata);
      }
    };
    if (torrent.metadata) saveMetadata();
    else torrent.once('metadata', saveMetadata);
    // A failed torrent's files are gone (Decision #22), so it isn't restored.
    // TorrentWatch listened first, so the failure is already recorded; it
    // isn't when WebTorrent only dropped a duplicate of a running torrent.
    torrent.once('error', () => {
      if (watch.getFailed(infoHash)) void saved.delete(infoHash);
    });
    return torrent;
  };

  for (const entry of restore) {
    // Checked again in case the saved sources predate a change to the filter.
    const filtered = filterSources(entry.parsed);
    if (findTorrent(entry.infoHash)) continue;
    start(filtered.torrent, entry);
  }

  const list = (): TorrentSummary[] => [
    ...client.torrents.map((torrent) => summarize(torrent, tracking)),
    ...watch.failed(),
  ];

  const events = new EventStream('torrents', list);

  router.get('/', (_req, res) => {
    res.json(list());
  });

  // Server-sent events: the same list as GET /, sent at once and then
  // whenever it changes, checked once a second. Registered before /:infoHash,
  // which would answer 400 for "events". Above the cap it answers 503, which
  // EventSource treats as final, so the page retries on its own timer.
  router.get('/events', (_req, res) => {
    if (events.size >= maxEventStreams) {
      res.set('Retry-After', String(EVENT_STREAM_RETRY_SECONDS));
      return sendError(res, 503, 'Too many open event streams');
    }
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    events.subscribe(res);
  });

  // Takes JSON { "magnet": "magnet:?..." } or a .torrent file sent as the raw
  // body with Content-Type application/x-bittorrent.
  router.post(
    '/',
    express.json(),
    express.raw({
      type: 'application/x-bittorrent',
      limit: MAX_TORRENT_FILE_BYTES,
    }),
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
          return sendError(
            res,
            400,
            'magnet must be a magnet: link with a BitTorrent info hash',
          );
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
      // Decision #11: drop xs= and trackers or web seeds on local addresses.
      const filtered = filterSources(parsed);
      parsed = filtered.torrent;
      if (filtered.dropped.length > 0) {
        console.warn(
          `torrent ${parsed.infoHash}: ignoring sources the server must not contact:`,
          filtered.dropped.join(', '),
        );
      }

      const existing = findTorrent(parsed.infoHash);
      if (existing) {
        return sendError(res, 409, 'This torrent has already been added', {
          torrent: summarize(existing, tracking),
        });
      }

      const torrent = start(parsed);
      res
        .status(201)
        .location(`${req.baseUrl}/${parsed.infoHash}`)
        .json(summarize(torrent, tracking, parsed));
    },
  );

  // 200 either way: a torrent still fetching its metadata is a normal state,
  // reported as hasMetadata: false with files and length null. A failed
  // torrent has no files any more, so they are null too.
  router.get('/:infoHash', (req, res) => {
    const found = torrentFromParams(req, res);
    if (found?.torrent) res.json(describe(found.torrent, tracking));
    else if (found?.failed) {
      res.json({
        ...found.failed,
        files: null,
        mainFile: null,
        videos: null,
      } satisfies TorrentDetail);
    }
  });

  // Resolves :infoHash and :index to a file of a running torrent whose file
  // list is known, or sends the error and returns undefined.
  const fileFromParams = (
    req: Request,
    res: Response,
  ): { torrent: Torrent; index: number } | undefined => {
    const found = torrentFromParams(req, res);
    if (!found) return undefined;
    if (found.failed) {
      sendError(res, 409, 'This torrent failed; add it again to retry');
      return undefined;
    }
    const torrent = found.torrent as Torrent;
    if (!hasMetadata(torrent)) {
      sendError(res, 409, 'The file list is still being fetched from peers');
      return undefined;
    }
    const index = String(req.params.index);
    if (!FILE_INDEX.test(index)) {
      sendError(res, 400, 'index must be a whole number');
      return undefined;
    }
    if (!torrent.files[Number(index)]) {
      sendError(res, 404, 'No file with that index');
      return undefined;
    }
    return { torrent, index: Number(index) };
  };

  // The file's bytes, for a <video src>. Answers Range requests with 206, so
  // the browser can start and seek before the download is done. Express also
  // routes HEAD here.
  router.get('/:infoHash/files/:index/stream', (req, res) => {
    const found = fileFromParams(req, res);
    if (found) streamFile(req, res, found.torrent.files[found.index]);
  });

  // Starts downloading another video and its subtitles in the background
  // (Decision #18), e.g. the next episode once the player opens it. What was
  // selected before stays selected.
  router.post('/:infoHash/files/:index/select', (req, res) => {
    const found = fileFromParams(req, res);
    if (!found) return;
    const { torrent, index } = found;
    if (!isVideoFile(torrent.files[index].name)) {
      return sendError(res, 400, 'Only a video can be selected');
    }
    selection.selectVideo(torrent, index);
    res.status(204).end();
  });

  // A subtitle file as WebVTT for a <track> (Decision #20): .vtt as is,
  // .srt converted.
  router.get('/:infoHash/files/:index/subtitles.vtt', (req, res) => {
    const found = fileFromParams(req, res);
    if (!found) return;
    const file = found.torrent.files[found.index];
    if (mediaKind(file.name) !== 'subtitle') {
      return sendError(res, 400, 'Only a .srt or .vtt file has subtitles');
    }
    serveSubtitle(res, file);
  });

  // Pause stops all transfer for the torrent; resume picks it up again.
  // Both are idempotent.
  for (const [action, apply] of [
    ['pause', pauseTorrent],
    ['resume', resumeTorrent],
  ] as const) {
    router.post(`/:infoHash/${action}`, (req, res) => {
      const found = torrentFromParams(req, res);
      if (!found) return;
      if (found.failed) {
        return sendError(
          res,
          409,
          'This torrent failed; add it again to retry',
        );
      }
      apply(found.torrent as Torrent);
      save(found.torrent as Torrent);
      res.status(204).end();
    });
  }

  router.delete('/:infoHash', async (req, res) => {
    const found = torrentFromParams(req, res);
    if (!found) return;
    if (found.torrent) {
      await removeTorrent(client, found.torrent.infoHash);
      await saved?.delete(found.torrent.infoHash);
    } else if (found.failed) watch.forget(found.failed.infoHash);
    res.status(204).end();
  });

  // Body parser errors carry a status: 413 for an oversized .torrent file,
  // 400 for malformed JSON. Anything else is ours.
  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.too.large') {
      return sendError(
        res,
        413,
        `The .torrent file is larger than ${MAX_TORRENT_FILE_BYTES} bytes`,
      );
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
