# Architecture

How the pieces of `stream` fit together, and the WebTorrent constraints that
shape the remaining steps. For setup and scripts see [README.md](README.md);
for the plan see [PROJECT_MANAGEMENT.md](PROJECT_MANAGEMENT.md).

## Today

```
browser                                   Node (server/)
┌──────────────────────────────┐          ┌───────────────────────────────┐
│ client/index.html            │  GET /   │ createApp({ client })         │
│ client/src/main.ts (bundled  │ ───────▶ │   express.static(public/)     │
│ by Vite into public/assets/) │          │   GET /api/client (status)    │
└──────────────────────────────┘          │   404 for everything else     │
                                          │ WebTorrent client (index.ts)  │
                                          │   TCP, uTP, DHT, WebRTC       │
                                          └───────────────────────────────┘
```

`server/index.ts` creates the client with `createTorrentClient()` from
`server/torrent-client.ts` and passes it to `createApp()`. There are no
torrent routes yet; `addTorrent()` and `removeTorrent()` in the same module
apply Decision #4 and are what 2.2's routes will call.

## Target design

The torrent client runs **in the Node server**, not in the browser
(Decision #1, below). The browser is a UI and a `<video>` element; it never
talks to peers itself.

```
any device on the LAN                     Node server
┌─────────────────────────────┐           ┌──────────────────────────────────────┐
│ UI: magnet / .torrent form  │ ── API ─▶ │ Express routes under /api            │
│ status view                 │ ◀─ SSE ── │   │                                  │
│ <video src=".../stream">    │ ◀ Range ─ │ WebTorrent client ◀─▶ peers:         │
└─────────────────────────────┘   (HTTP)  │   chunk store on disk   TCP, uTP,    │
                                          │                         DHT, WebRTC  │
                                          └──────────────────────────────────────┘
```

- **Peers.** The Node client connects over TCP and uTP, finds peers through
  the DHT, UDP/HTTP trackers and local service discovery, and also over WebRTC
  when it is given an implementation. So it joins ordinary BitTorrent swarms
  and WebTorrent (browser) swarms alike.
- **Streaming.** The browser plays a plain HTTP URL. The server answers
  `Range` requests with `file.createReadStream({ start, end })`, which also
  makes WebTorrent fetch the pieces for that range first.
- **Status.** Speed, peers and progress are pushed to the browser with
  server-sent events.
- **Torrent state lives on the server**, so every device on the LAN sees the
  same torrents.

### Why not in the browser

A browser client can only reach WebRTC peers through `wss://` trackers: no
TCP, uTP or DHT. Most public torrents have no WebRTC seeders, so they would
show zero peers. Running the client in Node removes that limit and some
other browser-only problems:

| Problem in the browser | On the server |
| ---------------------- | ------------- |
| Only WebRTC peers | TCP, uTP, DHT and WebRTC |
| Vite leaves out the Node built-ins `events` and `path` that WebTorrent needs; the bundle breaks at runtime | WebTorrent runs as a normal Node package; nothing to bundle |
| `file.streamTo` needs a service worker, and service workers need HTTPS on LAN URLs | `<video>` plays a plain HTTP URL from any device |
| Storage limited to browser quota or memory | Chunk store on disk |
| Codec fixes only via FFmpeg.wasm | Native `ffmpeg` can be used later (4.4) |

The costs: the server needs disk space and an open port for incoming peers,
and it uploads to the swarm while it has a torrent (see [Seeding](#seeding)).

## WebTorrent in Node

Checked against the installed `webtorrent@3.0.21`. `server/torrent-client.ts`
implements this.

### Creating the client

```ts
import WebTorrent from 'webtorrent';
import wrtc from 'webrtc-polyfill';

const client = new WebTorrent({ torrentPort, dhtPort, tracker: { wrtc } });
```

- **DHT, TCP and uTP** are on by default. uTP uses the optional native
  `utp-native` package; if it fails to install, WebTorrent falls back to TCP
  only.
- **WebRTC** uses `webrtc-polyfill` (backed by `node-datachannel`, a native
  module). In `webtorrent@3` its peer library, `@thaunknown/simple-peer`,
  already imports the polyfill, so WebRTC works even without `tracker.wrtc`.
  We still pass it and list `webrtc-polyfill` in `package.json`, so WebRTC
  doesn't rely on another package's import.
- `client.on('listening')` fires once it is bound; `client.address()` gives
  the peer port. Set it with `TORRENT_PORT` and `DHT_PORT` (both default to
  `0`, a random port) so it can be forwarded on the router. Without incoming
  connections the client still works, but finds fewer peers.
- The peer port binds to `0.0.0.0` whatever `HOST` says. `HOST` only
  restricts the HTTP port (Risks & Decisions #8).
- **UPnP and NAT-PMP are on by default**: once listening, the client asks the
  router to forward the peer port, without any setting from us. Whether to
  keep that is open until 2.6 (Risks & Decisions #7).
- A peer port that is already in use makes the constructor emit `error`;
  `server/index.ts` logs it and exits with status 1.
- A torrent's own errors (a bad store, invalid metadata) are re-emitted on
  the client when the torrent has no `error` listener, which would stop the
  server. `addTorrent()` always adds one, so a failing torrent only logs.
- Destroy the client on `SIGINT`/`SIGTERM` so it stops announcing and closes
  its sockets. `server/index.ts` does this; a second signal exits at once.
- `client.get()` and `client.remove()` are async. `remove()` rejects for an
  unknown torrent but reports the destroy itself through its callback, so
  `removeTorrent()` waits for both.

Pass the client into `createApp()` rather than creating it there, so tests
can hand in the fake (see [TESTING.md](TESTING.md#mocking-webtorrent)) and no
test opens a real port.

### Storage

In Node the default chunk store is `fs-chunk-store`, which writes the
torrent's files under `os.tmpdir()/webtorrent`. Decision #4 keeps that store
but moves it:

- `ensureDownloadDir()` creates the directory at startup and checks it is
  writable, so a bad `DOWNLOAD_DIR` fails before any torrent is added.
- Downloads go in the directory set by `DOWNLOAD_DIR` (default `./downloads`
  in the repo, gitignored; a relative value resolves against the working
  directory), passed as the `path` option to `client.add()` by `addTorrent()`.
- Removing a torrent deletes its files: `addTorrent()` sets
  `destroyStoreOnDestroy: true` and `removeTorrent()` passes
  `destroyStore: true`.
- A limit on the directory's total size comes in 4.3.

### Streaming

`file.createReadStream({ start, end })` returns a stream for a byte range and
prioritises the pieces it covers. The torrent's piece strategy already defaults
to `sequential` in `webtorrent@3`, so no custom piece selection is needed
(Decision #2); 3.3 checks this while seeking. Serve it from an Express route that:

- parses the `Range` header and responds `206` with `Content-Range`, or `416`
  for a range outside the file
- sets `Accept-Ranges: bytes`, `Content-Length` and a `Content-Type` from
  the file extension
- destroys the read stream when the request closes, so seeking doesn't leave
  old streams running

WebTorrent also has `client.createServer()`, which serves files over HTTP on
its own port. Prefer the Express route: one port, our own 404s, and it can be
tested with supertest.

### Seeding

While a torrent is in the client, it uploads pieces to other peers. That is
how BitTorrent works, but it means the server distributes whatever it
downloads. Only use content you have the right to share, and remove torrents
when they're no longer being watched.

### Network exposure

The server binds to `0.0.0.0`, so anyone on the LAN can add torrents and
fill the disk. That is acceptable for a home network; set `HOST=127.0.0.1`
to keep it to one machine. Never expose the HTTP port to the internet. Only
the peer port should be forwarded.

The peer port (`TORRENT_PORT`, TCP and uTP) and `DHT_PORT` always listen on
all interfaces, and with UPnP/NAT-PMP on, WebTorrent may forward the peer port
on the router by itself (Decisions #7 and #8).

## Decisions

These live in the Risks & Decisions tab of the
[project tracker](PROJECT_MANAGEMENT.md#where-things-live). When one is
decided, update the tab and summarise the outcome here, so the reason for the
design stays next to the code.

| # | Decision | Status | Outcome |
| - | -------- | ------ | ------- |
| 1 | Browser-side WebTorrent vs. a Node-side client streaming over HTTP | Decided | Node-side, so TCP, uTP and DHT peers are reachable as well as WebRTC. See [Why not in the browser](#why-not-in-the-browser) |
| 2 | Whether explicit sequential piece selection is needed | Decided | No. `webtorrent@3` defaults to the `sequential` strategy and `createReadStream` fetches the requested range first. 3.3 checks seeking and reopens this only if playback stalls |
| 3 | Whether to list `.mkv` and similar with a warning | Decided | Yes. 3.1 lists `.mkv`, `.avi`, `.mov` and other video files marked "may not play" next to `.mp4`/`.webm`. 4.2 shows the real playback error; 4.4 can remux |
| 4 | Chunk store / storage strategy | Decided | Default `fs-chunk-store` in `DOWNLOAD_DIR` (default `./downloads`). Removing a torrent deletes its files; 4.3 adds a size limit. See [Storage](#storage) |
| 5 | Run the codec audit (4.1) early on test files | Decided | Yes. 4.1 now depends on 2.3 instead of 3.1, so test files are checked with `ffprobe` before playback work and 3.1's filter can use the results |
| 6 | Test environment limits | Decided | Unit tests use the shared fake and never join a real swarm; real peers and playback are checked by hand ([TESTING.md](TESTING.md#manual-testing)) until 4.5 |
| 7 | Keep WebTorrent's automatic UPnP/NAT-PMP port mapping? | Open | On by default since 2.1: the router is asked to forward the peer port. Decide in 2.6 |
| 8 | Peer port listens on all interfaces | Decided | Accepted. Peers must reach it, so `HOST` only limits the HTTP port. See [Network exposure](#network-exposure) |
| 9 | 2.1 not yet checked against a real swarm | Open | Startup, `/api/client` and shutdown were checked; joining TCP/uTP, DHT and WebRTC swarms needs a manual check before 2.6 |
| 10 | Native modules without prebuilt binaries | Open | `utp-native` has no Linux ARM build (falls back to TCP); `node-datachannel` downloads its binary at install or builds with CMake. Matters for a Raspberry Pi host |
