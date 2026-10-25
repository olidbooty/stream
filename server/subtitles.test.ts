import { describe, expect, it } from 'vitest';
import { decodeSubtitle, srtToVtt, toVtt } from './subtitles.js';

describe('srtToVtt', () => {
  it('adds the header, drops cue numbers and uses dots in timestamps', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      'Hello',
      '',
      '2',
      '00:01:00,250 --> 00:01:03,000',
      '<i>Two</i>',
      'lines',
      '',
    ].join('\r\n');

    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:02.500\nHello\n\n' +
        '00:01:00.250 --> 00:01:03.000\n<i>Two</i>\nlines\n\n',
    );
  });

  it('copes with missing numbers, one-digit hours, coordinates and extra blank lines', () => {
    const srt =
      '0:00:01,000 --> 0:00:02,000 X1:10 X2:20\nNo number\n\n\n\n' +
      '7\n00:00:03,000-->00:00:04,000\nA --> B\n';

    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:02.000\nNo number\n\n' +
        '00:00:03.000 --> 00:00:04.000\nA -> B\n\n',
    );
  });

  it('skips blocks without a timing line', () => {
    expect(srtToVtt('junk\n\n1\nnot a time\ntext\n')).toBe('WEBVTT\n\n');
  });
});

describe('decodeSubtitle', () => {
  it('reads UTF-8 and drops a byte order mark', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('Café'),
    ]);
    expect(decodeSubtitle(bytes)).toBe('Café');
  });

  it('falls back to Windows-1252', () => {
    // "Café – ok" in Windows-1252: é is 0xE9 and the en dash 0x96.
    const bytes = new Uint8Array([
      0x43, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x6f, 0x6b,
    ]);
    expect(decodeSubtitle(bytes)).toBe('Café – ok');
  });
});

describe('toVtt', () => {
  it('converts by extension', () => {
    const srt = new TextEncoder().encode(
      '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
    );
    expect(toVtt('a.SRT', srt)).toContain('00:00:01.000');
    expect(toVtt('a.vtt', new TextEncoder().encode('WEBVTT\n'))).toBe(
      'WEBVTT\n',
    );
  });
});
