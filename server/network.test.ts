import { describe, expect, it } from 'vitest';
import {
  interfaceFor,
  lanAddresses,
  lanInterfaces,
  type NetworkInterfaces,
} from './network.js';

const interfaces: NetworkInterfaces = {
  lo: [
    {
      family: 'IPv4',
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      internal: true,
    },
  ],
  eth0: [
    {
      family: 'IPv4',
      address: '192.168.1.20',
      netmask: '255.255.255.0',
      internal: false,
    },
    {
      family: 'IPv6',
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      internal: false,
    },
  ],
  wlan0: [
    {
      family: 'IPv4',
      address: '10.0.0.5',
      netmask: '255.0.0.0',
      internal: false,
    },
  ],
};

describe('lanAddresses', () => {
  it('returns only external IPv4 addresses', () => {
    expect(lanAddresses(interfaces)).toEqual(['192.168.1.20', '10.0.0.5']);
  });

  it('skips interfaces with no address list', () => {
    expect(lanAddresses({ eth0: undefined })).toEqual([]);
  });

  it('returns an empty list when there is no network', () => {
    expect(lanAddresses({})).toEqual([]);
  });
});

describe('interfaceFor', () => {
  const lan = lanInterfaces(interfaces);

  it('finds the interface on the same network as an address', () => {
    expect(interfaceFor(lan, '192.168.1.57')?.address).toBe('192.168.1.20');
    expect(interfaceFor(lan, '10.200.3.4')?.address).toBe('10.0.0.5');
  });

  it('finds none for another network, loopback or IPv6', () => {
    expect(interfaceFor(lan, '192.168.2.57')).toBeUndefined();
    expect(interfaceFor(lan, '8.8.8.8')).toBeUndefined();
    expect(interfaceFor(lan, '127.0.0.1')).toBeUndefined();
    expect(interfaceFor(lan, 'fe80::2')).toBeUndefined();
  });

  it('handles addresses above 128.0.0.0 and a /32', () => {
    expect(
      interfaceFor(
        [{ address: '203.0.113.9', netmask: '255.255.255.255' }],
        '203.0.113.9',
      )?.address,
    ).toBe('203.0.113.9');
  });
});
