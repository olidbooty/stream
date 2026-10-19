import { describe, expect, it } from 'vitest';
import { repairPeerAddress } from './peer-address.js';

// What bittorrent-tracker 11.2.3 emits for a non-compact peer list: bencode 4
// decodes `ip` to a Uint8Array, which a template string joins with commas.
function garbled(ip: string, port: number): string {
  return `${new TextEncoder().encode(ip)}:${port}`;
}

describe('repairPeerAddress', () => {
  it('reproduces the bug it works around', () => {
    expect(garbled('185.125.190.59', 6944)).toBe(
      '49,56,53,46,49,50,53,46,49,57,48,46,53,57:6944',
    );
  });

  it('decodes an IPv4 address', () => {
    expect(repairPeerAddress(garbled('185.125.190.59', 6944))).toBe(
      '185.125.190.59:6944',
    );
  });

  it('decodes an IPv6 address and adds brackets', () => {
    expect(repairPeerAddress(garbled('2606:4700::1', 51946))).toBe(
      '[2606:4700::1]:51946',
    );
  });

  it('decodes a hostname', () => {
    expect(repairPeerAddress(garbled('peer.example.com', 6881))).toBe(
      'peer.example.com:6881',
    );
  });

  it.each([
    '185.125.190.59:6944',
    '[2606:4700::1]:51946',
    'peer.example.com:6881',
  ])('leaves the well-formed address %s alone', (addr) => {
    expect(repairPeerAddress(addr)).toBe(addr);
  });

  it.each([
    ['a byte over 255', '300,49:6881'],
    ['bytes that are not a host', '0,10,32:6881'],
    ['no port', '49,50,51'],
  ])('leaves %s alone', (_kind, addr) => {
    expect(repairPeerAddress(addr)).toBe(addr);
  });
});
