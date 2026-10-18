import { beforeEach, describe, expect, it } from 'vitest';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { type FakeTorrent, FakeWebTorrent } from '../test/mocks/webtorrent.js';
import {
  MAX_FAILED_TORRENTS,
  type TorrentState,
  type TorrentStateInput,
  TorrentWatch,
  torrentState,
} from './torrent-state.js';
import type { TorrentSummary } from './torrents-api.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

describe('torrentState', () => {
  const base: TorrentStateInput = {
    failed: false,
    done: false,
    hasMetadata: false,
    numPeers: 0,
    noPeersReported: false,
  };

  it.each<[string, TorrentState, Partial<TorrentStateInput>]>([
    ['a new magnet link', 'connecting', {}],
    ['a magnet link with peers but no metadata yet', 'connecting', { numPeers: 2 }],
    ['a torrent with metadata still looking for peers', 'connecting', { hasMetadata: true }],
    ['a torrent with metadata and peers', 'downloading', { hasMetadata: true, numPeers: 2 }],
    ['a magnet link nobody has answered', 'noPeers', { noPeersReported: true }],
    ['a download whose peers all left', 'noPeers', { hasMetadata: true, noPeersReported: true }],
    // The flag is only cleared when a peer connects; peers win regardless.
    [
      'peers connected despite an old noPeers',
      'downloading',
      { hasMetadata: true, numPeers: 1, noPeersReported: true },
    ],
    ['a finished torrent', 'seeding', { hasMetadata: true, done: true, numPeers: 3 }],
    [
      'a finished torrent with no peers',
      'seeding',
      { hasMetadata: true, done: true, noPeersReported: true },
    ],
    ['a failed torrent', 'error', { failed: true, hasMetadata: true, done: true }],
  ])('reports %s as %s', (_label, expected, input) => {
    expect(torrentState({ ...base, ...input })).toBe(expected);
  });
});

describe('TorrentWatch', () => {
  let client: FakeWebTorrent;
  let watch: TorrentWatch;

  beforeEach(() => {
    client = new FakeWebTorrent();
    watch = new TorrentWatch(client as unknown as WebTorrent);
  });

  function add(infoHash = HASH): FakeTorrent {
    const torrent = client.add({ infoHash }, { destroyStoreOnDestroy: true });
    // addTorrent() always has an error listener that logs.
    torrent.on('error', () => {});
    const snapshot = (): TorrentSummary => ({
      infoHash,
      name: torrent.name ?? null,
      magnetURI: torrent.magnetURI,
      hasMetadata: torrent.metadata !== null,
      ready: torrent.ready,
      length: torrent.length,
      progress: torrent.progress,
      numPeers: torrent.numPeers,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      state: 'downloading',
      errorMessage: null,
    });
    watch.watch(torrent as unknown as Torrent, infoHash, snapshot);
    return torrent;
  }

  const noPeers = (torrent: FakeTorrent) => watch.noPeersReported(torrent as unknown as Torrent);

  it('reports noPeers until a peer connects', () => {
    const torrent = add();

    expect(noPeers(torrent)).toBe(false);
    torrent.simulateNoPeers('dht');
    expect(noPeers(torrent)).toBe(true);
    torrent.simulateWire();
    expect(noPeers(torrent)).toBe(false);
  });

  describe('failures', () => {
    it('keeps a failed torrent with its last progress and the error', () => {
      const torrent = add();
      torrent.simulateMetadata({ name: 'Sintel', files: [{ name: 'sintel.mp4', length: 1000 }] });
      torrent.simulateDownload(400, { downloadSpeed: 100, numPeers: 2 });

      torrent.simulateError(new Error('disk full'));

      expect(client.torrents).toEqual([]);
      expect(watch.failed()).toEqual([
        expect.objectContaining({
          infoHash: HASH,
          name: 'Sintel',
          progress: 0.4,
          length: 1000,
          state: 'error',
          errorMessage: 'disk full',
          ready: false,
          numPeers: 0,
          downloadSpeed: 0,
        }),
      ]);
      expect(watch.getFailed(HASH)?.errorMessage).toBe('disk full');
    });

    it('accepts a string error, as WebTorrent may emit one', () => {
      const torrent = add();

      torrent.simulateError('bad');

      expect(watch.getFailed(HASH)?.errorMessage).toBe('bad');
    });

    it('forgets a failure on delete', () => {
      add().simulateError();

      expect(watch.forget(HASH)).toBe(true);
      expect(watch.failed()).toEqual([]);
      expect(watch.forget(HASH)).toBe(false);
    });

    it('drops the failure when the same torrent is added again', () => {
      add().simulateError();

      add();

      expect(watch.failed()).toEqual([]);
    });

    it('ignores the duplicate WebTorrent destroys when a torrent is added twice', () => {
      add();
      const duplicate = add();

      duplicate.simulateError(new Error(`Cannot add duplicate torrent ${HASH}`));

      expect(client.torrents).toHaveLength(1);
      expect(watch.failed()).toEqual([]);
    });

    it(`keeps at most ${MAX_FAILED_TORRENTS}, dropping the oldest`, () => {
      const hashes = Array.from({ length: MAX_FAILED_TORRENTS + 1 }, (_, i) =>
        i.toString(16).padStart(40, '0'),
      );
      for (const hash of hashes) add(hash).simulateError();

      expect(watch.failed()).toHaveLength(MAX_FAILED_TORRENTS);
      expect(watch.getFailed(hashes[0])).toBeUndefined();
      expect(watch.getFailed(hashes.at(-1)!)).toBeDefined();
    });
  });
});
