import type {
  TorrentDetail,
  TorrentSummary,
} from '../../server/torrents-api.js';
import { type Api, streamUrl, subtitlesUrl } from './api.js';
import {
  bufferedAhead,
  isDownloadSlow,
  slowDownloadMessage,
} from './buffer-health.js';
import { playerStats, trackLabel } from './format.js';
import {
  mediaErrorProblem,
  type PlaybackProblem,
  pictureMissingProblem,
} from './media-error.js';
import type { PlayRoute } from './player-route.js';
import { linkButton } from './ui/button.js';
import { el } from './ui/dom.js';
import { type VideoPlayer, videoPlayer } from './ui/video-player.js';

// How long a <video> can sit in `waiting` before the status blames the swarm
// rather than ordinary buffering.
export const PEER_WAIT_MS = 5000;
// How long the download has to stay too slow before the player warns, so a
// download still ramping up when playback starts doesn't flash a warning.
export const SLOW_WARN_MS = 3000;

export interface PlayerOptions {
  api: Pick<Api, 'getTorrent' | 'selectFile' | 'resumeTorrent'>;
  // Where "Back to torrents" goes: the list's address.
  backHref?: string;
  // Injected so tests can drive the timer.
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  // Milliseconds, for SLOW_WARN_MS; injected so tests can drive it.
  now?: () => number;
}

