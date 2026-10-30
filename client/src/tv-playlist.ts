import type { Api } from './api.js';
import { button } from './ui/button.js';
import { el } from './ui/dom.js';

export interface TvPlaylistOptions {
  api: Pick<Api, 'getTv'>;
  // navigator.clipboard, which only exists on secure pages such as
  // localhost. Without it the address is still there to select.
  clipboard?: Pick<Clipboard, 'writeText'>;
}

export interface TvPlaylist {
  element: HTMLElement;
  // Shows the playlist address: the first one to try, then any others.
  update(playlistUrls: string[]): void;
  // Asks the server for the addresses; hidden if it can't answer.
  load(): Promise<void>;
  // Shown with the settings page, once there is something to show.
  setShown(shown: boolean): void;
}

// Step 3.11: the /tv.m3u address to save in VLC on a TV once. On the settings
// page, since it is set up once and then rarely needed.
export function tvPlaylist({ api, clipboard }: TvPlaylistOptions): TvPlaylist {
  const address = el('code', { className: 'tv-playlist__address' });
  const copied = el('span', {
    className: 'tv-playlist__copied',
    attrs: { role: 'status' },
  });
  const copy = button({
    label: 'Copy',
    onClick: () => {
      clipboard?.writeText(address.textContent ?? '').then(
        () => {
          copied.textContent = 'Copied';
        },
        () => {
          copied.textContent = 'Select the address to copy it';
        },
      );
    },
  });
  copy.hidden = !clipboard;
  const others = el('p', { className: 'tv-playlist__note' });
  const noNetwork = el('p', {
    text: 'This computer has no network address another device can reach, so the TV can’t connect yet. Check it is on your home network, then reload.',
  });
  const found = el(
    'div',
    { className: 'tv-playlist__found' },
    el('p', {
      text: 'In VLC on your TV, choose Stream (Network Stream in some versions), enter this address and save it as a favourite. It lists every video here, including ones added later.',
    }),
    el('div', { className: 'tv-playlist__row' }, address, copy, copied),
    others,
    el('p', {
      className: 'tv-playlist__note',
      text: 'VLC can’t load subtitles from a playlist, so videos play without them there.',
    }),
  );
  const element = el(
    'section',
    {
      className: 'tv-playlist',
      attrs: { 'aria-labelledby': 'tv-playlist-heading' },
    },
    el('h2', { text: 'Watch on TV', attrs: { id: 'tv-playlist-heading' } }),
    found,
    noNetwork,
  );
  let loaded = false;
  let shown = true;
  const show = () => {
    element.hidden = !(loaded && shown);
  };
  show();

  function update(playlistUrls: string[]): void {
    const [first, ...rest] = playlistUrls;
    loaded = true;
    show();
    found.hidden = !first;
    noNetwork.hidden = Boolean(first);
    address.textContent = first ?? '';
    copied.textContent = '';
    others.hidden = rest.length === 0;
    others.textContent = `If the TV can’t open it, try ${rest.join(' or ')}.`;
  }

  return {
    element,
    update,
    async load() {
      try {
        update((await api.getTv()).playlistUrls);
      } catch {
        // Not worth an error: the TV address is optional, and the status
        // banner already says when the server is down.
        loaded = false;
        show();
      }
    },
    setShown(value) {
      shown = value;
      show();
    },
  };
}
