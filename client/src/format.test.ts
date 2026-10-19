import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatPercent,
  formatSpeed,
  stateLabel,
} from './format.js';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1000, '1.0 kB'],
    [1_500_000, '1.5 MB'],
    [129_241_752, '129 MB'],
    [4_700_000_000, '4.7 GB'],
    [2e15, '2000 TB'],
  ])('shows %d bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('shows a dash for nonsense', () => {
    expect(formatBytes(-1)).toBe('–');
    expect(formatBytes(Number.NaN)).toBe('–');
  });
});

describe('formatSpeed', () => {
  it('appends per second', () => {
    expect(formatSpeed(5_900_000)).toBe('5.9 MB/s');
    expect(formatSpeed(0)).toBe('0 B/s');
  });
});

describe('formatPercent', () => {
  it('rounds down to one decimal', () => {
    expect(formatPercent(0.4237)).toBe('42.3%');
    expect(formatPercent(0.9999)).toBe('99.9%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('clamps out-of-range values', () => {
    expect(formatPercent(-0.1)).toBe('0%');
    expect(formatPercent(1.2)).toBe('100%');
  });
});

describe('stateLabel', () => {
  const base = { hasMetadata: true, ready: true };

  it.each([
    ['connecting', 'connecting', 'Connecting'],
    ['downloading', 'downloading', 'Downloading'],
    ['seeding', 'seeding', 'Seeding'],
    ['noPeers', 'noPeers', 'No peers yet, still searching'],
    ['error', 'error', 'Failed'],
  ] as const)('labels %s', (state, tone, label) => {
    expect(stateLabel({ ...base, state })).toEqual({ tone, label });
  });

  it('shows a torrent verifying data on disk as Checking files', () => {
    expect(
      stateLabel({ state: 'connecting', hasMetadata: true, ready: false }),
    ).toEqual({ tone: 'checking', label: 'Checking files' });
  });

  it('shows a magnet link still fetching metadata as Connecting', () => {
    expect(
      stateLabel({ state: 'connecting', hasMetadata: false, ready: false }),
    ).toEqual({ tone: 'connecting', label: 'Connecting' });
  });
});
