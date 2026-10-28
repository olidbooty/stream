import { isIP } from 'node:net';
import { type Request, Router } from 'express';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { selectMedia } from './media.js';
import { lanAddresses as systemLanAddresses } from './network.js';
import { mediaInputs } from './torrent-selection.js';

// Step 3.11: one short address a TV player such as VLC saves once, listing
// every video by name with an absolute stream URL. Each URL has ?play, so
// opening it downloads and resumes like the page's Play. VLC can't take
// subtitles from a playlist (Decision #32), so the list has none.

export const TV_PLAYLIST_PATH = '/tv.m3u';

export interface PlaylistEntry {
  title: string;
  url: string;
}

export interface TvRouterOptions {
  client: WebTorrent;
  // Passed in so tests don't depend on the machine's interfaces.
  lanAddresses?: () => string[];
}

// What GET /api/tv answers: the playlist's address on each LAN address, the
// one to save in VLC first.
export interface TvInfo {
  playlistUrls: string[];
}

// An M3U playlist as VLC reads it: #EXTINF names each entry. A title is one
// line, so line breaks in a file name become spaces.
export function m3u(entries: readonly PlaylistEntry[]): string {
  const lines = ['#EXTM3U'];
  for (const { title, url } of entries) {
    lines.push(`#EXTINF:-1,${title.replace(/[\r\n]+/g, ' ')}`, url);
  }
  return `${lines.join('\n')}\n`;
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// Every video of every torrent whose file list is known, in the order the
// torrents were added and then the page lists their videos. Samples are left
// out. A torrent with one video is named after the torrent; with several,
// each is named after its file, e.g. one per episode.
export function playlistEntries(
  torrents: readonly Torrent[],
  origin: string,
): PlaylistEntry[] {
  return torrents.flatMap((torrent) => {
    if (torrent.metadata == null) return [];
    const { files, videos } = selectMedia(mediaInputs(torrent));
    const listed = videos.filter((index) => !files[index].sample);
    return listed.map((index) => ({
      title:
        listed.length === 1
          ? torrent.name
          : withoutExtension(files[index].name),
      url: `${origin}/api/torrents/${torrent.infoHash}/files/${index}/stream?play`,
    }));
  });
}

// Host headers this server could answer to: a name or IPv4 address, or an
// IPv6 address in brackets, with an optional port.
const HOST = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:[0-9]{1,5})?$/i;

function isLoopback(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    (isIP(name) === 4 && name.startsWith('127.'))
  );
}

// The origins another device can use to reach this server. The Host the
// request came in on works when it isn't this machine's own name (VLC
// fetching the playlist from 192.168.1.20 gets 192.168.1.20 back). Opened as
// localhost, it is the LAN addresses on the port the request reached.
export function lanOrigins(req: Request, lanAddresses: string[]): string[] {
  const host = req.get('host') ?? '';
  const match = HOST.exec(host);
  if (match && !isLoopback(match[1])) return [`${req.protocol}://${host}`];
  const port = req.socket.localPort;
  const origins = lanAddresses.map(
    (address) => `${req.protocol}://${address}:${port}`,
  );
  // No network: localhost still works on this machine.
  return origins.length > 0 || !match ? origins : [`${req.protocol}://${host}`];
}

export function tvRouter({
  client,
  lanAddresses = systemLanAddresses,
}: TvRouterOptions): Router {
  const router = Router();

  router.get(TV_PLAYLIST_PATH, (req, res) => {
    const [origin] = lanOrigins(req, lanAddresses());
    if (!origin) {
      res.status(400).type('text/plain').send('Unrecognised Host header');
      return;
    }
    res
      .type('audio/x-mpegurl; charset=utf-8')
      // A saved playlist is fetched again each time, so it lists new torrents.
      .set('Cache-Control', 'no-store')
      .send(m3u(playlistEntries(client.torrents, origin)));
  });

  router.get('/api/tv', (req, res) => {
    res.json({
      playlistUrls: lanOrigins(req, lanAddresses()).map(
        (origin) => `${origin}${TV_PLAYLIST_PATH}`,
      ),
    } satisfies TvInfo);
  });

  return router;
}
