import { describe, expect, it } from 'vitest';
import {
  containerName,
  MEDIA_ERR_ABORTED,
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  mediaErrorProblem,
  pictureMissingProblem,
} from './media-error.js';

describe('containerName', () => {
  it('names the container from the extension', () => {
    expect(containerName('Sintel.mkv')).toBe('MKV');
    expect(containerName('Big.Buck.Bunny.MP4')).toBe('MP4');
  });

  it('is null without an extension', () => {
    expect(containerName('README')).toBeNull();
  });
});

describe('mediaErrorProblem', () => {
  it('ignores an abort', () => {
    expect(mediaErrorProblem(MEDIA_ERR_ABORTED, 'Sintel.mp4')).toBeNull();
  });

  it('offers a retry when the stream is cut off', () => {
    expect(mediaErrorProblem(MEDIA_ERR_NETWORK, 'Sintel.mp4')).toEqual({
      message:
        'The stream of Sintel.mp4 was cut off. Check that the server is still running, then retry.',
      tone: 'error',
      retry: true,
    });
  });

  it('blames the file or a codec when decoding fails', () => {
    const problem = mediaErrorProblem(MEDIA_ERR_DECODE, 'Sintel.mp4');
    expect(problem?.message).toBe(
      "Sintel.mp4 stopped playing because this browser couldn't decode it. The file may be damaged, or one of its codecs isn't supported.",
    );
    expect(problem?.retry).toBe(false);
  });

  it('names the container when the format is not supported', () => {
    expect(
      mediaErrorProblem(MEDIA_ERR_SRC_NOT_SUPPORTED, 'Sintel.mkv'),
    ).toEqual({
      message:
        "This browser can't play Sintel.mkv. It doesn't support the MKV format or the codecs inside it.",
      tone: 'error',
      retry: false,
    });
    expect(
      mediaErrorProblem(MEDIA_ERR_SRC_NOT_SUPPORTED, 'Sintel')?.message,
    ).toBe(
      "This browser can't play Sintel. It doesn't support its format or the codecs inside it.",
    );
  });

  it('falls back to a plain message for an unknown code', () => {
    expect(mediaErrorProblem(undefined, 'Sintel.mp4')?.message).toBe(
      "This video can't be played: Sintel.mp4",
    );
  });
});

it('warns when only the sound will play', () => {
  expect(pictureMissingProblem('Sintel.mkv')).toMatchObject({
    tone: 'warning',
    retry: false,
  });
  expect(pictureMissingProblem('Sintel.mkv').message).toContain(
    'Only the sound of Sintel.mkv will play.',
  );
});
