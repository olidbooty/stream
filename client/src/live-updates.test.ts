import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import type { TorrentSummary } from '../../server/torrents-api.js';
import {
  type EventSourceLike,
  LIVE_RETRY_MS,
  type LiveStatus,
  startLiveUpdates,
} from './live-updates.js';
import { sampleSummary } from './sample-data.js';

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners: ((event: MessageEvent) => void)[] = [];

  constructor(readonly url: string) {}

  addEventListener(_type: 'torrents', listener: (event: MessageEvent) => void) {
    this.listeners.push(listener);
  }

  close() {
    this.readyState = 2;
    this.closed = true;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  send(data: unknown) {
    const event = new MessageEvent('torrents', { data: JSON.stringify(data) });
    for (const listener of this.listeners) listener(event);
  }

  // What the browser does after a dropped connection: it retries by itself.
  drop() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }

  // What the browser does on a 503 or other non-200: it gives up for good.
  refuse() {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('startLiveUpdates', () => {
  let sources: FakeEventSource[];
  let statuses: LiveStatus[];
  let onTorrents: Mock<(torrents: TorrentSummary[]) => void>;
  let stop: () => void;

  function start() {
    stop = startLiveUpdates({
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      document,
      onTorrents,
      onStatus: (status) => statuses.push(status),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    statuses = [];
    onTorrents = vi.fn<(torrents: TorrentSummary[]) => void>();
    setVisibility('visible');
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('opens one stream and passes on each list', () => {
    start();
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('/api/torrents/events');

    sources[0].open();
    sources[0].send([sampleSummary()]);

    expect(statuses).toEqual(['live']);
    expect(onTorrents).toHaveBeenCalledWith([sampleSummary()]);
  });

  it('closes the stream while the tab is hidden and reopens it', () => {
    start();
    setVisibility('hidden');
    expect(sources[0].closed).toBe(true);

    setVisibility('visible');
    expect(sources).toHaveLength(2);
    expect(sources[1].closed).toBe(false);
  });

  it("doesn't open a stream in a tab that starts hidden", () => {
    setVisibility('hidden');
    start();
    expect(sources).toHaveLength(0);

    setVisibility('visible');
    expect(sources).toHaveLength(1);
  });

  it('reports a dropped connection and leaves the retry to the browser', () => {
    start();
    sources[0].open();
    sources[0].drop();

    expect(statuses).toEqual(['live', 'reconnecting']);
    expect(sources[0].closed).toBe(false);

    sources[0].open();
    expect(statuses.at(-1)).toBe('live');
    expect(sources).toHaveLength(1);
  });

  it('retries a refused stream every 10 seconds', () => {
    start();
    sources[0].refuse();
    expect(statuses).toEqual(['unavailable']);

    vi.advanceTimersByTime(LIVE_RETRY_MS - 1);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);

    sources[1].open();
    expect(statuses).toEqual(['unavailable', 'live']);
  });

  it('cancels a pending retry when the tab is hidden', () => {
    start();
    sources[0].refuse();
    setVisibility('hidden');

    vi.advanceTimersByTime(LIVE_RETRY_MS);
    expect(sources).toHaveLength(1);
  });

  it('stops for good', () => {
    start();
    stop();
    expect(sources[0].closed).toBe(true);

    setVisibility('hidden');
    setVisibility('visible');
    expect(sources).toHaveLength(1);
  });
});
