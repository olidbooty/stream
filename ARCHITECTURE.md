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
│ add form, live torrent list  │ ◀─ SSE ─ │   /api/torrents (add, list,   │
└──────────────────────────────┘          │     remove)                   │
                                          │   /api/torrents/events (SSE)  │
                                          │   .../files/:index/stream     │
                                          │     (HTTP Range)              │
                                          │   404 for everything else     │
                                          │ WebTorrent client (start.ts)  │
                                          │   TCP, uTP, DHT, WebRTC       │
                                          └───────────────────────────────┘
```

`server/start.ts` creates the client with `createTorrentClient()` from
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
3. `filterSources()` drops its `xs=` URL, and trackers and web seeds on local
   addresses (see [Network exposure](#network-exposure)).
4. The *parsed* object is passed to `addTorrent()`, so WebTorrent doesn't
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

### Downloading only what is watched

Decision #18: `addTorrent()` adds every torrent with `deselect: true`, so
nothing downloads until files are selected. `TorrentSelection`
(`server/torrent-selection.ts`) selects them once the file list is known: at
once for a `.torrent` upload, on `metadata` for a magnet link.

- **What is selected.** `mainFile` and its subtitles. A torrent with no video
  (music, an ISO) has nothing to choose between, so every file is selected.
- **Subtitles** go with a video when their name is the video's name,
  optionally followed by a language code: `Sintel.srt`, `Sintel.en.srt` and
  `Subs/Sintel.pt_BR.vtt` all go with `Sintel.mp4` (`matchSubtitles()` in
  `server/media.ts`, Decision #20). Folders are ignored.
- **Another video.** `POST /api/torrents/:infoHash/files/:index/select`
  adds a video and its subtitles. Nothing is dropped, so switching episodes
  keeps a partial download going. Only videos can be selected (`400`).
- **Streaming is separate.** A read stream fetches the range being played
  whether or not its file is selected, so any file plays at once. The
  selection only decides what keeps downloading in the background.
- **Bookkeeping.** WebTorrent's files don't say whether they are selected,
  so `TorrentSelection` remembers it in a `WeakMap` per torrent. A piece that
  spans two files is downloaded whole, so a few kilobytes of a neighbouring
  unselected file can land on disk.

Decision #23: progress and state follow the selection. A summary's
`progress` is the selected files' downloaded bytes over `selectedLength`,
and `seeding` means every selected file is done, rather than
`torrent.progress` and `torrent.done`, which count every file. So a film
shows 100% and Seeding when the film is on disk, whatever extras it skipped.
Before the file list is known, `selectedLength` is `null` and `progress` is
WebTorrent's own (0).

### State and events

Every torrent summary carries a `state`, worked out by `torrentState()` in
`server/torrent-state.ts` from the torrent's fields each time it is read, so
`GET /api/torrents`, `GET /api/torrents/:infoHash` and the event stream always
agree:

| State | When |
| ----- | ---- |
| `error` | WebTorrent hit an error and destroyed the torrent |
| `paused` | Paused by the user (see [Pausing](#pausing)), whatever else it is doing |
| `seeding` | Every selected file is on disk (Decision #23). It keeps uploading while it is in the client, peers or not |
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

### Pausing

Each row has a Pause/Resume button (`POST .../pause` and `.../resume`).
WebTorrent's own `torrent.pause()` only stops new peers from connecting: wires
that are already open keep downloading and uploading. So `pauseTorrent()` in
`server/torrent-client.ts` also destroys every wire, remembering the addresses
of the peers it dialled itself, and `resumeTorrent()` calls `resume()`, adds
those peers back and re-adds the torrent's web seeds; trackers and the DHT find
the rest. Pausing keeps the data and the selection. Opening the player on a
paused torrent resumes it, since the video would otherwise never buffer.

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
`server.closeAllConnections()` in `server/start.ts` ends open streams on
shutdown.

[sse]: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events

### Event stream limits

Each open stream holds an HTTP/1.1 connection, and browsers allow about six
per origin, so several tabs could starve the video Range requests coming in
M4 (Decision #21). The page therefore keeps **one** stream, and only while
it is visible: `startLiveUpdates()` (`client/src/live-updates.ts`) closes it
when the Page Visibility API reports the tab hidden and opens a new one when
it is shown, and the server sends the whole list on connect. On the server,
`GET /api/torrents/events` answers `503` with `Retry-After: 10` once
`MAX_EVENT_STREAMS` (32) are open. HTTP/2 would remove the per-origin limit,
but browsers only use it over HTTPS.

`EventSource` reconnects by itself after a dropped connection, but treats a
non-200 answer such as that `503` as final. The page tells the two apart by
`readyState` in its `error` handler: still `CONNECTING` is a drop, which it
reports and leaves to the browser; `CLOSED` is a refusal, which it reports
and retries itself every 10 seconds. Either way a red message appears above
the list and the list is dimmed until the stream opens again.

## The page

`client/src/main.ts` only wires modules together; each module takes what it
needs as arguments, so it can be tested in jsdom (see
[TESTING.md](TESTING.md#client-tests)):

| Module | Does |
| ------ | ---- |
| `api.ts` | `createApi()`: typed calls to `/api/torrents`. A non-2xx answer throws `ApiError` carrying the server's `error` text, which the UI shows as is, so validation stays on the server |
| `torrent-form.ts` | Adds a magnet link (JSON) or a `.torrent` file (the `File` as the raw body) |
| `torrent-list.ts` | One row per torrent, keyed by info hash and updated in place, so the once-a-second updates never rebuild what the user is focused on. A row fetches `GET /api/torrents/:infoHash` when it is expanded, and again only when its metadata arrives. Remove asks first, since it deletes the files; Retry adds a failed torrent's magnet link again (Decision #22) |
| `live-updates.ts` | The page's event stream (above) |
| `format.ts` | Sizes, speeds, percentages and state labels, including "Checking files" for a `connecting` torrent with `hasMetadata && !ready` (Decision #24); subtitle track names and the player's stats line |
| `player-route.ts` | The player's address, `#play/<infoHash>/<index>`. `main.ts` shows the list or the player on `hashchange`, so Back closes the player and a link opens it on another device |
| `player.ts` | `createPlayer()`: fetches the torrent, starts the video's background download if it isn't selected (Decision #18), and shows `videoPlayer` with the stream URL and a `<track>` per matched subtitle. Maps media events to a status line: Loading, Buffering, "Waiting for data from peers" after 5 s of `waiting` or on `stalled` while waiting, and an error naming the file. Closing removes the `src` and calls `load()`, which aborts the range request so the server stops prioritising its pieces. The stats line follows the page's one event stream (Decision #21) |

Response types are imported from `server/torrents-api.ts` with `import type`,
which the build erases, so the client and server can't drift apart.

### Design system

Decision #27: no framework or component library. The page is small and is
opened on phones and TV browsers, so it ships plain TypeScript and CSS:

- **Tokens** in `client/src/styles/tokens.css`: colour roles, one colour per
  torrent state (plus `checking`), a 4 px spacing scale, a type scale, radii,
  the focus ring, control height, dot sizes, layout widths, the dialog
  backdrop and the disabled and stale opacities. Nothing else hard-codes a
  colour, length or opacity (Decision #29); `client/src/styles/styles.test.ts`
  fails on any such literal in `components.css` and on any `var()` that no
  token defines.
- **Themes** (Decision #30): dark values apply under `prefers-color-scheme:
  dark`, unless `data-theme="light"` is set on `<html>`; `data-theme="dark"`
  forces them. The two dark blocks must match, which the same test checks.
  The gallery uses this; the main page has no switch yet.
- **Components** in `client/src/ui/`, each a function that takes plain data
  and returns elements, styled by `client/src/styles/components.css`:
  `button`, `field`, `stateBadge`, `progressBar` (native `<progress>`),
  `fileList`, `torrentRow`, `statusBanner`, `confirmDialog` (native
  `<dialog>`) and `videoPlayer` (native `<video controls>`, 3.4), with
  `linkButton` for actions that are navigation, such as Play. None of them calls the API, so the component gallery
  renders them with `client/src/sample-data.ts`.
- **Gallery** (step 2.7): `client/gallery/index.html` shows every component
  in each state, plus the add form and torrent list with a stubbed API. The
  states are one registry, `client/src/gallery/entries.ts`, which the page
  and its smoke test both walk. Add an entry for each new component or state.
  It is published to GitHub Pages from `main`; see the
  [README](README.md#component-gallery).

Use these for new UI (4.2 warnings) rather than adding styles. With the 3.4
player there are nine components and one view switch, still comfortable
without a framework (Decision #27's check). If the UI outgrows about ten
components or its state gets awkward, Preact is the smallest step up; the
tokens carry over.

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

const client = new WebTorrent({
  torrentPort, // 6881
  dhtPort, // 6882
  natUpnp: portMapping, // false unless PORT_MAPPING=1
  natPmp: portMapping,
  tracker: { wrtc },
});
```

- **DHT, LSD, TCP and uTP** are on by default. uTP uses the optional native
  `utp-native` package; if it fails to load, WebTorrent falls back to TCP
  only (`WebTorrent.UTP_SUPPORT` is `false`). With uTP loaded, WebTorrent
  tries each IPv4 peer over uTP first and only falls back to TCP after four
  failed attempts (about 41 s), so on a network that blocks UDP peers connect
  slowly. Accepted for now (Decision #26).
- **WebRTC** uses `webrtc-polyfill` (backed by `node-datachannel`, a native
  module). In `webtorrent@3` its peer library, `@thaunknown/simple-peer`,
  already imports the polyfill, so WebRTC works even without `tracker.wrtc`.
  We still pass it and list `webrtc-polyfill` in `package.json`, so WebRTC
  doesn't rely on another package's import.
- **Without `node-datachannel`** (Decision #10). The import chain
  `webtorrent` → `bittorrent-tracker` → `simple-peer` → `webrtc-polyfill` →
  `node-datachannel` is static, so if its binary is missing, importing
  `webtorrent` throws and the server can't start. `server/index.ts` therefore
  `require()`s `node-datachannel` first (`checkWebRTC()` in
  `server/peer-support.ts`). If that fails, it registers a module resolve
  hook (`module.registerHooks()`) that sends `webrtc-polyfill` to
  `server/webrtc-stub.ts`, then imports the rest of the server from
  `server/start.ts`. The hook has to be in place before anything imports
  `webtorrent`, because modules are resolved before any code runs. With the
  stub, simple-peer finds no `RTCPeerConnection`, and the client gets
  `tracker: { wrtc: false }`, so WebSocket trackers (which only find WebRTC
  peers) are skipped. The startup log lists what the client can use.
- `client.on('listening')` fires once it is bound; `client.address()` gives
  the peer port. `TORRENT_PORT` (TCP and uTP) and `DHT_PORT` (UDP) default
  to `6881` and `6882`, fixed so they can be forwarded on the router; `0`
  picks a random port. Without incoming connections the client still works,
  but finds fewer peers.
- The peer ports bind to `0.0.0.0` whatever `HOST` says. `HOST` only
  restricts the HTTP port (Risks & Decisions #8).
- **UPnP and NAT-PMP are on by default in WebTorrent**: once listening, the
  client would ask the router to forward the peer port. Decision #7 turns
  them off unless `PORT_MAPPING=1` is set.
- A port that is already in use makes the constructor emit `error`;
  `server/start.ts` logs which port and exits with status 1.
- A torrent's own errors (a bad store, invalid metadata) are re-emitted on
  the client when the torrent has no `error` listener, which would stop the
  server. `addTorrent()` always adds one, so a failing torrent only logs.
- Destroy the client on `SIGINT`/`SIGTERM` so it stops announcing and closes
  its sockets. `server/start.ts` does this; a second signal exits at once.
- **Garbled tracker peers.** `bittorrent-tracker` 11.2.3 (the latest, via
  `webtorrent` 3.0.21) builds addresses from an HTTP tracker's non-compact
  peer list as `` `${peer.ip}:${peer.port}` ``, but `bencode` 4 decodes `ip`
  as a `Uint8Array`, so the address is its bytes joined by commas
  (`49,56,53,…:6944`) and every connection fails a DNS lookup. Ubuntu's
  tracker answers IPv6 announces this way, so the first real-swarm check
  (Risks #9) found no peers at all. `addTorrent()` wraps the torrent's
  `addPeer()`, which trackers, the DHT and PEX all go through, and
  `repairPeerAddress()` (`server/peer-address.ts`) decodes those addresses
  first. Remove it once `bittorrent-tracker` decodes `ip` itself.
- **DHT bootstrap.** The DHT (`bittorrent-dht` via `k-rpc-socket`) starts by
  asking a few bootstrap routers for nodes. It looks their names up with
  `dns.lookup()` and no address family, then sends over an IPv4 socket. Since
  Node 17 the lookup returns the resolver's first answer, and on a host with
  IPv6 that is an IPv6 address for `dht.transmissionbt.com` (and
  `dht.libtorrent.org`), so the send fails with `EINVAL` and is silently
  dropped. The other default routers, `router.bittorrent.com` and
  `router.utorrent.com`, often don't answer. The DHT then reports `ready`
  with no nodes after 2.5 s and only tries again after 15 minutes, so a
  magnet without trackers finds no peers at all. Found on the owner's Mac.
  `createTorrentClient()` therefore calls `dns.setDefaultResultOrder('ipv4first')`
  for the whole process and passes `DHT_BOOTSTRAP`, which adds
  `dht.libtorrent.org:25401` (Decision #28). HTTP trackers and web seeds still
  reach IPv6-only hosts: Node falls back to IPv6 when there's no IPv4 address.
- `client.get()` and `client.remove()` are async. `remove()` rejects for an
  unknown torrent but reports the destroy through its callback, so
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
`webtorrent@3`, so no custom piece selection is needed (Decision #2); 3.3's
manual check seeks in a large film to confirm it.

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
all interfaces (Decision #8). WebTorrent would also ask the router to forward
the peer port with UPnP/NAT-PMP; that is off unless `PORT_MAPPING=1`
(Decision #7).

`/api/torrents` has no authentication (Decision #12). A torrent also makes
the server contact hosts its adder chose: trackers (`tr=`, `announce`), web
seeds (`ws=`, `as=`, `url-list`) and a magnet's `xs=` URL, which WebTorrent
fetches over HTTP to get metadata. Someone on the LAN could use that to make
the server send requests to other hosts, including ones on the LAN, so
`filterSources()` (`server/torrent-sources.ts`) cleans every parsed torrent
before `client.add()` (Decision #11):

- `xs=` is removed. Peers send the metadata anyway.
- Trackers must be `http`, `https`, `udp` or `wss` URLs, and web seeds `http`
  or `https`.
- Either is dropped if its host is `localhost` (or `*.localhost`) or a
  literal loopback, private, link-local or unspecified address, IPv4 or IPv6,
  including IPv4-mapped IPv6 and spellings such as `0x7f.1` or `2130706433`.
  `udp:` URLs are re-parsed as `http:` to get WHATWG URL's IPv4
  normalisation, which only applies to special schemes, because the system
  resolver would still read `0x7f.1` as `127.0.0.1`.
- What was dropped is logged.

Only literal addresses are caught. A hostname that resolves to a LAN
address, or a public URL that redirects to one, still passes; that is
accepted, as is the unauthenticated API. A magnet's `x.pe=` peer addresses
are kept: they let the adder make the server open a BitTorrent connection to
a host, which anyone can already do by announcing that address to the DHT.

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
| 9 | 2.1 not yet checked against a real swarm | Open | Checked in 2.6 on the owner's Mac: ordinary BitTorrent peers over TCP (once #25 was fixed) and the DHT alone. WebRTC peers, incoming peers with forwarded ports and a Raspberry Pi are deferred |
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
| 20 | Subtitles need work before playback | Decided | Serve `.vtt` as is and convert `.srt` to WebVTT on the server (UTF-8, falling back to Windows-1252). Match subtitles to a video by file name with an optional language code (`Sintel.en.srt` → `Sintel.mp4`, `en`). No `.ass`/`.ssa` or embedded MKV subtitles in M4. Implemented in 3.4: `GET .../files/:index/subtitles.vtt` (`server/subtitles.ts`) serves them, files above 2 MiB get `413`, and the player adds one `<track>` per match |
| 21 | Event stream connections per browser | Decided | One stream per page, closed while the tab is hidden and reopened when it is shown, so background tabs hold no connection; the server caps open streams at 32 (`503` above). HTTP/2 is ruled out because browsers only use it over HTTPS. Implemented in 2.5 |
| 22 | Failed torrents | Decided | Kept in memory with `state: 'error'` until deleted or re-added, at most 50, lost on restart like #13. WebTorrent has already deleted their files, so a retry starts from zero. See [State and events](#state-and-events) |
| 23 | `seeding` needs every file | Decided | Progress and state follow the selection (#18): progress is computed from the selected files and `seeding` means every selected file is done, instead of `torrent.done`/`torrent.progress`, which count every file. Implemented in 3.3 |
| 24 | State timing | Decided | Accepted: a new torrent shows `connecting` for about 30 s before `noPeers` (WebTorrent's fixed check interval), and verifying existing data also shows as `connecting`; the UI can tell that apart with `hasMetadata && !ready` |
| 25 | Tracker peer addresses garbled by `bittorrent-tracker` | Decided | Found in the 2.6 real-swarm check. Worked around in our code: `addTorrent()` repairs the addresses before WebTorrent tries them. Remove once fixed upstream. See [Creating the client](#creating-the-client) |
| 26 | uTP is tried first and TCP only after about 41 s | Decided | Accepted: keep uTP on. It only slows peers down where UDP is blocked, and the DHT fails there too. Revisit (uTP off by default, `UTP=1` to turn it on, a startup warning when the DHT finds no nodes) if users report `noPeers` on such networks |
| 27 | UI design system and component library | Decided | Our own: design tokens as CSS custom properties and about eight components on native HTML, no framework or component library. Nothing to install or load on TV browsers, and simple jsdom tests. Revisit in 3.4 if the UI passes about ten components; Preact would be the smallest step. See [Design system](#design-system) |
| 28 | DHT found no nodes on a host with IPv6 | Decided | Found when a trackerless magnet got no peers on the owner's Mac. `createTorrentClient()` makes DNS lookups prefer IPv4 for the whole process and bootstraps the DHT from a wider router list including `dht.libtorrent.org:25401`. Remove the DNS setting once `k-rpc-socket` looks up IPv4 itself. See [Creating the client](#creating-the-client) |
| 29 | Design tokens are not the only source of colours and sizes | Decided | Found in the 23 Oct 26 frontend review: `components.css` hard-coded ten colours, lengths and opacities. They are tokens now, and a test fails on any colour, length or opacity literal in `components.css`. Step 2.7. See [Design system](#design-system) |
| 30 | Dark mode can only follow the OS setting | Decided | `data-theme="light"` or `"dark"` on `<html>` forces a theme; without it `prefers-color-scheme` decides. Plain duplicated dark values rather than CSS `light-dark()`, which older TV browsers lack. Step 2.7 |
