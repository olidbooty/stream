import { button, linkButton } from './button.js';
import { el } from './dom.js';

export interface VideoTrack {
  src: string;
  // BCP 47 code, or null when the file name has none.
  language: string | null;
  label: string;
}

export interface VideoPlayerOptions {
  title: string;
  // Left out in the gallery, which has no server to stream from.
  src?: string;
  tracks: VideoTrack[];
  // Where "Back to torrents" goes.
  backHref: string;
}

// `info` for passing states such as buffering; `warning` and `error` show
// as a status banner, `warning` while something still plays.
export type PlayerStatusTone = 'info' | 'warning' | 'error';

// A button after the status message, such as Retry.
export interface PlayerStatusAction {
  label: string;
  onClick(): void;
}

export interface VideoPlayer {
  element: HTMLElement;
  video: HTMLVideoElement;
  // A short line over the playback state, or null to clear it.
  setStatus(
    message: string | null,
    tone?: PlayerStatusTone,
    action?: PlayerStatusAction,
  ): void;
  setStats(text: string): void;
  // A warning that the download isn't keeping up (step 3.5), or null.
  setHealth(message: string | null): void;
}

// The player view: a native <video> with controls, its subtitle tracks, a
// status line for buffering and errors, a buffer health warning, and the
// download's stats. Plain data
// in, elements out; player.ts wires it to the media events and the API.
export function videoPlayer({
  title,
  src,
  tracks,
  backHref,
}: VideoPlayerOptions): VideoPlayer {
  const video = el('video', {
    className: 'video-player__video',
    attrs: { controls: '', playsinline: '', preload: 'metadata' },
  });
  for (const track of tracks) {
    const attrs: Record<string, string> = {
      kind: 'subtitles',
      src: track.src,
      label: track.label,
    };
    if (track.language) attrs.srclang = track.language;
    video.append(el('track', { attrs }));
  }
  if (src) video.src = src;

  // role=status, so "Buffering" is announced without stealing focus.
  const status = el('p', {
    className: 'video-player__status',
    attrs: { role: 'status' },
  });
  status.hidden = true;
  // Its own status, so the warning is announced once when it appears, apart
  // from the buffering line and from the stats, which change every second.
  const health = el('p', {
    className: 'video-player__health status-banner',
    attrs: { role: 'status', 'data-tone': 'warning' },
  });
  health.hidden = true;
  const stats = el('p', { className: 'video-player__stats' });

  const element = el(
    'section',
    { className: 'video-player', attrs: { 'aria-label': `Playing ${title}` } },
    el(
      'div',
      { className: 'video-player__head' },
      linkButton({ label: 'Back to torrents', href: backHref }),
      el('h2', { className: 'video-player__title', text: title }),
    ),
    video,
    status,
    health,
    stats,
  );

  return {
    element,
    video,
    setStatus(message, tone = 'info', action) {
      status.replaceChildren(message ?? '');
      if (message !== null && action) {
        status.append(button({ label: action.label, onClick: action.onClick }));
      }
      status.className =
        tone === 'info'
          ? 'video-player__status'
          : 'video-player__status status-banner';
      status.dataset.tone = tone;
      status.hidden = message === null;
    },
    setStats(text) {
      stats.textContent = text;
    },
    setHealth(message) {
      // Only touched on a change, so screen readers don't hear it again.
      if (health.textContent === (message ?? '')) return;
      health.textContent = message ?? '';
      health.hidden = message === null;
    },
  };
}
