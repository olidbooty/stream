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
└──────────────────────────────┘          │   /api/torrents (add, list,   │
                                          │     remove)                   │
                                          │   /api/torrents/events (SSE)  │
                                          │   .../files/:index/stream     │
                                          │     (HTTP Range)              │
                                          │   404 for everything else     │
                                          │ WebTorrent client (index.ts)  │
                                          │   TCP, uTP, DHT, WebRTC       │
                                          └───────────────────────────────┘
```

`server/index.ts` creates the client with `createTorrentClient()` from
`server/torrent-client.ts` and passes it to `createApp()`. The routes in
`server/torrents-api.ts` add torrents with `addTorrent()` and remove them with
`removeTorrent()`, which apply Decision #4. The API is listed in the
[README](README.md#api).

### Adding torrents safely

`client.add()` accepts far more than magnet links and `.torrent` files: a
string it can't parse is fetched as an HTTP(S) URL or read as a **file path on
the server**. So the API never passes user input straight to it:

1. A magnet link must pass `isMagnetURI()` (`server/magnet.ts`): `magnet:?`
   with a v1 `urn:btih:` info hash, at most 8 KiB.
2. Magnets and uploaded `.torrent` files are parsed with `parse-torrent`, which
   gives the info hash and rejects bad files with `400`.
3. The *parsed* object is passed to `addTorrent()`, so WebTorrent doesn't
   re-interpret the input.

The info hash is checked against `client.torrents` first, so adding a torrent
twice returns `409` instead of WebTorrent's asynchronous "Cannot add duplicate
torrent" error. Two requests for the same new torrent at the same instant can
both pass that check; WebTorrent then destroys one of them (not always the
later one) and logs it, and the other keeps running.

Uploads are the raw request body with `Content-Type: application/x-bittorrent`
rather than multipart form data, so no upload library is needed; the browser
can `fetch()` a `File` directly. The body is capped at 10 MiB, about the size
of a 100 GB torrent's file with 256 KiB pieces.

Not supported: v2-only (`urn:btmh:`) magnets, which `parse-torrent` can't give
an info hash for, and `.torrent` URLs, which would make the server fetch
arbitrary URLs.

### Metadata

`GET /api/torrents/:infoHash` reports a torrent's files once WebTorrent has
its metadata (the info dictionary): straight away for a `.torrent` upload,
and from peers for a magnet link. Until then it answers `200` with
`hasMetadata: false` and `files`/`length` set to `null`, a normal state
rather than an error.

`hasMetadata` checks `torrent.metadata`, which is set when the metadata
arrives. `torrent.ready` comes later: WebTorrent first verifies any data
already on disk, which for a large, partly downloaded torrent can take a
while. Both are reported; the file list doesn't wait for `ready`.

A magnet link whose swarm has no peers stays pending indefinitely; nothing
times out, but its state turns to `noPeers` (Decision #15, see
[State and events](#state-and-events)). File `index` is the torrent's own file order, so
later steps (3.1, 3.2) can address a file by it. File `path`s are relative to
`DOWNLOAD_DIR`; `parse-torrent` normalises them, so `..` and absolute paths
in a hostile `.torrent` can't place files outside it (Decision #16).

### Choosing the media file

Once the file list is known, `selectMedia()` in `server/media.ts` classifies
each file and picks the one to play. It is a pure function of the file list
(`index`, `name`, `path`, `length`), so it is unit-tested on its own.

- **Classification is by extension only**, ignoring case. `.mp4`, `.m4v` and
  `.webm` are `video`: every current browser plays them with common codecs.
  `.mkv`, `.avi`, `.mov`, `.ogv` and other video containers are
  `video-may-not-play` and still listed (Decision #3): Chrome often plays
  `.mkv` with H.264 or VP9, and 4.2 will show the real error when it doesn't.
  `.ogv` is in this group because Safari has never played Ogg and Chrome has
  deprecated Theora. `.srt` and `.vtt` are flagged as `subtitle` for 3.4.
  The full list is in the [README](README.md#api).
- **No codec checks yet.** The 4.1 audit (Decision #5) was meant to inform
  this filter but hasn't run: it needs `ffprobe` and real files. So an
  `.mp4` holding HEVC or AC-3 audio is still reported as `video`. Codec-level
  checks come with 4.1 and 4.2 (Decision #17).
- **Samples.** A video with the word `sample` or `samples` in its path that
  is under a quarter of the size of the largest video is a `sample`. The
  size check keeps a film called "The Sample" from being skipped, and a
  torrent whose only video is a sample still plays it.
- **Main-sized videos** are those at least a third of the size of the
  largest video: both parts of a CD1/CD2 film, every episode of a season
  (even next to a double-length finale), or two encodes of the same film.
  Trailers and most extras are smaller.
- **`mainFile`** is the first main-sized video in path order that should
  play, or else the first one that may not. So a film's `.mp4` encode wins
  over its larger `.mkv`, a season starts at episode 1, and a short `.mp4`
  trailer never beats a full-length `.mkv`.
- **`videos`** lists every video: main-sized ones, then smaller ones, then
  samples, each group in path order. Paths compare numerically
  (`Episode 2` before `Episode 10`) with a fixed locale.

These heuristics haven't been tried on real torrents yet (Decision #19).

For now the choice doesn't change what is downloaded: WebTorrent still
fetches every file in the torrent, including samples, extras and other
encodes. 3.3 will download only the chosen video and its subtitles, and work
out progress and `seeding` over that selection (Decisions #18 and #23).

### State and events

Every torrent summary carries a `state`, worked out by `torrentState()` in
`server/torrent-state.ts` from the torrent's fields each time it is read, so
`GET /api/torrents`, `GET /api/torrents/:infoHash` and the event stream always
agree:

| State | When |
| ----- | ---- |
| `error` | WebTorrent hit an error and destroyed the torrent |
| `seeding` | `torrent.done`: every file is on disk. It keeps uploading while it is in the client, peers or not |
| `noPeers` | No peer connected, and WebTorrent's `noPeers` check has fired since the last one did |
| `connecting` | Looking for peers, fetching a magnet link's metadata from them, or checking data already on disk |
| `downloading` | Metadata known and at least one peer connected |

WebTorrent only reports two of these through events, so `TorrentWatch`
remembers them:

- **`noPeers`.** Every 30 seconds WebTorrent emits `noPeers` once for each
  discovery source (`tracker`, `dht`, `lsd`, `ut_pex`) that has found no
  peers. LSD and PEX find none for almost every torrent, so the event alone
  says little; the state only counts it while `numPeers` (connected wires) is
  0, and a `wire` event clears it. A new torrent therefore shows `connecting`
  for about 30 seconds before `noPeers`.
- **Errors.** A torrent error destroys the torrent (deleting its files, since
  `destroyStoreOnDestroy` is set) and removes it from `client.torrents` before
  `error` is emitted, so it would simply vanish. `TorrentWatch` keeps its last
  summary with `state: 'error'` and `errorMessage` until it is deleted
  (`DELETE` answers `204`) or the same torrent is added again, which is how
  the user retries. At most 50 are kept. It ignores the error WebTorrent gives
  the duplicate when one torrent is added twice at once. `addTorrent()` still
  attaches its own logging `error` listener, so torrent errors never reach the
  client's fatal handler.

`GET /api/torrents/events` is a [server-sent events][sse] stream of the same
list as `GET /api/torrents`, as `torrents` events. `EventStream`
(`server/event-stream.ts`) sends it on connect, then checks once a second and
sends it again only if it changed. While anything transfers, speeds change
every second, so an active swarm still updates each second; an idle list costs
nothing but a `: keep-alive` comment every 15 seconds, which stops proxies and
browsers from dropping a quiet stream. One timer serves every connection and
runs only while one is open. It reads the list rather than listening to
torrents, so removing a torrent leaves no listeners behind, and a client whose
socket buffer is full is skipped until it drains, then gets the latest list.
`server.closeAllConnections()` in `server/index.ts` ends open streams on
shutdown.

[sse]: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events

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
  router to forward the peer port, without any setting from us. Decision #7
  turns them off unless `PORT_MAPPING=1` is set; 2.6 implements it.
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

`GET /api/torrents/:infoHash/files/:index/stream` serves one file of a torrent
(`streamFile()` in `server/file-stream.ts`). `file.createReadStream({ start,
end })` returns a stream for a byte range and prioritises the pieces it
covers, so a `<video>` can start and seek long before the download is done.
The torrent's piece strategy already defaults to `sequential` in
`webtorrent@3`, so no custom piece selection is needed (Decision #2); 3.3
checks this while seeking.

- **Ranges.** Express's `req.range()` parses the header. One byte range gets
  `206` with `Content-Range`; a range past the end gets `416` with
  `Content-Range: bytes */<size>`. No `Range` header, a malformed one, another
  unit or several ranges get the whole file with `200`, as HTTP allows; browsers
  ask for one range at a time. Every response has `Accept-Ranges: bytes` and
  `Content-Length`. A `HEAD` request or an empty file never opens a stream, so
  WebTorrent isn't asked for pieces nobody reads.
- **When it can stream.** As soon as the metadata is in (`409` before that,
  and for a failed torrent). It doesn't wait for `ready`: WebTorrent accepts
  selections while it verifies data already on disk, and the stream yields
  each piece once it is verified or downloaded.
- **Content type.** The file's own `type` (WebTorrent looks it up from the
  extension), but only for `video/*`, `audio/*` and `text/vtt`. Anything else
  is sent as `application/octet-stream` with `Content-Disposition: attachment`,
  and every response has `X-Content-Type-Options: nosniff`. Otherwise an
  `.html` or `.svg` file in a torrent would run script on our origin, where it
  could call the API.
- **Closing streams.** Each seek in a `<video>` aborts one request and starts
  another, and a stream left running keeps its pieces prioritised. The route
  copies the stream by hand rather than with `stream.pipeline()`, because
  `pipeline()` doesn't destroy WebTorrent's streams (they are `streamx`
  streams, not Node ones) when the response closes. It destroys the stream
  when the response closes, writes no more than the range (WebTorrent reads
  `end: 0` as "to the end of the file", so `bytes=0-0` would otherwise get the
  whole file), and drops the connection if the stream stops short, for
  example when the torrent is removed mid-stream, so the browser sees an error
  rather than a body that is silently cut short.

WebTorrent also has `client.createServer()`, which serves files over HTTP on
its own port. The Express route is used instead: one port, our own 404s, and
it can be tested with supertest.

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

`/api/torrents` has no authentication (Decision #12). A torrent also makes
the server contact hosts its adder chose: trackers (`tr=`, `announce`), web
seeds (`ws=`, `url-list`) and a magnet's `xs=` URL, which WebTorrent fetches
over HTTP to get metadata. Someone on the LAN could use that to make the
server send requests to other hosts, including ones on the LAN
(Decision #11).

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
| 7 | Keep WebTorrent's automatic UPnP/NAT-PMP port mapping? | Decided | Off by default: the client gets `natUpnp: false` and `natPmp: false`, and `PORT_MAPPING=1` turns both on. No silent router changes; users forward `TORRENT_PORT` by hand, documented in the README. Implemented in 2.6 |
| 8 | Peer port listens on all interfaces | Decided | Accepted. Peers must reach it, so `HOST` only limits the HTTP port. See [Network exposure](#network-exposure) |
| 9 | 2.1 not yet checked against a real swarm | Open | Startup, `/api/client` and shutdown were checked; joining TCP/uTP, DHT and WebRTC swarms needs a manual check before 2.6 |
| 10 | Native modules without prebuilt binaries | Decided | Support Linux x64, macOS, Windows and Raspberry Pi. 2.6 adds a startup check: without `utp-native` the client logs that it is TCP-only; if `node-datachannel` fails to load it runs without WebRTC instead of crashing. The README lists the build tools needed on ARM |
| 11 | Torrents make the server contact hosts the adder chose | Decided | Strip a magnet's `xs=` URL before `client.add()`. Drop tracker and web seed URLs that aren't http(s)/udp/wss or whose host is localhost or a literal loopback, private, link-local or unspecified IP. Hostnames that resolve to LAN addresses still pass. Implemented in 2.6, before 2.5. See [Network exposure](#network-exposure) |
| 12 | No authentication on the torrent API | Decided | Accepted for a home LAN, as in [Network exposure](#network-exposure). Anyone on the LAN can add and remove torrents; 4.3 limits disk use |
| 13 | Torrent list is in memory only | Decided | Restore on startup: save each torrent to `DOWNLOAD_DIR/.torrents/<infoHash>.torrent` (the magnet until metadata arrives), delete it on removal, re-add them all at startup, then delete files no saved torrent owns. Part of 4.3 |
| 14 | API input limits | Decided | Only v1 magnets (`urn:btih:`) and uploaded `.torrent` files up to 10 MiB. No v2-only magnets, no `.torrent` URLs, no multipart uploads. See [Adding torrents safely](#adding-torrents-safely) |
| 15 | Magnet metadata can stay pending forever | Decided | Show it, never give up automatically. A torrent with no connected peer after WebTorrent's 30-second `noPeers` check reports state `noPeers` and keeps searching; the user removes it. DHT and tracker lookups can take minutes and a rare torrent's seeder may come back later, and giving up would delete partial data. See [State and events](#state-and-events) |
| 16 | File paths from a hostile `.torrent` | Decided | Safe as is: `parse-torrent` joins each path from the root and strips it, so `../../etc/x` becomes `etc/x` and files stay inside `DOWNLOAD_DIR`. Checked in 2.3. See [Metadata](#metadata) |
| 17 | Media classification is by extension only | Decided | The browser decides: in 4.2 the player reports the `<video>` error with the file name and container. If `ffprobe` is installed, the server also probes codecs through the stream URL (only the header pieces are fetched) so the UI can warn before playing; it stays optional. Extension-only classification remains the first guess |
| 18 | Whole torrent is downloaded, not just the chosen file | Decided | Download the chosen video and its subtitles only: add torrents with `deselect: true`, then select `mainFile` and its subtitles; picking another video selects it too. Streaming still fetches any range played. Implemented in 3.3 |
| 19 | Main-file heuristics are unproven | Decided | Accepted for now: a sample is under 25% of the largest video, main-sized is at least a third. `.ts` (MPEG-TS) also matches TypeScript sources, and video inside `.rar`/`.zip` isn't found. Revisit after the manual tests with real torrents. See [Choosing the media file](#choosing-the-media-file) |
| 20 | Subtitles need work before playback | Decided | Serve `.vtt` as is and convert `.srt` to WebVTT on the server (UTF-8, falling back to Windows-1252). Match subtitles to a video by file name with an optional language code (`Sintel.en.srt` → `Sintel.mp4`, `en`). No `.ass`/`.ssa` or embedded MKV subtitles in M4. Implemented in 3.4 |
| 21 | Event stream connections per browser | Decided | One stream per page, closed while the tab is hidden and reopened when it is shown, so background tabs hold no connection; the server caps open streams at 32 (`503` above). HTTP/2 is ruled out because browsers only use it over HTTPS. Implemented in 2.5 |
| 22 | Failed torrents | Decided | Kept in memory with `state: 'error'` until deleted or re-added, at most 50, lost on restart like #13. WebTorrent has already deleted their files, so a retry starts from zero. See [State and events](#state-and-events) |
| 23 | `seeding` needs every file | Decided | Progress and state follow the selection (#18): progress is computed from the selected files and `seeding` means every selected file is done, instead of `torrent.done`/`torrent.progress`, which count every file. Implemented in 3.3 |
| 24 | State timing | Decided | Accepted: a new torrent shows `connecting` for about 30 s before `noPeers` (WebTorrent's fixed check interval), and verifying existing data also shows as `connecting`; the UI can tell that apart with `hasMetadata && !ready` |
