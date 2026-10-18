import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

// The fields lanAddresses reads; os.networkInterfaces() returns a superset.
export type NetworkInterfaces = Record<
  string,
  Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] | undefined
>;

// Non-internal IPv4 addresses, i.e. the URLs other devices on the home network can use.
export function lanAddresses(
  interfaces: NetworkInterfaces = networkInterfaces(),
): string[] {
  return Object.values(interfaces)
    .flatMap((addresses) => addresses ?? [])
    .filter((iface) => iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}
