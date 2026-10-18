import { describe, expect, it } from 'vitest';
import { isMagnetURI, MAX_MAGNET_LENGTH } from './magnet.js';

const HEX = '0123456789abcdef0123456789abcdef01234567';
const BASE32 = 'aerukz4jvpgw66ckaerukz4jvpgw66ck';

describe('isMagnetURI', () => {
  it.each([
    `magnet:?xt=urn:btih:${HEX}`,
    `magnet:?xt=urn:btih:${HEX.toUpperCase()}`,
    `magnet:?xt=urn:btih:${BASE32}`,
    `MAGNET:?dn=Sintel&tr=wss%3A%2F%2Ftracker.webtorrent.dev&xt=urn:btih:${HEX}`,
    // Hybrid v1/v2 links carry both; the btih is enough.
    `magnet:?xt=urn:btmh:1220${'a'.repeat(64)}&xt=urn:btih:${HEX}`,
  ])('accepts %s', (magnet) => {
    expect(isMagnetURI(magnet)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a bare info hash', HEX],
    ['a URL', 'https://webtorrent.io/torrents/sintel.torrent'],
    ['a file path', '/etc/passwd'],
    ['a magnet without xt', 'magnet:?dn=Sintel'],
    ['a short hash', `magnet:?xt=urn:btih:${HEX.slice(1)}`],
    ['a non-hex hash', `magnet:?xt=urn:btih:${'z'.repeat(40)}`],
    ['a v2-only magnet', `magnet:?xt=urn:btmh:1220${'a'.repeat(64)}`],
    ['an eDonkey magnet', 'magnet:?xt=urn:ed2k:31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a stream-magnet link', `stream-magnet:?xt=urn:btih:${HEX}`],
  ])('rejects %s', (_label, value) => {
    expect(isMagnetURI(value)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isMagnetURI(undefined)).toBe(false);
    expect(isMagnetURI({ magnet: `magnet:?xt=urn:btih:${HEX}` })).toBe(false);
  });

  it('rejects links longer than MAX_MAGNET_LENGTH', () => {
    const magnet = `magnet:?xt=urn:btih:${HEX}&dn=`;

    expect(isMagnetURI(magnet + 'a'.repeat(MAX_MAGNET_LENGTH - magnet.length))).toBe(true);
    expect(isMagnetURI(magnet + 'a'.repeat(MAX_MAGNET_LENGTH - magnet.length + 1))).toBe(false);
  });
});
