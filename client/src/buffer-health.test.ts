import { describe, expect, it } from 'vitest';
import {
  type BufferState,
  bufferedAhead,
  HEALTHY_AHEAD_S,
  isDownloadSlow,
  LOW_AHEAD_S,
  playbackRate,
  slowDownloadMessage,
} from './buffer-health.js';

// TimeRanges from [start, end] pairs.
function ranges(...pairs: [number, number][]) {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  };
}

describe('bufferedAhead', () => {
  it('counts from the playhead to the end of its range', () => {
    expect(bufferedAhead(ranges([0, 30]), 12)).toBe(18);
    expect(bufferedAhead(ranges([0, 10], [40, 70]), 45)).toBe(25);
  });

  it('is 0 in a gap or with nothing buffered', () => {
    expect(bufferedAhead(ranges([0, 10], [40, 70]), 20)).toBe(0);
    expect(bufferedAhead(ranges(), 0)).toBe(0);
  });

  it('allows a range that starts just after the playhead, as after a seek', () => {
    expect(bufferedAhead(ranges([60.2, 80]), 60)).toBe(20);
    expect(bufferedAhead(ranges([61, 80]), 60)).toBe(0);
  });
});

// A 100 MB, 1000 s video: 100 kB/s on average.
function state(overrides: Partial<BufferState> = {}): BufferState {
  return {
    ahead: 5,
    currentTime: 100,
    duration: 1000,
    fileLength: 100_000_000,
    downloadSpeed: 50_000,
    downloaded: false,
    ...overrides,
  };
}

describe('playbackRate', () => {
  it('is the average bitrate in bytes per second', () => {
    expect(playbackRate(state())).toBe(100_000);
  });

  it('is unknown without a finite duration', () => {
    expect(playbackRate(state({ duration: Number.NaN }))).toBeNull();
    expect(playbackRate(state({ duration: Infinity }))).toBeNull();
    expect(playbackRate(state({ duration: 0 }))).toBeNull();
  });
});

describe('isDownloadSlow', () => {
  it('is slow with little buffered and a download below the bitrate', () => {
    expect(isDownloadSlow(state(), false)).toBe(true);
    expect(isDownloadSlow(state({ downloadSpeed: 0 }), false)).toBe(true);
  });

  it('is fine with enough buffered, a fast download or the file on disk', () => {
    expect(isDownloadSlow(state({ ahead: LOW_AHEAD_S }), false)).toBe(false);
    expect(isDownloadSlow(state({ downloadSpeed: 100_000 }), false)).toBe(
      false,
    );
    expect(isDownloadSlow(state({ downloaded: true }), false)).toBe(false);
  });

  it('is fine once the buffer reaches the end of the video', () => {
    expect(isDownloadSlow(state({ currentTime: 995, ahead: 5 }), false)).toBe(
      false,
    );
  });

  it('cannot tell before the duration is known', () => {
    expect(isDownloadSlow(state({ duration: Number.NaN }), false)).toBe(false);
  });

  it('stays slow until the buffer is healthy again', () => {
    const middle = state({ ahead: (LOW_AHEAD_S + HEALTHY_AHEAD_S) / 2 });
    expect(isDownloadSlow(middle, false)).toBe(false);
    expect(isDownloadSlow(middle, true)).toBe(true);
    expect(isDownloadSlow(state({ ahead: HEALTHY_AHEAD_S }), true)).toBe(false);
    expect(
      isDownloadSlow(state({ ahead: 20, downloadSpeed: 200_000 }), true),
    ).toBe(false);
  });
});

describe('slowDownloadMessage', () => {
  it('compares the speed with what the video needs', () => {
    expect(slowDownloadMessage(state())).toBe(
      'Downloading at 50 kB/s of the 100 kB/s it needs, so the video may stop to buffer.',
    );
  });

  it('leaves out the bitrate when it is unknown', () => {
    expect(slowDownloadMessage(state({ duration: Number.NaN }))).toBe(
      'Downloading at 50 kB/s, so the video may stop to buffer.',
    );
  });

  it('says when nothing is arriving', () => {
    expect(slowDownloadMessage(state({ downloadSpeed: 0 }))).toBe(
      'Nothing is downloading: no peer is sending data right now.',
    );
  });
});
