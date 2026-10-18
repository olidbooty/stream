import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventSink, EventStream, formatEvent } from './event-stream.js';

// Records what the stream writes; emit('close') stands in for a disconnect.
class FakeSink extends EventEmitter implements EventSink {
  chunks: string[] = [];
  writableNeedDrain = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  // The data of each event written, parsed.
  get events(): unknown[] {
    return this.chunks
      .filter((chunk) => chunk.startsWith('event:'))
      .map((chunk) => JSON.parse(chunk.split('\n')[1].slice('data: '.length)));
  }
}

describe('formatEvent', () => {
  it('writes a named event with one data line', () => {
    const data = JSON.stringify({ name: 'two\nlines' });

    expect(formatEvent('torrents', data)).toBe(
      'event: torrents\ndata: {"name":"two\\nlines"}\n\n',
    );
  });
});

describe('EventStream', () => {
  let state: { progress: number };
  let stream: EventStream;

  beforeEach(() => {
    vi.useFakeTimers();
    state = { progress: 0 };
    stream = new EventStream('torrents', () => state, {
      intervalMs: 1000,
      keepAliveMs: 15_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the current state straight away', () => {
    const sink = new FakeSink();

    stream.subscribe(sink);

    expect(sink.chunks).toEqual([formatEvent('torrents', '{"progress":0}')]);
  });

  it('sends changes at most once per interval', () => {
    const sink = new FakeSink();
    stream.subscribe(sink);

    state.progress = 0.1;
    state.progress = 0.2;
    vi.advanceTimersByTime(999);
    expect(sink.events).toEqual([{ progress: 0 }]);

    vi.advanceTimersByTime(1);
    expect(sink.events).toEqual([{ progress: 0 }, { progress: 0.2 }]);
  });

  it('sends nothing while the state is unchanged, apart from keep-alives', () => {
    const sink = new FakeSink();
    stream.subscribe(sink);

    vi.advanceTimersByTime(14_000);
    expect(sink.chunks).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(sink.chunks).toEqual([
      formatEvent('torrents', '{"progress":0}'),
      ': keep-alive\n\n',
    ]);
  });

  it('gives each subscriber what changed since it last heard', () => {
    const first = new FakeSink();
    stream.subscribe(first);
    state.progress = 0.5;
    const second = new FakeSink();
    stream.subscribe(second);

    vi.advanceTimersByTime(1000);

    expect(first.events).toEqual([{ progress: 0 }, { progress: 0.5 }]);
    expect(second.events).toEqual([{ progress: 0.5 }]);
  });

  it('skips a client that is not reading, then sends it the latest state', () => {
    const sink = new FakeSink();
    stream.subscribe(sink);
    sink.writableNeedDrain = true;

    state.progress = 0.1;
    vi.advanceTimersByTime(1000);
    state.progress = 0.2;
    vi.advanceTimersByTime(1000);
    expect(sink.chunks).toHaveLength(1);

    sink.writableNeedDrain = false;
    vi.advanceTimersByTime(1000);
    expect(sink.events).toEqual([{ progress: 0 }, { progress: 0.2 }]);
  });

  it('runs one timer while anyone is subscribed and stops it when all have gone', () => {
    const first = new FakeSink();
    const second = new FakeSink();
    expect(vi.getTimerCount()).toBe(0);

    stream.subscribe(first);
    stream.subscribe(second);
    expect(stream.size).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    first.emit('close');
    expect(stream.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    second.emit('close');
    expect(stream.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops writing to a client once it disconnects', () => {
    const sink = new FakeSink();
    stream.subscribe(sink);
    sink.emit('close');

    state.progress = 1;
    vi.advanceTimersByTime(20_000);

    expect(sink.chunks).toHaveLength(1);
  });
});
