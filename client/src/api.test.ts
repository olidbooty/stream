import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type Fetch } from './api.js';
import { SAMPLE_HASH, sampleDetail, sampleSummary } from './sample-data.js';

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stub(response: Response) {
  return vi.fn<Fetch>().mockResolvedValue(response);
}

describe('createApi', () => {
  it('lists torrents', async () => {
    const fetch = stub(respond(200, [sampleSummary()]));
    const torrents = await createApi(fetch).listTorrents();
    expect(fetch).toHaveBeenCalledWith('/api/torrents', undefined);
    expect(torrents).toEqual([sampleSummary()]);
  });

  it('gets one torrent', async () => {
    const fetch = stub(respond(200, sampleDetail()));
    const detail = await createApi(fetch).getTorrent(SAMPLE_HASH);
    expect(fetch).toHaveBeenCalledWith(
      `/api/torrents/${SAMPLE_HASH}`,
      undefined,
    );
    expect(detail.mainFile).toBe(1);
  });

  it('posts a magnet link as JSON', async () => {
    const fetch = stub(respond(201, sampleSummary()));
    await createApi(fetch).addMagnet('magnet:?xt=urn:btih:abc');
    expect(fetch).toHaveBeenCalledWith('/api/torrents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet: 'magnet:?xt=urn:btih:abc' }),
    });
  });

  it('posts a .torrent file as the raw body', async () => {
    const fetch = stub(respond(201, sampleSummary()));
    const file = new File([new Uint8Array([100, 101])], 'sintel.torrent');
    await createApi(fetch).addTorrentFile(file);
    expect(fetch).toHaveBeenCalledWith('/api/torrents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-bittorrent' },
      body: file,
    });
  });

  it('deletes a torrent', async () => {
    const fetch = stub(new Response(null, { status: 204 }));
    await createApi(fetch).removeTorrent(SAMPLE_HASH);
    expect(fetch).toHaveBeenCalledWith(`/api/torrents/${SAMPLE_HASH}`, {
      method: 'DELETE',
    });
  });

  it('selects another video', async () => {
    const fetch = stub(new Response(null, { status: 204 }));
    await createApi(fetch).selectFile(SAMPLE_HASH, 2);
    expect(fetch).toHaveBeenCalledWith(
      `/api/torrents/${SAMPLE_HASH}/files/2/select`,
      { method: 'POST' },
    );
  });

  it.each(['pause', 'resume'] as const)('posts %s', async (action) => {
    const fetch = stub(new Response(null, { status: 204 }));
    const api = createApi(fetch);
    await (action === 'pause'
      ? api.pauseTorrent(SAMPLE_HASH)
      : api.resumeTorrent(SAMPLE_HASH));
    expect(fetch).toHaveBeenCalledWith(
      `/api/torrents/${SAMPLE_HASH}/${action}`,
      { method: 'POST' },
    );
  });

  it("throws the server's error message with the status", async () => {
    const fetch = stub(
      respond(409, { error: 'This torrent has already been added' }),
    );
    const err = await createApi(fetch)
      .addMagnet('magnet:?xt=urn:btih:abc')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      message: 'This torrent has already been added',
    });
  });

  it('falls back to the status line when the body is not JSON', async () => {
    const fetch = stub(
      new Response('<h1>Bad Gateway</h1>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );
    await expect(createApi(fetch).listTorrents()).rejects.toMatchObject({
      status: 502,
      message: 'The server answered 502 Bad Gateway',
    });
  });

  it('uses another base path if given', async () => {
    const fetch = stub(respond(200, []));
    await createApi(fetch, '/x').listTorrents();
    expect(fetch).toHaveBeenCalledWith('/x', undefined);
  });
});
