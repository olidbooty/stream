// What the player says when the browser can't play a file (step 4.2a,
// Decision #17). The browser only reports a MediaError code, so the
// messages name the file and its container and leave the codec as a guess;
// 4.2b adds the real codecs when ffprobe is installed.

// HTMLMediaElement's MediaError codes. jsdom has no MediaError, so they are
// spelled out rather than read from the global.
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export interface PlaybackProblem {
  message: string;
  // `warning` while something still plays, such as the sound alone.
  tone: 'warning' | 'error';
  // Whether reloading the stream might help.
  retry: boolean;
}

// The container as people name it, from the extension: "MKV" for
// `Sintel.mkv`. Null for a name without one.
export function containerName(fileName: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return match ? match[1].toUpperCase() : null;
}

// Null for an abort, which is what closing the player or retrying causes.
export function mediaErrorProblem(
  code: number | undefined,
  fileName: string,
): PlaybackProblem | null {
  switch (code) {
    case MEDIA_ERR_ABORTED:
      return null;
    case MEDIA_ERR_NETWORK:
      return {
        message: `The stream of ${fileName} was cut off. Check that the server is still running, then retry.`,
        tone: 'error',
        retry: true,
      };
    case MEDIA_ERR_DECODE:
      return {
        message: `${fileName} stopped playing because this browser couldn't decode it. The file may be damaged, or one of its codecs isn't supported.`,
        tone: 'error',
        retry: false,
      };
    case MEDIA_ERR_SRC_NOT_SUPPORTED: {
      const container = containerName(fileName);
      const format = container ? `the ${container} format` : 'its format';
      return {
        message: `This browser can't play ${fileName}. It doesn't support ${format} or the codecs inside it.`,
        tone: 'error',
        retry: false,
      };
    }
    default:
      return {
        message: `This video can't be played: ${fileName}`,
        tone: 'error',
        retry: false,
      };
  }
}

// A video whose metadata loaded with no picture size: the browser plays the
// sound but can't decode the picture, typically HEVC (H.265) outside Safari.
export function pictureMissingProblem(fileName: string): PlaybackProblem {
  return {
    message: `Only the sound of ${fileName} will play. This browser can't show its picture, usually because the video codec (often HEVC/H.265) isn't supported.`,
    tone: 'warning',
    retry: false,
  };
}
