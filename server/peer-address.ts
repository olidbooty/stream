// Works around a bug in bittorrent-tracker 11.2.3 (via webtorrent 3.0.21),
// found in the real-swarm check (Risks #9). For an HTTP tracker's
// non-compact peer list it builds each address as `${peer.ip}:${peer.port}`,
// but bencode 4 decodes `ip` as a Uint8Array, so the address comes out as
// its bytes joined by commas ("49,56,53,46,...:6944" for 185.x.x.x:6944) and
// every connection to it fails a DNS lookup. torrent.ubuntu.com answers
// IPv6 announces this way, so a host with IPv6 got no tracker peers at all.

// Byte values joined by commas, then the port.
const BYTE_LIST_ADDRESS = /^(\d{1,3}(?:,\d{1,3})+):(\d{1,5})$/;
// What a decoded host may contain: an IPv4 or IPv6 address, or a hostname.
const HOST = /^[0-9A-Za-z.:%_-]+$/;

// Returns the address with its host decoded, or the address unchanged if it
// isn't one of the broken ones. IPv6 hosts get brackets, as WebTorrent
// expects ("[2606:4700::1]:51946").
export function repairPeerAddress(addr: string): string {
  const match = BYTE_LIST_ADDRESS.exec(addr);
  if (!match) return addr;
  const bytes = match[1].split(',').map(Number);
  if (bytes.some((byte) => byte > 255)) return addr;
  const host = String.fromCharCode(...bytes);
  if (!HOST.test(host)) return addr;
  return host.includes(':') ? `[${host}]:${match[2]}` : `${host}:${match[2]}`;
}
