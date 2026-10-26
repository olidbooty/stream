import type {
  TorrentDetail,
  TorrentSummary,
} from '../../server/torrents-api.js';

// A non-2xx answer. `message` is the server's own {"error": "..."} text, which
// is written for people, so the UI shows it as is.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Api {
  listTorrents(): Promise<TorrentSummary[]>;
  getTorrent(infoHash: string): Promise<TorrentDetail>;
  addMagnet(magnet: string): Promise<TorrentSummary>;
  // Sent as the raw body; the server takes no multipart (Decision #14).
  addTorrentFile(file: Blob): Promise<TorrentSummary>;
  removeTorrent(infoHash: string): Promise<void>;
  // Starts downloading another video and its subtitles (Decision #18).
  selectFile(infoHash: string, index: number): Promise<void>;
  // Stops and restarts a torrent's transfers, keeping its data.
  pauseTorrent(infoHash: string): Promise<void>;
  resumeTorrent(infoHash: string): Promise<void>;
}

// URLs the <video> and <track> elements load themselves.
export function streamUrl(infoHash: string, index: number): string {
  return `/api/torrents/${infoHash}/files/${index}/stream`;
}

export function subtitlesUrl(infoHash: string, index: number): string {
  return `/api/torrents/${infoHash}/files/${index}/subtitles.vtt`;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `The server answered ${res.status} ${res.statusText}`.trim();
  try {
    const body: unknown = await res.json();
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
    ) {
      message = (body as { error: string }).error;
    }
  } catch {
    // Not JSON, e.g. a proxy's error page; keep the status line.
  }
  return new ApiError(res.status, message);
}

// `fetchFn` is passed in so tests can stub the server.
export function createApi(
  fetchFn: Fetch = (input, init) => fetch(input, init),
  base = '/api/torrents',
): Api {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetchFn(`${base}${path}`, init);
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  return {
    async listTorrents() {
      return (await request('')).json();
    },
    async getTorrent(infoHash) {
      return (await request(`/${encodeURIComponent(infoHash)}`)).json();
    },
    async addMagnet(magnet) {
      const res = await request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet }),
      });
      return res.json();
    },
    async addTorrentFile(file) {
      const res = await request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-bittorrent' },
        body: file,
      });
      return res.json();
    },
    async removeTorrent(infoHash) {
      await request(`/${encodeURIComponent(infoHash)}`, { method: 'DELETE' });
    },
    async selectFile(infoHash, index) {
      await request(`/${encodeURIComponent(infoHash)}/files/${index}/select`, {
        method: 'POST',
      });
    },
    async pauseTorrent(infoHash) {
      await request(`/${encodeURIComponent(infoHash)}/pause`, {
        method: 'POST',
      });
    },
    async resumeTorrent(infoHash) {
      await request(`/${encodeURIComponent(infoHash)}/resume`, {
        method: 'POST',
      });
    },
  };
}
