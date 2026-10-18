// Stands in for webrtc-polyfill when its native module, node-datachannel,
// can't load (see server/peer-support.ts). simple-peer sees no
// RTCPeerConnection and reports no WebRTC support, so WebTorrent runs without
// WebRTC peers instead of failing to import.
export const RTCPeerConnection = undefined;
export const RTCSessionDescription = undefined;
export const RTCIceCandidate = undefined;
export default {};
