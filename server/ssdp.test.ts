import type { RemoteInfo } from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notify,
  parseSearch,
  SSDP_ADDRESS,
  SsdpServer,
  type SsdpSocket,
  searchMatches,
  searchResponse,
} from './ssdp.js';

const UUID = '4f7ad604-67ef-5958-a706-c60b14eadd08';
const DEVICE = 'urn:schemas-upnp-org:device:MediaServer:1';

function mSearch(target: string, mx = '2', man = '"ssdp:discover"'): string {
  return `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: ${man}\r\nMX: ${mx}\r\nST: ${target}\r\n\r\n`;
}

describe('parseSearch', () => {
  it('reads the target and MX of an M-SEARCH', () => {
    expect(parseSearch(mSearch(DEVICE))).toEqual({ target: DEVICE, mx: 2 });
    expect(parseSearch(mSearch('ssdp:all', 'x'))).toEqual({
      target: 'ssdp:all',
      mx: 1,
    });
  });

  it('ignores anything else', () => {
    expect(parseSearch(mSearch(DEVICE, '1', 'ssdp:discover'))).toBeNull();
    expect(parseSearch('NOTIFY * HTTP/1.1\r\nNT: x\r\n\r\n')).toBeNull();
    expect(parseSearch('M-SEARCH * HTTP/1.1\r\n\r\n')).toBeNull();
    expect(parseSearch('garbage')).toBeNull();
  });
});

describe('searchMatches', () => {
  it('answers ssdp:all with everything and a known target with itself', () => {
    expect(searchMatches(UUID, 'ssdp:all')).toEqual([
      'upnp:rootdevice',
      `uuid:${UUID}`,
      DEVICE,
      'urn:schemas-upnp-org:service:ContentDirectory:1',
      'urn:schemas-upnp-org:service:ConnectionManager:1',
    ]);
    expect(searchMatches(UUID, DEVICE)).toEqual([DEVICE]);
    expect(searchMatches(UUID, `uuid:${UUID}`)).toEqual([`uuid:${UUID}`]);
  });

  it('ignores other devices and versions', () => {
    expect(
      searchMatches(UUID, 'urn:schemas-upnp-org:device:MediaRenderer:1'),
    ).toEqual([]);
    expect(
      searchMatches(UUID, 'urn:schemas-upnp-org:device:MediaServer:2'),
    ).toEqual([]);
    expect(searchMatches(UUID, 'uuid:someone-else')).toEqual([]);
  });
});

describe('messages', () => {
  it('answers a search with the description address', () => {
    expect(
      searchResponse(
        UUID,
        'upnp:rootdevice',
        'http://192.168.1.20:1234/dlna/device.xml',
        new Date(Date.UTC(2026, 9, 30, 19, 0, 0)),
      ),
    ).toMatch(
      new RegExp(
        '^HTTP/1\\.1 200 OK\\r\\n' +
          'CACHE-CONTROL: max-age=1800\\r\\n' +
          'DATE: Fri, 30 Oct 2026 19:00:00 GMT\\r\\n' +
          'EXT: \\r\\n' +
          'LOCATION: http://192\\.168\\.1\\.20:1234/dlna/device\\.xml\\r\\n' +
          'SERVER: Node\\.js/[^ ]+ UPnP/1\\.0 stream/0\\.1\\r\\n' +
          'ST: upnp:rootdevice\\r\\n' +
          `USN: uuid:${UUID}::upnp:rootdevice\\r\\n\\r\\n$`,
      ),
    );
  });

  it('says alive with a location and byebye without', () => {
    const alive = notify(UUID, `uuid:${UUID}`, {
      location: 'http://192.168.1.20:1234/dlna/device.xml',
    });
    const byebye = notify(UUID, DEVICE, null);

    expect(alive).toContain('NTS: ssdp:alive\r\n');
    expect(alive).toContain(`USN: uuid:${UUID}\r\n`);
    expect(alive).toContain('LOCATION: http://192.168.1.20:1234/');
    expect(byebye).toBe(
      'NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n' +
        `NT: ${DEVICE}\r\nNTS: ssdp:byebye\r\nUSN: uuid:${UUID}::${DEVICE}\r\n\r\n`,
    );
  });
});

interface Sent {
  text: string;
  port: number;
  address: string;
  // The multicast interface set when it was sent.
  via: string | undefined;
}

class FakeSocket implements SsdpSocket {
  sent: Sent[] = [];
  memberships: string[] = [];
  closed = false;
  failBind: Error | undefined;
  private via: string | undefined;
  private listeners: {
    message?: (msg: Buffer, rinfo: RemoteInfo) => void;
    error?: (err: Error) => void;
  } = {};

  on(event: 'message' | 'error', listener: never): void {
    this.listeners[event] = listener;
  }
  bind(_port: number, callback: () => void): void {
    if (this.failBind) {
      const err = this.failBind;
      queueMicrotask(() => this.listeners.error?.(err));
    } else {
      queueMicrotask(callback);
    }
  }
  addMembership(group: string, iface: string): void {
    this.memberships.push(`${group}@${iface}`);
  }
  setMulticastInterface(iface: string): void {
    this.via = iface;
  }
  setMulticastTTL(): void {}
  send(
    text: string,
    port: number,
    address: string,
    callback: (err: Error | null) => void,
  ): void {
    this.sent.push({ text, port, address, via: this.via });
    queueMicrotask(() => callback(null));
  }
  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }
  receive(text: string, address: string, port = 50000): void {
    this.listeners.message?.(Buffer.from(text), {
      address,
      port,
      family: 'IPv4',
      size: text.length,
    });
  }
}

