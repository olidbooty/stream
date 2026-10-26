// @ts-expect-error WebTorrent ships no types for its internal modules.
import Peer from 'webtorrent/lib/peer.js';

interface PeerInternals {
  swarm: unknown;
  wire: unknown;
  handshake(): void;
}

const prototype = (Peer as { prototype: PeerInternals }).prototype;
const handshake = prototype.handshake;
let guarded = false;

// An encrypted incoming peer names its torrent mid-handshake. If that torrent
// is paused, WebTorrent destroys the peer (dropping its swarm and wire) but
// then finishes the encryption handshake anyway, and Peer.handshake() reads
// the dropped swarm and throws, which takes the whole server down. A peer with
// no swarm or wire is gone, so there is nothing to send it.
export function guardPeerHandshake(): void {
  if (guarded) return;
  guarded = true;
  prototype.handshake = function (this: PeerInternals) {
    if (!this.swarm || !this.wire) return;
    handshake.call(this);
  };
}
