import { describe, expect, it } from 'vitest';
import { lanAddresses, type NetworkInterfaces } from './network.js';

describe('lanAddresses', () => {
  it('returns only external IPv4 addresses', () => {
    const interfaces: NetworkInterfaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      eth0: [
        { family: 'IPv4', address: '192.168.1.20', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      wlan0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }],
    };

    expect(lanAddresses(interfaces)).toEqual(['192.168.1.20', '10.0.0.5']);
  });

  it('skips interfaces with no address list', () => {
    expect(lanAddresses({ eth0: undefined })).toEqual([]);
  });

  it('returns an empty list when there is no network', () => {
    expect(lanAddresses({})).toEqual([]);
  });
});
