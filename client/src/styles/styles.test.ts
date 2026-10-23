import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(name: string): string {
  const css = readFileSync(new URL(name, import.meta.url), 'utf8');
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const tokens = read('./tokens.css');
const components = read('./components.css');

// The declarations inside the first block that `selector` opens.
function block(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  const end = css.indexOf('}', start);
  return css
    .slice(start + selector.length + 2, end)
    .split(';')
    .map((line) => line.trim())
    .filter(Boolean);
}

function defined(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]));
}

describe('components.css (Decision #27)', () => {
  // Colours and sizes belong in tokens.css, so the UI changes from one place.
  it('has no colour, length or opacity literals', () => {
    const literal =
      /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|\b\d*\.?\d+(?:px|rem|em|ch)\b|opacity:\s*[\d.]/i;
    const offending = components
      .split('\n')
      .map((line, i) => ({ line: line.trim(), number: i + 1 }))
      .filter(({ line }) => literal.test(line));
    expect(offending).toEqual([]);
  });

  it('only uses tokens that are defined', () => {
    const available = new Set([...defined(tokens), ...defined(components)]);
    const used = Array.from(
      components.matchAll(/var\((--[\w-]+)/g),
      (m) => m[1],
    );
    expect(used.filter((name) => !available.has(name))).toEqual([]);
  });
});

describe('tokens.css themes (Decision #29)', () => {
  it('forces dark with the same values the OS setting gives', () => {
    const fromOS = block(tokens, ':root:not([data-theme="light"])');
    const forced = block(tokens, ':root[data-theme="dark"]').filter(
      (line) => !line.startsWith('color-scheme'),
    );
    expect(fromOS.length).toBeGreaterThan(0);
    expect(forced).toEqual(fromOS);
  });

  it('only overrides tokens that have a light value', () => {
    const light = defined(block(tokens, ':root').join(';'));
    const dark = defined(block(tokens, ':root[data-theme="dark"]').join(';'));
    expect([...dark].filter((name) => !light.has(name))).toEqual([]);
  });
});