export interface Player {
  element: HTMLElement;
  // Shows the video a route names. Resolves once it is on the page (or a
  // note saying why it can't be).
  open(route: PlayRoute): Promise<void>;
  // Stops playback and releases the stream.
  close(): void;
  // The live torrent list, for the stats line.
  update(torrents: TorrentSummary[]): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

const isVideo = (media: string) =>
  media === 'video' || media === 'video-may-not-play';

export function createPlayer({
  api,
  backHref = '#',
  setTimeout: startTimer = (callback, ms) =>
    globalThis.setTimeout(callback, ms),
  clearTimeout: stopTimer = (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now = () => Date.now(),
}: PlayerOptions): Player {
  const element = el('div', { className: 'player' });
  let current: {
    infoHash: string;
    // Takes the latest from the event stream.
    refresh(torrent: TorrentSummary): void;
    cleanup(): void;
  } | null = null;
  // Bumped on every open and close, so a slow fetch for a route the user has
  // already left doesn't show up afterwards.
  let generation = 0;

  function note(text: string): void {
    element.replaceChildren(
      el(
        'div',
        { className: 'player__note' },
        el('p', { text }),
        linkButton({ label: 'Back to torrents', href: backHref }),
      ),
    );
  }

  function release(): void {
    current?.cleanup();
    current = null;
  }

  // Maps the media events to the status line. `waiting` is ordinary
  // buffering at first; still waiting after PEER_WAIT_MS, or `stalled` while
  // waiting, means data isn't arriving from peers. A video that plays only
  // its sound keeps a warning up once buffering is over; an error replaces
  // everything (step 4.2a). Step 3.5 adds the seconds buffered ahead to the
  // stats line and warns while the download is slower than the video.
  function wire(
    player: VideoPlayer,
    file: { name: string; length: number },
    initial: TorrentSummary,
  ): { refresh(torrent: TorrentSummary): void; cleanup(): void } {
    const { video } = player;
    const fileName = file.name;
    let torrent = initial;
    // The download's speed is judged only once the video has played, and not
    // while an error is up.
    let judging = false;
    // When the download last turned too slow, and whether the warning is up.
    let slowSince: number | null = null;
    let warned = false;
    let waiting = false;
    let timer: unknown = null;
    // What the status line goes back to once nothing is loading: an error,
    // or the sound-only warning.
    let notice: PlaybackProblem | null = null;
    // Where a retry picks up again, once the reloaded stream has metadata.
    let resumeAt: number | null = null;
    // Reloading keeps the same src: the server answers a fresh range request.
    const retry = () => {
      resumeAt = video.currentTime;
      video.load();
    };
    const settle = () => {
      if (!notice) {
        player.setStatus(null);
        return;
      }
      const action = notice.retry
        ? { label: 'Retry', onClick: retry }
        : undefined;
      player.setStatus(notice.message, notice.tone, action);
    };
    const clearTimer = () => {
      if (timer !== null) stopTimer(timer);
      timer = null;
    };
    const peersSlow = () => player.setStatus('Waiting for data from peers…');
    const refreshHealth = () => {
      const loaded = video.readyState >= HTMLMediaElement.HAVE_METADATA;
      const ahead = loaded
        ? bufferedAhead(video.buffered, video.currentTime)
        : null;
      player.setStats(playerStats(torrent, ahead));
      const state = {
        ahead: ahead ?? 0,
        currentTime: video.currentTime,
        duration: video.duration,
        fileLength: file.length,
        downloadSpeed: torrent.downloadSpeed,
        downloaded: torrent.state === 'seeding',
      };
      const slow =
        judging &&
        ahead !== null &&
        isDownloadSlow(state, warned || slowSince !== null);
      if (!slow) {
        slowSince = null;
        warned = false;
      } else {
        slowSince ??= now();
        warned = now() - slowSince >= SLOW_WARN_MS;
      }
      player.setHealth(warned ? slowDownloadMessage(state) : null);
    };
    const handlers: Record<string, () => void> = {
      loadstart: () => {
        notice = null;
        judging = false;
        player.setStatus('Loading…');
        refreshHealth();
      },
      loadedmetadata: () => {
        if (video.videoWidth === 0) {
          notice = pictureMissingProblem(fileName);
          settle();
        }
        if (resumeAt !== null) {
          if (resumeAt > 0) video.currentTime = resumeAt;
          resumeAt = null;
          // Retry was a click, so the browser lets it play on.
          video.play()?.catch(() => {});
        }
      },
      waiting: () => {
        waiting = true;
        player.setStatus('Buffering…');
        clearTimer();
        timer = startTimer(() => {
          timer = null;
          if (waiting) peersSlow();
        }, PEER_WAIT_MS);
      },
      stalled: () => {
        if (waiting) peersSlow();
      },
      canplay: () => {
        waiting = false;
        clearTimer();
        settle();
      },
      playing: () => {
        waiting = false;
        clearTimer();
        settle();
        if (notice?.tone === 'error') return;
        judging = true;
        refreshHealth();
      },
      // The buffer grows (progress) and drains (timeupdate) between the
      // event stream's once-a-second updates.
      progress: refreshHealth,
      timeupdate: refreshHealth,
      error: () => {
        waiting = false;
        clearTimer();
        const problem = mediaErrorProblem(video.error?.code, fileName);
        if (!problem) return;
        // Kept until the next load: Chrome still fires `playing` when Play
        // is pressed on a failed stream.
        notice = problem;
        settle();
        judging = false;
        refreshHealth();
      },
    };
    for (const [type, handler] of Object.entries(handlers)) {
      video.addEventListener(type, handler);
    }
    refreshHealth();
    const cleanup = () => {
      clearTimer();
      for (const [type, handler] of Object.entries(handlers)) {
        video.removeEventListener(type, handler);
      }
      // Dropping the source aborts the range request, so the server destroys
      // its read stream and stops prioritising those pieces.
      video.pause();
      for (const track of video.querySelectorAll('track')) track.remove();
      video.removeAttribute('src');
      video.load();
    };
    return {
      refresh(latest) {
        torrent = latest;
        refreshHealth();
      },
      cleanup,
    };
  }

  function show(detail: TorrentDetail, index: number): void {
    const file = detail.files?.find((each) => each.index === index);
    if (!file || !isVideo(file.media)) {
      note('That file is not a video in this torrent.');
      return;
    }
    const player = videoPlayer({
      title: file.name,
      src: streamUrl(detail.infoHash, index),
      tracks: file.subtitles.map((subtitle) => ({
        src: subtitlesUrl(detail.infoHash, subtitle.index),
        language: subtitle.language,
        label: trackLabel(subtitle.language),
      })),
      backHref,
    });
    element.replaceChildren(player.element);
    current = { infoHash: detail.infoHash, ...wire(player, file, detail) };
  }

  return {
    element,
    async open(route) {
      release();
      const mine = ++generation;
      note('Loading…');
      let detail: TorrentDetail;
      try {
        detail = await api.getTorrent(route.infoHash);
      } catch (err) {
        if (mine === generation) note(`Couldn't open it: ${errorMessage(err)}`);
        return;
      }
      if (mine !== generation) return;
      if (detail.state === 'error') {
        note('This torrent failed, so it has nothing to play.');
        return;
      }
      if (!detail.files) {
        note('The file list is still coming from peers. Try again shortly.');
        return;
      }
      const file = detail.files.find((each) => each.index === route.index);
      // Decision #18: playing a video starts its background download, so the
      // rest of it is there when playback catches up. Playback doesn't wait
      // for this, and a failure only means slower buffering.
      if (file && isVideo(file.media) && !file.selected) {
        api.selectFile(detail.infoHash, file.index).catch(() => {});
      }
      // Pressing Play means the user wants the data, so a paused torrent
      // resumes; otherwise the video would buffer forever.
      if (file && isVideo(file.media) && detail.state === 'paused') {
        api.resumeTorrent(detail.infoHash).catch(() => {});
      }
      show(detail, route.index);
    },
    close() {
      generation += 1;
      release();
      element.replaceChildren();
    },
    update(torrents) {
      if (!current) return;
      const { infoHash, refresh } = current;
      const torrent = torrents.find((each) => each.infoHash === infoHash);
      if (torrent) refresh(torrent);
    },
  };
}
