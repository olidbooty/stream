import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { checkWebRTC, resolveWebRTCStub } from './peer-support.js';

const run = promisify(execFile);

describe('checkWebRTC', () => {
  it('reports WebRTC as available when node-datachannel loads', () => {
    expect(checkWebRTC(() => ({}))).toEqual({ available: true });
  });

  it('reports the error when it does not', () => {
    const error = new Error("Cannot find module 'node_datachannel.node'");

    expect(
      checkWebRTC(() => {
        throw error;
      }),
    ).toEqual({ available: false, error });
  });

  it('loads the real node-datachannel here', () => {
    expect(checkWebRTC()).toEqual({ available: true });
  });
});

describe('resolveWebRTCStub', () => {
  it('sends webrtc-polyfill to the stub and leaves the rest alone', () => {
    const next = vi.fn((specifier: string) => ({ url: specifier }));
    const context = {
      conditions: [],
      importAttributes: {},
      parentURL: 'file:///srv/node_modules/simple-peer/lite.js',
    };

    resolveWebRTCStub('webrtc-polyfill', context, next);
    resolveWebRTCStub('webtorrent', context, next);

    expect(next).toHaveBeenNthCalledWith(1, './webrtc-stub.js', {
      ...context,
      parentURL: new URL('./peer-support.ts', import.meta.url).href,
    });
    expect(next).toHaveBeenNthCalledWith(2, 'webtorrent', context);
  });
});

// Loads webtorrent in a child process where node-datachannel can't load, as
// on a platform without its prebuilt binary.
async function importWithoutDataChannel(disable: boolean) {
  const peerSupport = pathToFileURL('server/peer-support.ts').href;
  const code = `
    import { registerHooks } from 'node:module';
    import { checkWebRTC, disableWebRTC } from '${peerSupport}';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'node-datachannel') {
          throw Object.assign(new Error('no binary'), { code: 'MODULE_NOT_FOUND' });
        }
        return next(specifier, context);
      },
    });
    const check = checkWebRTC();
    if (${disable}) disableWebRTC();
    try {
      const { default: WebTorrent } = await import('webtorrent');
      const { default: Peer } = await import('@thaunknown/simple-peer/lite.js');
      console.log(JSON.stringify({
        available: check.available,
        loaded: typeof WebTorrent === 'function',
        webrtc: Peer.WEBRTC_SUPPORT,
      }));
    } catch (err) {
      console.log(JSON.stringify({ available: check.available, loaded: false, error: err.code }));
    }
  `;
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: new URL('..', import.meta.url) },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
}

describe('disableWebRTC', () => {
  it('lets webtorrent load without node-datachannel', async () => {
    expect(await importWithoutDataChannel(true)).toEqual({
      available: false,
      loaded: true,
      webrtc: false,
    });
  }, 30_000);

  it('is needed: webtorrent fails to import without it', async () => {
    expect(await importWithoutDataChannel(false)).toMatchObject({
      available: false,
      loaded: false,
    });
  }, 30_000);
});
