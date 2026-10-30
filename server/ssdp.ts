import { createSocket, type RemoteInfo } from 'node:dgram';
import {
  CONNECTION_MANAGER,
  CONTENT_DIRECTORY,
  DESCRIPTION_PATH,
  DEVICE_TYPE,
  SERVER_HEADER,
} from './dlna.js';
import { interfaceFor, type LanInterface } from './network.js';

// Step 3.12: SSDP, how UPnP players such as VLC find the DLNA server
// (server/dlna.ts) without being told its address. They multicast an
// M-SEARCH to 239.255.255.250:1900 and the server answers with the address of
// its description; it also multicasts NOTIFY ssdp:alive when it starts and
// every few minutes, and ssdp:byebye when it stops. It only answers devices
// on the same network as one of the machine's LAN interfaces (Decision #33).

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;

// How long a player may keep the server listed without hearing from it.
const MAX_AGE = 1800;
// Announce well within MAX_AGE, so one lost packet doesn't drop the server.
const ANNOUNCE_INTERVAL_MS = 10 * 60 * 1000;
// UDP can lose a packet, so each announcement is sent twice.
const REPEAT = 2;
// The UPnP spec lets an answer wait up to MX seconds to spread replies out;
// VLC only waits 5, and this is one device, so answer within a second.
const MAX_REPLY_DELAY_MS = 1000;

// The search targets the server answers to, and announces itself as.
export function notificationTypes(uuid: string): string[] {
  return [
    'upnp:rootdevice',
    `uuid:${uuid}`,
    DEVICE_TYPE,
    CONTENT_DIRECTORY,
    CONNECTION_MANAGER,
  ];
}

export function usn(uuid: string, type: string): string {
  return type === `uuid:${uuid}` ? type : `uuid:${uuid}::${type}`;
}

function message(firstLine: string, headers: [string, string][]): string {
  return `${[firstLine, ...headers.map(([name, value]) => `${name}: ${value}`)].join('\r\n')}\r\n\r\n`;
}

export function searchResponse(
  uuid: string,
  type: string,
  location: string,
  date: Date,
): string {
  return message('HTTP/1.1 200 OK', [
    ['CACHE-CONTROL', `max-age=${MAX_AGE}`],
    ['DATE', date.toUTCString()],
    ['EXT', ''],
    ['LOCATION', location],
    ['SERVER', SERVER_HEADER],
    ['ST', type],
    ['USN', usn(uuid, type)],
  ]);
}

export function notify(
  uuid: string,
  type: string,
  alive: { location: string } | null,
): string {
  const host: [string, string] = ['HOST', `${SSDP_ADDRESS}:${SSDP_PORT}`];
  if (!alive) {
    return message('NOTIFY * HTTP/1.1', [
      host,
      ['NT', type],
      ['NTS', 'ssdp:byebye'],
      ['USN', usn(uuid, type)],
    ]);
  }
  return message('NOTIFY * HTTP/1.1', [
    host,
    ['CACHE-CONTROL', `max-age=${MAX_AGE}`],
    ['LOCATION', alive.location],
    ['NT', type],
    ['NTS', 'ssdp:alive'],
    ['SERVER', SERVER_HEADER],
    ['USN', usn(uuid, type)],
  ]);
}

export interface SearchRequest {
  target: string;
  // Seconds the searcher waits for answers.
  mx: number;
}

// An M-SEARCH, or null for anything else: other devices' NOTIFYs, answers,
// garbage.
export function parseSearch(text: string): SearchRequest | null {
  const [requestLine, ...lines] = text.split(/\r?\n/);
  if (!/^M-SEARCH \* HTTP\/1\.[01]$/i.test(requestLine.trim())) return null;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
    }
  }
  const target = headers.get('st');
  if (headers.get('man') !== '"ssdp:discover"' || !target) return null;
  const mx = Number(headers.get('mx'));
  return { target, mx: Number.isFinite(mx) && mx > 0 ? mx : 1 };
}

// The search targets to answer an M-SEARCH for: all of them for ssdp:all, the
// one asked for if it is ours, otherwise none.
export function searchMatches(uuid: string, target: string): string[] {
  const types = notificationTypes(uuid);
  if (target === 'ssdp:all') return types;
  return types.includes(target) ? [target] : [];
}

// The parts of a dgram socket SsdpServer uses, so tests can pass a fake.
export interface SsdpSocket {
  on(
    event: 'message',
    listener: (msg: Buffer, rinfo: RemoteInfo) => void,
  ): void;
  on(event: 'error', listener: (err: Error) => void): void;
  bind(port: number, callback: () => void): void;
  addMembership(group: string, iface: string): void;
  setMulticastInterface(iface: string): void;
  setMulticastTTL(ttl: number): void;
  send(
    msg: string,
    port: number,
    address: string,
    callback: (err: Error | null) => void,
  ): void;
  close(callback?: () => void): void;
}

