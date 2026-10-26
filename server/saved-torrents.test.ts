import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import parseTorrent, {
  type Instance as ParsedTorrent,
  toTorrentFile,
} from 'parse-torrent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_TORRENTS_DIR, SavedTorrents } from './saved-torrents.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}&dn=Sintel`;

const choices = (hash = HASH, addedAt = 1000) => ({
  addedAt,
  magnetURI: magnet(hash),
  paused: false,
  selected: null,
});

function torrentFile(name = 'bunny.mp4'): Buffer {
  const info = {
    name,
    length: 1000,
    'piece length': 16384,
    pieces: new Uint8Array(20),
  };
  return Buffer.from(toTorrentFile({ info } as unknown as ParsedTorrent));
}

describe('SavedTorrents', () => {
  let downloadDir: string;
  let saved: SavedTorrents;
  const savedDir = () => join(downloadDir, SAVED_TORRENTS_DIR);

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'stream-saved-'));
    saved = new SavedTorrents(downloadDir);
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads nothing before anything is saved', async () => {
    expect(await saved.load()).toEqual([]);
  });

  it('loads what was saved, oldest first', async () => {
    await saved.save(OTHER, { ...choices(OTHER, 2000), paused: true });
    await saved.save(HASH, { ...choices(HASH, 1000), selected: [0, 2] });

    const loaded = await new SavedTorrents(downloadDir).load();

    expect(loaded).toMatchObject([
      { infoHash: HASH, addedAt: 1000, paused: false, selected: [0, 2] },
      { infoHash: OTHER, addedAt: 2000, paused: true, selected: null },
    ]);
    expect(loaded[0].parsed.infoHash).toBe(HASH);
    expect(loaded[0].parsed.name).toBe('Sintel');
  });

  it('keeps the latest of several quick saves', async () => {
    void saved.save(HASH, { ...choices(), paused: true });
    void saved.save(HASH, { ...choices(), paused: false });
    await saved.flush();

    expect((await saved.load())[0].paused).toBe(false);
    expect(readdirSync(savedDir())).toEqual([`${HASH}.json`]);
  });

  it('prefers the saved .torrent to the magnet link', async () => {
    const file = torrentFile();
    const { infoHash } = await parseTorrent(file);
    await saved.save(infoHash, choices(infoHash));
    await saved.saveTorrentFile(infoHash, file);

    const [loaded] = await saved.load();

    expect(loaded.parsed.name).toBe('bunny.mp4');
    expect(loaded.parsed.info).toBeDefined();
  });

  it("keeps the magnet link's peer addresses with a .torrent", async () => {
    const file = torrentFile();
    const { infoHash } = await parseTorrent(file);
    await saved.save(infoHash, {
      ...choices(infoHash),
      magnetURI: `${magnet(infoHash)}&x.pe=192.0.2.9:7001`,
    });
    await saved.saveTorrentFile(infoHash, file);

    const [loaded] = await saved.load();

    expect(loaded.parsed.info).toBeDefined();
    expect(loaded.parsed.peerAddresses).toEqual(['192.0.2.9:7001']);
  });

  it('falls back to the magnet link when the .torrent is unreadable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saved.save(HASH, choices());
    writeFileSync(join(savedDir(), `${HASH}.torrent`), 'garbage');

    const [loaded] = await saved.load();

    expect(loaded.parsed.name).toBe('Sintel');
  });

  it('deletes both files', async () => {
    await saved.save(HASH, choices());
    await saved.saveTorrentFile(HASH, torrentFile());

    await saved.delete(HASH);

    expect(readdirSync(savedDir())).toEqual([]);
    expect(await saved.load()).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    ['the wrong shape', JSON.stringify({ magnetURI: magnet(HASH) })],
    [
      'a magnet for another torrent',
      JSON.stringify({ ...choices(), magnetURI: magnet(OTHER) }),
    ],
    [
      'a link that is not a magnet',
      JSON.stringify({ ...choices(), magnetURI: '/etc/passwd' }),
    ],
    ['a negative file index', JSON.stringify({ ...choices(), selected: [-1] })],
  ])('skips an entry with %s and keeps it on disk', async (_, contents) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(savedDir());
    writeFileSync(join(savedDir(), `${HASH}.json`), contents);
    await saved.save(OTHER, choices(OTHER));

    const loaded = await saved.load();

    expect(loaded.map((entry) => entry.infoHash)).toEqual([OTHER]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(HASH),
      expect.anything(),
    );
    expect(readdirSync(savedDir())).toContain(`${HASH}.json`);
  });

  it('ignores files that are not saved torrents', async () => {
    mkdirSync(savedDir());
    writeFileSync(join(savedDir(), 'notes.json'), '{}');
    writeFileSync(join(savedDir(), `${HASH}.json.tmp`), '{');

    expect(await saved.load()).toEqual([]);
  });

  it('refuses a name that is not an info hash', () => {
    expect(() => saved.save('../escape', choices())).toThrow(
      'not an info hash',
    );
  });

  it('logs a failed write instead of rejecting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(savedDir(), 'a file where the directory should be');

    await expect(saved.save(HASH, choices())).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      `saving torrent ${HASH} failed:`,
      expect.anything(),
    );
  });
});
