import { describe, expect, it } from 'vitest';
import { parsePlayRoute, playHref } from './player-route.js';

const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';

describe('parsePlayRoute', () => {
  it('reads the info hash and file index', () => {
    expect(parsePlayRoute(`#play/${HASH}/3`)).toEqual({
      infoHash: HASH,
      index: 3,
    });
    expect(parsePlayRoute(`#play/${HASH.toUpperCase()}/0`)?.infoHash).toBe(
      HASH,
    );
  });

  it.each([
    '',
    '#',
    `#play/${HASH}`,
    `#play/${HASH}/01`,
    `#play/${HASH}/-1`,
    `#play/${HASH}/1/extra`,
    '#play/abc/1',
  ])('ignores %s', (hash) => {
    expect(parsePlayRoute(hash)).toBeNull();
  });

  it('reads what playHref writes', () => {
    expect(parsePlayRoute(playHref(HASH, 12))).toEqual({
      infoHash: HASH,
      index: 12,
    });
  });
});
