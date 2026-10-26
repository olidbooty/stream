import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { createPlayer, PEER_WAIT_MS, SLOW_WARN_MS } from './player.js';
import { SAMPLE_HASH, sampleDetail, sampleSummary } from './sample-data.js';

// jsdom can't play media: load(), pause() and play() only log "not
// implemented".
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

// The player's clock, for the slow-download warning's delay.
let clock = 0;

function setup() {
  clock = 0;
  const api = {
    getTorrent: vi.fn().mockResolvedValue(sampleDetail()),
    selectFile: vi.fn().mockResolvedValue(undefined),
    resumeTorrent: vi.fn().mockResolvedValue(undefined),
  };
  const player = createPlayer({ api, now: () => clock });
  document.body.append(player.element);
  return { api, player };
}

const video = () => document.querySelector('video') as HTMLVideoElement;
const status = () =>
  document.querySelector('.video-player__status') as HTMLElement;
const fire = (type: string) => video().dispatchEvent(new Event(type));

describe('createPlayer', () => {
  it('plays the file from its stream URL with its subtitles', async () => {
    const { api, player } = setup();

    await player.open({ infoHash: SAMPLE_HASH, index: 1 });

    expect(api.getTorrent).toHaveBeenCalledWith(SAMPLE_HASH);
    expect(video().getAttribute('src')).toBe(
      `/api/torrents/${SAMPLE_HASH}/files/1/stream`,
    );
    const tracks = [...video().querySelectorAll('track')];
    expect(
      tracks.map((track) => [
        track.getAttribute('src'),
        track.getAttribute('srclang'),
        track.getAttribute('label'),
      ]),
    ).toEqual([
      [`/api/torrents/${SAMPLE_HASH}/files/0/subtitles.vtt`, 'de', 'German'],
    ]);
    expect(document.querySelector('h2')?.textContent).toBe('Sintel.mp4');
    expect(document.querySelector('.video-player__stats')?.textContent).toBe(
      '42% downloaded · 7 peers · ↓ 1.3 MB/s',
    );
    // Already downloading, so nothing to select.
    expect(api.selectFile).not.toHaveBeenCalled();
  });

  it('starts downloading a video that is not selected', async () => {
    const { api, player } = setup();

    await player.open({ infoHash: SAMPLE_HASH, index: 2 });

    expect(api.selectFile).toHaveBeenCalledWith(SAMPLE_HASH, 2);
    expect(video().getAttribute('src')).toContain('/files/2/stream');
  });

  it('resumes a paused torrent, and only a paused one', async () => {
    const { api, player } = setup();
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });
    expect(api.resumeTorrent).not.toHaveBeenCalled();

    api.getTorrent.mockResolvedValueOnce(sampleDetail({ state: 'paused' }));
    api.resumeTorrent.mockRejectedValueOnce(new ApiError(500, 'nope'));
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });

    expect(api.resumeTorrent).toHaveBeenCalledWith(SAMPLE_HASH);
    expect(video()).not.toBeNull();
  });

  it('still plays when selecting fails', async () => {
    const { api, player } = setup();
    api.selectFile.mockRejectedValue(new ApiError(500, 'nope'));

    await player.open({ infoHash: SAMPLE_HASH, index: 2 });

    expect(video()).not.toBeNull();
  });

  it.each([
    [0, 'That file is not a video in this torrent.'],
    [9, 'That file is not a video in this torrent.'],
  ])('refuses file %d', async (index, message) => {
    const { player } = setup();
    await player.open({ infoHash: SAMPLE_HASH, index });
    expect(video()).toBeNull();
    expect(player.element.textContent).toContain(message);
    expect(player.element.querySelector('a')?.getAttribute('href')).toBe('#');
  });

  it('explains a failed torrent, missing metadata or a failed fetch', async () => {
    const { api, player } = setup();
    api.getTorrent.mockResolvedValueOnce(
      sampleDetail({ state: 'error', files: null }),
    );
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });
    expect(player.element.textContent).toContain('This torrent failed');

    api.getTorrent.mockResolvedValueOnce(
      sampleDetail({ hasMetadata: false, files: null }),
    );
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });
    expect(player.element.textContent).toContain('still coming from peers');

    api.getTorrent.mockRejectedValueOnce(
      new ApiError(404, 'No torrent with that info hash'),
    );
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });
    expect(player.element.textContent).toContain(
      "Couldn't open it: No torrent with that info hash",
    );
  });

  it('ignores a slow answer for a route that was already left', async () => {
    const { api, player } = setup();
    let answer: (detail: unknown) => void = () => {};
    api.getTorrent.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const opening = player.open({ infoHash: SAMPLE_HASH, index: 1 });
    player.close();
    answer(sampleDetail());
    await opening;

    expect(video()).toBeNull();
    expect(player.element.childElementCount).toBe(0);
  });

  describe('status line', () => {
    it('shows loading and buffering, and clears once it can play', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });

      fire('loadstart');
      expect(status().textContent).toBe('Loading…');
      expect(status().hidden).toBe(false);

      fire('canplay');
      expect(status().hidden).toBe(true);

      fire('waiting');
      expect(status().textContent).toBe('Buffering…');
      fire('playing');
      expect(status().hidden).toBe(true);
    });

    it('blames the peers after a long wait', async () => {
      vi.useFakeTimers();
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });

      fire('waiting');
      vi.advanceTimersByTime(PEER_WAIT_MS - 1);
      expect(status().textContent).toBe('Buffering…');
      vi.advanceTimersByTime(1);
      expect(status().textContent).toBe('Waiting for data from peers…');
    });

    it('blames the peers at once when the download stalls while waiting', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });

      fire('stalled');
      expect(status().hidden).toBe(true);
      fire('waiting');
      fire('stalled');
      expect(status().textContent).toBe('Waiting for data from peers…');
    });

    it('does not blame the peers once playback resumed', async () => {
      vi.useFakeTimers();
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });

      fire('waiting');
      fire('playing');
      vi.advanceTimersByTime(PEER_WAIT_MS);
      expect(status().hidden).toBe(true);
    });

    it('reports an unsupported file with its name and container', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      Object.defineProperty(video(), 'error', { value: { code: 4 } });

      fire('error');

      expect(status().textContent).toBe(
        "This browser can't play Sintel.mp4. It doesn't support the MP4 format or the codecs inside it.",
      );
      expect(status().dataset.tone).toBe('error');
      expect(status().classList).toContain('status-banner');
      expect(status().querySelector('button')).toBeNull();
    });

    it('keeps an error up when buffering events follow', async () => {
      vi.useFakeTimers();
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      fire('waiting');
      Object.defineProperty(video(), 'error', { value: { code: 3 } });

      fire('error');
      vi.advanceTimersByTime(PEER_WAIT_MS);

      expect(status().textContent).toContain("couldn't decode it");
      // Chrome fires `playing` when Play is pressed on a failed stream.
      fire('playing');
      expect(status().textContent).toContain("couldn't decode it");
    });

    it('retries a cut-off stream from where it stopped', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      const load = vi.mocked(HTMLMediaElement.prototype.load);
      load.mockClear();
      video().currentTime = 42;
      Object.defineProperty(video(), 'error', { value: { code: 2 } });

      fire('error');
      const retry = status().querySelector('button');
      expect(retry?.textContent).toBe('Retry');
      retry?.click();

      expect(load).toHaveBeenCalledTimes(1);
      expect(video().getAttribute('src')).toBe(
        `/api/torrents/${SAMPLE_HASH}/files/1/stream`,
      );
      // A real load() resets the position and fires these.
      video().currentTime = 0;
      fire('loadstart');
      expect(status().textContent).toBe('Loading…');
      Object.defineProperty(video(), 'videoWidth', { value: 640 });
      fire('loadedmetadata');
      expect(video().currentTime).toBe(42);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      fire('canplay');
      expect(status().hidden).toBe(true);
    });

    it('does not jump or play on its own without a retry', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      Object.defineProperty(video(), 'videoWidth', { value: 640 });

      fire('loadedmetadata');

      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(status().hidden).toBe(true);
    });

    it('warns when only the sound plays, and keeps the warning', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      // jsdom's videoWidth is always 0, as for a picture the browser can't
      // decode.
      fire('loadedmetadata');

      expect(status().textContent).toContain(
        'Only the sound of Sintel.mp4 will play.',
      );
      expect(status().dataset.tone).toBe('warning');

      fire('waiting');
      expect(status().textContent).toBe('Buffering…');
      expect(status().classList).not.toContain('status-banner');
      fire('playing');
      expect(status().dataset.tone).toBe('warning');
      expect(status().textContent).toContain('Only the sound');
    });

    it('ignores the abort that closing causes', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      Object.defineProperty(video(), 'error', { value: { code: 1 } });

      fire('error');

      expect(status().hidden).toBe(true);
    });
  });

  describe('buffer health', () => {
    const health = () =>
      document.querySelector('.video-player__health') as HTMLElement;
    const stats = () =>
      document.querySelector('.video-player__stats')?.textContent;

    // jsdom's video has no metadata and nothing buffered; these stand in for
    // a loaded one. Sintel.mp4 is 129 MB, so 1000 s plays at 129 kB/s.
    function load(ahead: number, currentTime = 100, duration = 1000) {
      const v = video();
      Object.defineProperty(v, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
      Object.defineProperty(v, 'duration', {
        configurable: true,
        value: duration,
      });
      Object.defineProperty(v, 'currentTime', {
        configurable: true,
        value: currentTime,
      });
      Object.defineProperty(v, 'buffered', {
        configurable: true,
        value: {
          length: 1,
          start: () => 0,
          end: () => currentTime + ahead,
        },
      });
    }

    it('shows the seconds buffered ahead once the video has loaded', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      expect(stats()).toBe('42% downloaded · 7 peers · ↓ 1.3 MB/s');

      load(25);
      fire('progress');
      expect(stats()).toBe(
        '42% downloaded · 7 peers · ↓ 1.3 MB/s · 25 s buffered',
      );
      expect(health().hidden).toBe(true);
    });

    it('warns while the download is slower than the video, until it recovers', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      load(5);
      fire('playing');
      // 1.3 MB/s is plenty for 129 kB/s.
      expect(health().hidden).toBe(true);

      player.update([sampleSummary({ downloadSpeed: 50_000 })]);
      // Only once it has stayed slow for a while.
      expect(health().hidden).toBe(true);
      clock += SLOW_WARN_MS - 1;
      fire('timeupdate');
      expect(health().hidden).toBe(true);
      clock += 1;
      fire('timeupdate');
      expect(health().hidden).toBe(false);
      expect(health().getAttribute('role')).toBe('status');
      expect(health().dataset.tone).toBe('warning');
      expect(health().textContent).toBe(
        'Downloading at 50 kB/s of the 129 kB/s it needs, so the video may stop to buffer.',
      );

      // Not gone at 20 s, only once it is healthy again.
      load(20);
      fire('timeupdate');
      expect(health().hidden).toBe(false);
      load(30);
      fire('progress');
      expect(health().hidden).toBe(true);
    });

    it('does not warn for a slow spell shorter than SLOW_WARN_MS', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      load(2);
      fire('playing');

      player.update([sampleSummary({ downloadSpeed: 50_000 })]);
      clock += SLOW_WARN_MS - 1;
      player.update([sampleSummary()]);
      clock += 1;
      player.update([sampleSummary({ downloadSpeed: 50_000 })]);

      expect(health().hidden).toBe(true);
    });

    it('does not warn before the video has played', async () => {
      const { api, player } = setup();
      api.getTorrent.mockResolvedValueOnce(sampleDetail({ downloadSpeed: 0 }));
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      load(0);

      fire('progress');
      expect(health().hidden).toBe(true);
      fire('playing');
      clock += SLOW_WARN_MS;
      fire('timeupdate');
      expect(health().textContent).toContain('no peer is sending data');
    });

    it('does not warn once every selected file is downloaded', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      load(2);
      fire('playing');

      player.update([sampleSummary({ downloadSpeed: 0, state: 'seeding' })]);

      expect(health().hidden).toBe(true);
    });

    it('drops the warning when an error takes over, and after a reload', async () => {
      const { player } = setup();
      await player.open({ infoHash: SAMPLE_HASH, index: 1 });
      player.update([sampleSummary({ downloadSpeed: 0 })]);
      load(2);
      fire('playing');
      clock += SLOW_WARN_MS;
      fire('timeupdate');
      expect(health().hidden).toBe(false);

      Object.defineProperty(video(), 'error', { value: { code: 2 } });
      fire('error');
      expect(health().hidden).toBe(true);
      // Chrome fires `playing` on a failed stream.
      fire('playing');
      expect(health().hidden).toBe(true);

      fire('loadstart');
      fire('progress');
      expect(health().hidden).toBe(true);
    });
  });

  it('updates the stats from the live list', async () => {
    const { player } = setup();
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });

    player.update([
      sampleSummary({ infoHash: 'f'.repeat(40), numPeers: 99 }),
      sampleSummary({ numPeers: 2, progress: 0.5 }),
    ]);

    expect(document.querySelector('.video-player__stats')?.textContent).toBe(
      '50% downloaded · 2 peers · ↓ 1.3 MB/s',
    );
  });

  it('releases the stream when closed', async () => {
    const { player } = setup();
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });
    const element = video();

    player.close();

    expect(element.hasAttribute('src')).toBe(false);
    expect(element.querySelectorAll('track')).toHaveLength(0);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(player.element.childElementCount).toBe(0);
  });

  it('releases the previous stream when another video opens', async () => {
    const { player } = setup();
    await player.open({ infoHash: SAMPLE_HASH, index: 1 });
    const first = video();

    await player.open({ infoHash: SAMPLE_HASH, index: 2 });

    expect(first.hasAttribute('src')).toBe(false);
    expect(document.querySelectorAll('video')).toHaveLength(1);
  });
});