describe('SsdpServer', () => {
  let socket: FakeSocket;
  let log: ReturnType<typeof vi.fn<(message: string) => void>>;
  let interfaces = [
    { address: '192.168.1.20', netmask: '255.255.255.0' },
    { address: '10.0.0.5', netmask: '255.0.0.0' },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    log = vi.fn();
    interfaces = [
      { address: '192.168.1.20', netmask: '255.255.255.0' },
      { address: '10.0.0.5', netmask: '255.0.0.0' },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function server(): SsdpServer {
    return new SsdpServer({
      uuid: UUID,
      port: 1234,
      interfaces: () => interfaces,
      createSocket: () => socket,
      random: () => 0.5,
      log,
    });
  }

  // Lets the queued sends, which wait on each other's callbacks, finish.
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('joins the SSDP group and announces itself twice on each interface', async () => {
    const ssdp = server();

    expect(await ssdp.start()).toBe(true);
    await flush();

    expect(socket.memberships).toEqual([
      `${SSDP_ADDRESS}@192.168.1.20`,
      `${SSDP_ADDRESS}@10.0.0.5`,
    ]);
    // Five notification types, two interfaces, twice.
    expect(socket.sent).toHaveLength(20);
    for (const { text, address, port, via } of socket.sent) {
      expect(address).toBe(SSDP_ADDRESS);
      expect(port).toBe(1900);
      expect(text).toContain('NTS: ssdp:alive');
      expect(text).toContain(`LOCATION: http://${via}:1234/dlna/device.xml`);
    }
  });

  it('announces again every 10 minutes, joining new interfaces', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    socket.sent = [];
    interfaces = [
      ...interfaces,
      { address: '172.16.0.2', netmask: '255.240.0.0' },
    ];

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(socket.memberships).toContain(`${SSDP_ADDRESS}@172.16.0.2`);
    expect(socket.sent).toHaveLength(30);
  });

  it('answers a search from its network after a short delay', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    socket.sent = [];

    socket.receive(mSearch(DEVICE), '10.1.2.3', 50123);
    await vi.advanceTimersByTimeAsync(499);
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(socket.sent).toEqual([
      expect.objectContaining({ address: '10.1.2.3', port: 50123 }),
    ]);
    expect(socket.sent[0].text).toContain(`ST: ${DEVICE}\r\n`);
    // The address on the searcher's network, not the first one.
    expect(socket.sent[0].text).toContain(
      'LOCATION: http://10.0.0.5:1234/dlna/device.xml',
    );
  });

  it('answers ssdp:all with every type', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    socket.sent = [];

    socket.receive(mSearch('ssdp:all'), '192.168.1.57');
    await vi.advanceTimersByTimeAsync(1000);

    expect(socket.sent).toHaveLength(5);
  });

  it('ignores searches from other networks and for other devices', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    socket.sent = [];

    socket.receive(mSearch(DEVICE), '203.0.113.9');
    socket.receive(mSearch(DEVICE), '127.0.0.1');
    socket.receive(
      mSearch('urn:schemas-upnp-org:device:MediaRenderer:1'),
      '192.168.1.57',
    );
    socket.receive(notify('other', 'upnp:rootdevice', null), '192.168.1.57');
    await vi.advanceTimersByTimeAsync(2000);

    expect(socket.sent).toHaveLength(0);
  });

  it('says byebye on each interface and closes when stopped', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    socket.sent = [];
    socket.receive(mSearch(DEVICE), '192.168.1.57');

    const stopped = ssdp.stop();
    await flush();
    await stopped;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(socket.sent).toHaveLength(10);
    for (const { text } of socket.sent) {
      expect(text).toContain('NTS: ssdp:byebye');
    }
    expect(socket.closed).toBe(true);
  });

  it('starts again after a stop, joining the group on the new socket', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    const first = socket;
    await ssdp.stop();
    socket = new FakeSocket();

    expect(await ssdp.start()).toBe(true);
    await flush();

    expect(first.closed).toBe(true);
    expect(socket.memberships).toHaveLength(2);
    expect(socket.sent[0].text).toContain('NTS: ssdp:alive');
  });

  it('does nothing when started twice', async () => {
    const ssdp = server();
    await ssdp.start();
    await flush();
    const sent = socket.sent.length;

    expect(await ssdp.start()).toBe(true);
    await flush();

    expect(socket.sent).toHaveLength(sent);
  });

  it('logs and carries on without DLNA when the port fails', async () => {
    socket.failBind = Object.assign(new Error('bind EACCES 0.0.0.0:1900'), {
      code: 'EACCES',
    });
    const ssdp = server();

    expect(await ssdp.start()).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'DLNA off: SSDP socket failed: bind EACCES 0.0.0.0:1900',
    );
    expect(socket.closed).toBe(true);
    await ssdp.stop();
  });
});
