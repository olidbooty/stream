import {
  createRequire,
  type ResolveHookSync,
  registerHooks,
} from 'node:module';

// Decision #10: native modules may be missing on platforms without prebuilt
// binaries, such as Linux on ARM. WebTorrent already falls back to TCP when
// utp-native is missing (WebTorrent.UTP_SUPPORT), but webrtc-polyfill imports
// node-datachannel statically, so without it `import 'webtorrent'` throws.

const require = createRequire(import.meta.url);

export type WebRTCCheck =
  | { available: true }
  | { available: false; error: unknown };

export function checkWebRTC(
  load: () => unknown = () => require('node-datachannel'),
): WebRTCCheck {
  try {
    load();
    return { available: true };
  } catch (error) {
    return { available: false, error };
  }
}

// Resolves webrtc-polyfill to server/webrtc-stub.ts instead.
export const resolveWebRTCStub: ResolveHookSync = (
  specifier,
  context,
  nextResolve,
) =>
  specifier === 'webrtc-polyfill'
    ? nextResolve('./webrtc-stub.js', {
        ...context,
        parentURL: import.meta.url,
      })
    : nextResolve(specifier, context);

// Module resolution happens before any code runs, so this must be called
// before anything imports webtorrent; server/index.ts imports the server
// only afterwards.
export function disableWebRTC(): void {
  registerHooks({ resolve: resolveWebRTCStub });
}
