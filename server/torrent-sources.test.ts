import parseTorrent from 'parse-torrent';
import { describe, expect, it } from 'vitest';
import { filterSources, isAllowedSource } from './torrent-sources.js';

const TRACKERS = new Set(['http:', 'https:', 'udp:', 'wss:']);
const WEB_SEEDS = new Set(['http:', 'https:']);

describe('isAllowedSource', () => {
  it.each([
    'udp://tracker.opentrackr.org:1337/announce',
    'http://tracker.example.com/announce',
    'https://tracker.example.com:443/announce',
    'wss://tracker.webtorrent.dev',
    'udp://93.184.215.14:6969/announce',
    'http://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/announce',
    // Public addresses next to private ranges.
    'http://172.32.0.1/',
    'http://11.0.0.1/',
    'http://192.169.0.1/',
  ])('allows %s', (url) => {
    expect(isAllowedSource(url, TRACKERS)).toBe(true);
  });

  it.each([
    ['localhost', 'http://localhost:8080/announce'],
    ['a localhost subdomain', 'http://router.localhost/'],
    ['localhost with a trailing dot', 'http://localhost./'],
    ['loopback', 'udp://127.0.0.1:6969/announce'],
    ['loopback anywhere in 127/8', 'http://127.8.9.10/'],
    ['10/8', 'http://10.0.0.1/announce'],
    ['172.16/12', 'http://172.31.255.255/'],
    ['192.168/16', 'https://192.168.1.1/'],
    ['link-local', 'http://169.254.169.254/latest/meta-data'],
    ['unspecified', 'udp://0.0.0.0:6969'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unspecified', 'wss://[::]/'],
    ['IPv6 unique local', 'http://[fd12:3456::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:192.168.0.1]/'],
    ['a hex IPv4 address', 'http://0x7f.1/'],
    ['a decimal IPv4 address', 'http://2130706433/'],
    ['a short IPv4 address over UDP', 'udp://127.1:6969'],
    ['a hex IPv4 address over UDP', 'udp://0x7f.0.0.1:6969'],
    ['a decimal IPv4 address over UDP', 'udp://3232235777:6969'],
    ['an empty host over UDP', 'udp://:6969'],
    ['another protocol', 'ftp://tracker.example.com/'],
    ['plain WebSocket', 'ws://tracker.example.com/'],
    ['a file URL', 'file:///etc/passwd'],
    ['not a URL', 'tracker.example.com'],
  ])('drops %s', (_kind, url) => {
    expect(isAllowedSource(url, TRACKERS)).toBe(false);
  });

  it('only allows HTTP(S) web seeds', () => {
    expect(isAllowedSource('https://cdn.example.com/f/', WEB_SEEDS)).toBe(true);
    expect(isAllowedSource('udp://cdn.example.com/', WEB_SEEDS)).toBe(false);
  });
});

describe('filterSources', () => {
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';

  it('strips xs= and local trackers and web seeds from a magnet link', async () => {
    const parsed = await parseTorrent(
      `magnet:?xt=urn:btih:${HASH}&dn=Sintel` +
        '&tr=udp%3A%2F%2Ftracker.example.com%3A1337' +
        '&tr=http%3A%2F%2F192.168.1.1%2Fannounce' +
        '&ws=https%3A%2F%2Fcdn.example.com%2F' +
        '&ws=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Ftorrents' +
        '&xs=http%3A%2F%2F10.0.0.5%2Fsintel.torrent',
    );

    const { torrent, dropped } = filterSources(parsed);

    expect(torrent).not.toHaveProperty('xs');
    expect(torrent.announce).toEqual(['udp://tracker.example.com:1337']);
    expect(torrent.urlList).toEqual(['https://cdn.example.com/']);
    expect(torrent.infoHash).toBe(HASH);
    expect(torrent.name).toBe('Sintel');
    expect(dropped).toEqual([
      'http://10.0.0.5/sintel.torrent',
      'http://192.168.1.1/announce',
      'http://127.0.0.1:3000/api/torrents',
    ]);
    // The input is left alone.
    expect(parsed.announce).toHaveLength(2);
  });

  it('leaves a torrent with only public sources unchanged', async () => {
    const parsed = await parseTorrent(
      `magnet:?xt=urn:btih:${HASH}&tr=wss%3A%2F%2Ftracker.webtorrent.dev`,
    );

    const { torrent, dropped } = filterSources(parsed);

    expect(torrent).toEqual(parsed);
    expect(dropped).toEqual([]);
  });
});
