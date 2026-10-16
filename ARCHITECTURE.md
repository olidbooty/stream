# Architecture

How the pieces of `stream` fit together, and the WebTorrent constraints that
shape the remaining steps. For setup and scripts see [README.md](README.md);
for the plan see [PROJECT_MANAGEMENT.md](PROJECT_MANAGEMENT.md).

## Today

```
browser                                   Node (server/)
┌──────────────────────────────┐          ┌───────────────────────────┐
│ client/index.html            │  GET /   │ createApp() (Express 5)   │
│ client/src/main.ts (bundled  │ ───────▶ │ express.static(public/)   │
│ by Vite into public/assets/) │          │ 404 for everything else   │
└──────────────────────────────┘          └───────────────────────────┘
```

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

Checked against the installed `webtorrent@3`.

### Creating the client

```ts
import WebTorrent from 'webtorrent';
import wrtc from 'webrtc-polyfill';

const client = new WebTorrent({ tracker: { wrtc } });
```

- **DHT, TCP and uTP** are on by default. uTP uses the optional native
  `utp-native` package; if it fails to install, WebTorrent falls back to TCP
  only.
- **WebRTC** needs an implementation passed as `tracker.wrtc`.
  `webrtc-polyfill` (backed by `node-datachannel`, a native module) is
  already installed as a dependency of WebTorrent's own packages. Step 2.1
  should add it to `package.json` as a direct dependency rather than rely on
  that.
- `client.on('listening')` fires once it is bound; `client.address()` gives
  the peer port. Set it with the `torrentPort` and `dhtPort` options so it
  can be forwarded on the router. Without incoming connections the client
  still works, but finds fewer peers.
- Destroy the client on `SIGINT`/`SIGTERM` so it stops announcing and closes
  its sockets.

Pass the client into `createApp()` rather than creating it there, so tests
can hand in the fake (see [TESTING.md](TESTING.md#mocking-webtorrent)) and no
test opens a real port.

### Storage

In Node the default chunk store is `fs-chunk-store`, which writes the
torrent's files under `os.tmpdir()/webtorrent`. Set the `path` option on
`client.add()` to a configurable download directory, and decide how and when
finished torrents are removed (Decision #4).

### Streaming

`file.createReadStream({ start, end })` returns a stream for a byte range and
prioritises the pieces it covers. Serve it from an Express route that:

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

## Decisions

These live in the Risks & Decisions tab of the
[project tracker](PROJECT_MANAGEMENT.md#where-things-live). When one is
decided, update the tab and summarise the outcome here, so the reason for the
design stays next to the code.

| # | Decision | Status | Outcome |
| - | -------- | ------ | ------- |
| 1 | Browser-side WebTorrent vs. a Node-side client streaming over HTTP | Decided | Node-side, so TCP, uTP and DHT peers are reachable as well as WebRTC. See [Why not in the browser](#why-not-in-the-browser) |
| 2 | Whether explicit sequential piece selection is needed | Open | `createReadStream` already prioritises the requested range; verify while seeking in 3.2 |
| 3 | Whether to list `.mkv` and similar with a warning | Open | |
| 4 | Chunk store / storage strategy | Open | Now a disk question: download directory, size limit and cleanup |
| 5 | Run the codec audit (4.1) early on test files | Open | |
