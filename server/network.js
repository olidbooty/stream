import { networkInterfaces } from 'node:os';

// Non-internal IPv4 addresses, i.e. the URLs other devices on the home network can use.
export function lanAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}
