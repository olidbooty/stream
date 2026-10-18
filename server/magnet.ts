// A BitTorrent v1 info hash: 40 hex characters, or 32 base32 characters.
const BTIH = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i;

// Generous for a link with many trackers, but stops a request body from
// carrying megabytes of query string into the parser.
export const MAX_MAGNET_LENGTH = 8192;

// Accepts magnet links that name a BitTorrent info hash. Other magnets (eDonkey,
// v2-only `btmh` links) and other strings, such as URLs or file paths that
// WebTorrent would fetch or read, are rejected.
export function isMagnetURI(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_MAGNET_LENGTH)
    return false;
  if (!value.toLowerCase().startsWith('magnet:?')) return false;
  const params = new URLSearchParams(value.slice('magnet:?'.length));
  return params.getAll('xt').some((xt) => BTIH.test(xt));
}
