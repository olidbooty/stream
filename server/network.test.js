import { describe, expect, it } from 'vitest';
import { lanAddresses } from './network.js';

describe('lanAddresses', () => {
  it('returns only external IPv4 addresses', () => {
    const interfaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      eth0: [
        { family: 'IPv4', address: '192.168.1.20', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      wlan0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }],
    };

    expect(lanAddresses(interfaces)).toEqual(['192.168.1.20', '10.0.0.5']);
  });

  it('returns an empty list when there is no network', () => {
    expect(lanAddresses({})).toEqual([]);
  });
});
