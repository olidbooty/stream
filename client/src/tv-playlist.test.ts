import { afterEach, describe, expect, it, vi } from 'vitest';
import { tvPlaylist } from './tv-playlist.js';

const URL_A = 'http://192.168.1.20:1234/tv.m3u';
const URL_B = 'http://10.0.0.5:1234/tv.m3u';

afterEach(() => {
  document.body.replaceChildren();
});

function setUp(
  getTv: () => Promise<{ playlistUrls: string[] }>,
  clipboard?: Pick<Clipboard, 'writeText'>,
) {
  const tv = tvPlaylist({ api: { getTv }, clipboard });
  document.body.append(tv.element);
  return tv;
}

function visibleText(element: HTMLElement): string {
  return Array.from(element.querySelectorAll<HTMLElement>('p, code'))
    .filter((node) => !node.closest('[hidden]'))
    .map((node) => node.textContent)
    .join('\n');
}

describe('tvPlaylist', () => {
  it('is hidden until the address is loaded', async () => {
    const tv = setUp(async () => ({ playlistUrls: [URL_A] }));
    expect(tv.element.hidden).toBe(true);

    await tv.load();

    expect(tv.element.hidden).toBe(false);
    expect(tv.element.querySelector('code')?.textContent).toBe(URL_A);
    expect(visibleText(tv.element)).not.toContain('try');
  });

  it('offers the other addresses after the first', async () => {
    const tv = setUp(async () => ({ playlistUrls: [URL_A, URL_B] }));

    await tv.load();

    expect(tv.element.querySelector('code')?.textContent).toBe(URL_A);
    expect(visibleText(tv.element)).toContain(
      `If the TV can’t open it, try ${URL_B}.`,
    );
  });

  it('says so when the computer has no LAN address', async () => {
    const tv = setUp(async () => ({ playlistUrls: [] }));

    await tv.load();

    expect(tv.element.hidden).toBe(false);
    expect(visibleText(tv.element)).toContain('no network address');
    expect(visibleText(tv.element)).not.toContain('VLC');
  });

  it('stays hidden if the server cannot answer', async () => {
    const tv = setUp(async () => {
      throw new Error('down');
    });

    await tv.load();

    expect(tv.element.hidden).toBe(true);
  });

  it('hides with the list while the player is open', async () => {
    const tv = setUp(async () => ({ playlistUrls: [URL_A] }));
    tv.setShown(false);

    await tv.load();
    expect(tv.element.hidden).toBe(true);

    tv.setShown(true);
    expect(tv.element.hidden).toBe(false);
  });

  it('copies the address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const tv = setUp(async () => ({ playlistUrls: [URL_A] }), { writeText });
    await tv.load();

    const copy = tv.element.querySelector('button') as HTMLButtonElement;
    copy.click();
    await vi.waitFor(() =>
      expect(tv.element.querySelector('[role="status"]')?.textContent).toBe(
        'Copied',
      ),
    );
    expect(writeText).toHaveBeenCalledWith(URL_A);
  });

  it('has no Copy button without clipboard access', async () => {
    const tv = setUp(async () => ({ playlistUrls: [URL_A] }));
    await tv.load();

    expect(tv.element.querySelector('button')?.hidden).toBe(true);
  });
});
