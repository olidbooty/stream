// The part of a ServerResponse an event stream writes to, so tests can pass a
// plain object.
export interface EventSink {
  write(chunk: string): boolean;
  // True while the socket's buffer is full, e.g. a phone that went to sleep.
  readonly writableNeedDrain: boolean;
  once(event: 'close', listener: () => void): unknown;
}

export interface EventStreamOptions {
  // How often the snapshot is checked for changes.
  intervalMs?: number;
  // How long a stream may stay silent before a comment is sent, so proxies
  // and browsers don't treat a quiet stream as dead.
  keepAliveMs?: number;
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  // Stops nginx and similar proxies from buffering the stream.
  'X-Accel-Buffering': 'no',
};

// JSON.stringify escapes newlines, so the data always fits on one `data:` line.
export function formatEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

interface Subscriber {
  sink: EventSink;
  // What this subscriber last received, so it only gets changes.
  sent: string | null;
  lastWriteAt: number;
}

// Pushes a JSON snapshot to every subscriber as a server-sent event: once on
// subscribe, then at most once per interval and only when it changed. Speeds
// change every second while anything transfers, so an active swarm still
// updates each second; an idle one sends only keep-alives.
//
// One timer serves all subscribers and runs only while there are any. It
// reads the snapshot rather than listening to torrents, so nothing is left
// attached when a torrent is removed.
export class EventStream {
  private readonly event: string;
  private readonly snapshot: () => unknown;
  private readonly intervalMs: number;
  private readonly keepAliveMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    event: string,
    snapshot: () => unknown,
    { intervalMs = 1000, keepAliveMs = 15_000 }: EventStreamOptions = {},
  ) {
    this.event = event;
    this.snapshot = snapshot;
    this.intervalMs = intervalMs;
    this.keepAliveMs = keepAliveMs;
  }

  get size(): number {
    return this.subscribers.size;
  }

  // The caller sends the headers (SSE_HEADERS) first. The subscriber is
  // dropped when the sink closes.
  subscribe(sink: EventSink): void {
    const subscriber: Subscriber = { sink, sent: null, lastWriteAt: 0 };
    this.subscribers.add(subscriber);
    sink.once('close', () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    });
    this.send(subscriber, JSON.stringify(this.snapshot()), Date.now());
    this.start();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Open streams keep the server alive anyway; the timer alone shouldn't.
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const data = JSON.stringify(this.snapshot());
    const now = Date.now();
    for (const subscriber of this.subscribers) {
      // Skip a client that isn't reading rather than queue snapshots it will
      // never need: once it drains, the next tick sends the latest one.
      if (subscriber.sink.writableNeedDrain) continue;
      if (data !== subscriber.sent) {
        this.send(subscriber, data, now);
      } else if (now - subscriber.lastWriteAt >= this.keepAliveMs) {
        subscriber.sink.write(': keep-alive\n\n');
        subscriber.lastWriteAt = now;
      }
    }
  }

  private send(subscriber: Subscriber, data: string, now: number): void {
    subscriber.sink.write(formatEvent(this.event, data));
    subscriber.sent = data;
    subscriber.lastWriteAt = now;
  }
}
