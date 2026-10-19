import { BlockList, isIP } from 'node:net';
import type { Instance as ParsedTorrent } from 'parse-torrent';

// Decision #11: a torrent's trackers, web seeds and a magnet's xs= URL come
// from whoever adds it, and WebTorrent contacts them from the server. Anyone
// on the LAN could use that to make the server send requests to hosts on the
// LAN, so those are dropped before the torrent reaches the client.
//
// Only literal addresses and localhost are caught. A hostname that resolves
// to a LAN address, or a public URL that redirects to one, still passes;
// that is accepted, as is the unauthenticated API itself (Decision #12).

// Loopback, private, link-local and unspecified addresses. BlockList also
// matches IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) against the IPv4
// rules.
const LOCAL = new BlockList();
LOCAL.addSubnet('0.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL.addAddress('::', 'ipv6');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fc00::', 7, 'ipv6');
LOCAL.addSubnet('fe80::', 10, 'ipv6');

// wss:// trackers find WebRTC peers; plain ws:// ones are rare and unneeded.
const TRACKER_PROTOCOLS = new Set(['http:', 'https:', 'udp:', 'wss:']);
const WEB_SEED_PROTOCOLS = new Set(['http:', 'https:']);

// The host a URL would reach, normalised, or null if it can't be parsed.
// WHATWG URLs only normalise hosts for special schemes such as http, so
// udp://0x7f.1 keeps that spelling, which the system resolver would still
// read as 127.0.0.1. Parsing it as http gives the same normalisation.
function hostOf(url: URL): string | null {
  let parsed = url;
  if (url.protocol === 'udp:') {
    try {
      parsed = new URL(`http:${url.href.slice('udp:'.length)}`);
    } catch {
      return null;
    }
  }
  return parsed.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isLocalHost(host: string): boolean {
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  const family = isIP(host);
  if (family === 0) return false;
  return LOCAL.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

// Whether the server may contact this URL as a tracker or web seed.
export function isAllowedSource(
  url: string,
  protocols: ReadonlySet<string>,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!protocols.has(parsed.protocol)) return false;
  const host = hostOf(parsed);
  return host !== null && !isLocalHost(host);
}

export interface FilteredTorrent {
  torrent: ParsedTorrent;
  // What was removed, for the log.
  dropped: string[];
}

// Returns a copy of the parsed torrent without xs=, and with only the
// trackers and web seeds the server may contact.
export function filterSources(parsed: ParsedTorrent): FilteredTorrent {
  // parse-torrent keeps a magnet's xs= (exact source), which WebTorrent
  // fetches over HTTP for the metadata. Peers send it anyway.
  const { xs, ...torrent } = parsed as ParsedTorrent & { xs?: unknown };
  const dropped = xs === undefined ? [] : [xs].flat().map(String);

  const keep = (urls: string[] | undefined, protocols: ReadonlySet<string>) =>
    (urls ?? []).filter((url) => {
      const allowed = isAllowedSource(url, protocols);
      if (!allowed) dropped.push(url);
      return allowed;
    });

  return {
    torrent: {
      ...torrent,
      announce: keep(parsed.announce, TRACKER_PROTOCOLS),
      urlList: keep(parsed.urlList, WEB_SEED_PROTOCOLS),
    },
    dropped,
  };
}
