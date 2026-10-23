import type { TorrentSummary } from '../../server/torrents-api.js';

// The part of EventSource used here, so tests can pass a fake.
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(
    type: 'torrents',
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

// EventSource.CLOSED; jsdom has no EventSource to read it from.
const CLOSED = 2;

// `live`: connected. `reconnecting`: the connection dropped and the browser is
// retrying by itself. `unavailable`: the server refused the stream (503 above
// Decision #21's cap, or any other non-200), so this module retries.
export type LiveStatus = 'live' | 'reconnecting' | 'unavailable';

export interface LiveUpdatesOptions {
  createEventSource(url: string): EventSourceLike;
  document: Document;
  onTorrents(torrents: TorrentSummary[]): void;
  onStatus(status: LiveStatus): void;
  url?: string;
  retryMs?: number;
}

export const LIVE_RETRY_MS = 10_000;

// Decision #21: one event stream per page, closed while the tab is hidden so a
// background tab holds no connection, and reopened when it is shown. The server
// sends the whole list on connect, so nothing is missed in between.
export function startLiveUpdates({
  createEventSource,
  document,
  onTorrents,
  onStatus,
  url = '/api/torrents/events',
  retryMs = LIVE_RETRY_MS,
}: LiveUpdatesOptions): () => void {
  let source: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    retry = null;
    if (source || document.visibilityState === 'hidden') return;
    const current = createEventSource(url);
    source = current;
    current.addEventListener('torrents', (event) => {
      onTorrents(JSON.parse(event.data));
    });
    current.onopen = () => onStatus('live');
    current.onerror = () => {
      if (current.readyState !== CLOSED) {
        onStatus('reconnecting');
        return;
      }
      // EventSource gives up for good on a non-200 answer.
      current.close();
      source = null;
      onStatus('unavailable');
      retry = setTimeout(open, retryMs);
    };
  }

  function close(): void {
    if (retry) clearTimeout(retry);
    retry = null;
    source?.close();
    source = null;
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') close();
    else open();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  open();

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    close();
  };
}