export interface SsdpOptions {
  uuid: string;
  // The HTTP port the description is served on.
  port: number;
  // The interfaces to announce on and answer through; read again at each
  // announcement, so a network that comes up later is joined.
  interfaces: () => LanInterface[];
  createSocket?: () => SsdpSocket;
  random?: () => number;
  log?: (message: string) => void;
}

export class SsdpServer {
  private readonly options: Required<SsdpOptions>;
  private socket: SsdpSocket | undefined;
  private readonly joined = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly replies = new Set<ReturnType<typeof setTimeout>>();
  // Sends switch the multicast interface, so they go one at a time.
  private sending: Promise<void> = Promise.resolve();

  constructor(options: SsdpOptions) {
    this.options = {
      createSocket: () =>
        createSocket({ type: 'udp4', reuseAddr: true }) as SsdpSocket,
      random: Math.random,
      log: console.log,
      ...options,
    };
  }

  private location(iface: LanInterface): string {
    return `http://${iface.address}:${this.options.port}${DESCRIPTION_PATH}`;
  }

  // Binds the SSDP port and announces the server. Resolves false, after
  // logging why, if the port can't be used; the rest of the server runs on.
  start(): Promise<boolean> {
    const socket = this.options.createSocket();
    return new Promise((resolve) => {
      let bound = false;
      socket.on('error', (err) => {
        this.options.log(`DLNA off: SSDP socket failed: ${err.message}`);
        this.stopTimers();
        this.socket = undefined;
        socket.close();
        if (!bound) resolve(false);
      });
      socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      socket.bind(SSDP_PORT, () => {
        bound = true;
        this.socket = socket;
        // Stay on the home network.
        socket.setMulticastTTL(2);
        void this.announce();
        this.timer = setInterval(
          () => void this.announce(),
          ANNOUNCE_INTERVAL_MS,
        );
        this.timer.unref?.();
        resolve(true);
      });
    });
  }

  // Says goodbye on every interface and closes the socket.
  async stop(): Promise<void> {
    this.stopTimers();
    const socket = this.socket;
    if (!socket) return;
    await this.multicast(null);
    this.socket = undefined;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  private stopTimers(): void {
    clearInterval(this.timer);
    for (const reply of this.replies) clearTimeout(reply);
    this.replies.clear();
  }

  private join(): LanInterface[] {
    const interfaces = this.options.interfaces();
    for (const { address } of interfaces) {
      if (this.joined.has(address)) continue;
      try {
        this.socket?.addMembership(SSDP_ADDRESS, address);
        this.joined.add(address);
      } catch (err) {
        this.options.log(
          `DLNA: can't listen for searches on ${address}: ${(err as Error).message}`,
        );
      }
    }
    return interfaces;
  }

  private announce(): Promise<void> {
    const interfaces = this.join();
    let done = Promise.resolve();
    for (let i = 0; i < REPEAT; i++) {
      done = this.multicast({ interfaces });
    }
    return done;
  }

  // NOTIFY on each interface: alive with its own address, or byebye.
  private multicast(
    alive: { interfaces: LanInterface[] } | null,
  ): Promise<void> {
    const { uuid } = this.options;
    const interfaces = alive?.interfaces ?? this.options.interfaces();
    for (const iface of interfaces) {
      for (const type of notificationTypes(uuid)) {
        const text = notify(
          uuid,
          type,
          alive ? { location: this.location(iface) } : null,
        );
        this.queue(text, SSDP_PORT, SSDP_ADDRESS, iface.address);
      }
    }
    return this.sending;
  }

  private queue(
    text: string,
    port: number,
    address: string,
    multicastInterface?: string,
  ): void {
    this.sending = this.sending.then(
      () =>
        new Promise<void>((resolve) => {
          const socket = this.socket;
          if (!socket) return resolve();
          try {
            if (multicastInterface) {
              socket.setMulticastInterface(multicastInterface);
            }
            // A failed send (an interface gone) only loses that packet.
            socket.send(text, port, address, () => resolve());
          } catch {
            resolve();
          }
        }),
    );
  }

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    const search = parseSearch(msg.toString('utf8'));
    if (!search) return;
    // Only devices on one of our networks; this also picks the address to
    // give them.
    const iface = interfaceFor(this.options.interfaces(), rinfo.address);
    if (!iface) return;
    const matches = searchMatches(this.options.uuid, search.target);
    if (matches.length === 0) return;
    const delay =
      this.options.random() * Math.min(search.mx * 1000, MAX_REPLY_DELAY_MS);
    const reply = setTimeout(() => {
      this.replies.delete(reply);
      for (const type of matches) {
        this.queue(
          searchResponse(
            this.options.uuid,
            type,
            this.location(iface),
            new Date(),
          ),
          rinfo.port,
          rinfo.address,
        );
      }
    }, delay);
    this.replies.add(reply);
  }
}
