import { isIPv4 } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

// The fields lanAddresses reads; os.networkInterfaces() returns a superset.
export type NetworkInterfaces = Record<
  string,
  | Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal' | 'netmask'>[]
  | undefined
>;

export interface LanInterface {
  address: string;
  netmask: string;
}

// Non-internal IPv4 interfaces: the networks other devices at home are on.
export function lanInterfaces(
  interfaces: NetworkInterfaces = networkInterfaces(),
): LanInterface[] {
  return Object.values(interfaces)
    .flatMap((addresses) => addresses ?? [])
    .filter((iface) => iface.family === 'IPv4' && !iface.internal)
    .map(({ address, netmask }) => ({ address, netmask }));
}

// Non-internal IPv4 addresses, i.e. the URLs other devices on the home network can use.
export function lanAddresses(
  interfaces: NetworkInterfaces = networkInterfaces(),
): string[] {
  return lanInterfaces(interfaces).map((iface) => iface.address);
}

function ipv4Number(address: string): number {
  return address
    .split('.')
    .reduce((total, part) => total * 256 + Number(part), 0);
}

// The interface whose network an IPv4 address is on, e.g. the one a DLNA
// search from a TV arrived through. Undefined for anything else.
export function interfaceFor(
  interfaces: readonly LanInterface[],
  address: string,
): LanInterface | undefined {
  if (!isIPv4(address)) return undefined;
  const target = ipv4Number(address);
  return interfaces.find(({ address: own, netmask }) => {
    if (!isIPv4(netmask)) return false;
    const mask = ipv4Number(netmask);
    // Bitwise operators work on signed 32-bit numbers, so compare with >>> 0.
    return (target & mask) >>> 0 === (ipv4Number(own) & mask) >>> 0;
  });
}
