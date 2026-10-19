// Entry point. Checks WebRTC's native module before anything imports
// webtorrent, which would otherwise fail to load without it (Decision #10).
import { checkWebRTC, disableWebRTC } from './peer-support.js';

const webrtcCheck = checkWebRTC();
if (!webrtcCheck.available) {
  console.warn(
    'WebRTC is unavailable, so only BitTorrent peers (TCP, uTP) are used: node-datachannel failed to load.',
  );
  console.warn(
    '  Reinstall with network access, or a C++ toolchain and CMake on platforms without prebuilt binaries.',
  );
  const { error } = webrtcCheck;
  console.warn(
    `  ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
  );
  disableWebRTC();
}

const { start } = await import('./start.js');
await start({ webrtc: webrtcCheck.available });
