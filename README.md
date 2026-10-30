# stream

Stream video from torrents to any browser on your network. A WebTorrent client
in the Node server joins BitTorrent (TCP, uTP, DHT) and WebRTC swarms and
streams files to the page over HTTP.

## Requirements

Node.js 24 LTS or newer (see `.nvmrc`).

## Getting started

```sh
npm install
npm start       # build client/ into public/, then serve it on http://localhost:1234
```

`npm start` runs `npm run build` first (the `prestart` script), so the server
never serves a stale or missing `public/`.

The server binds to `0.0.0.0`, so other devices on your network can open the
LAN URLs it prints at startup. Set `HOST=127.0.0.1` to keep it local, or
`PORT` to change the port.

`npm start` also starts the WebTorrent client, which finds peers through
the DHT, trackers and local service discovery (LSD), and connects to them
over TCP, uTP and WebRTC. It is configured with environment variables:

| Variable       | Default       | What it sets |
| -------------- | ------------- | ------------ |
| `PORT`         | `1234`        | HTTP port for the app |
| `HOST`         | `0.0.0.0`     | HTTP bind address. The peer ports always listen on all interfaces |
| `DOWNLOAD_DIR` | `./downloads` | Where torrent files are stored (gitignored). Created at startup if missing; must be writable. Removing a torrent deletes its files. The torrent list is saved in `DOWNLOAD_DIR/.torrents` and restored on the next start |
| `TORRENT_PORT` | `6881`        | TCP and UDP (uTP) port for incoming peers. `0` picks a random port on each start |
| `DHT_PORT`     | `6882`        | UDP port for the DHT. `0` picks a random port |
| `PORT_MAPPING` | `0`           | `1` lets the client ask your router to forward the peer port (UPnP and NAT-PMP) |
| `DISK_LIMIT_GB` | none         | Starting disk limit for the torrents, in decimal GB (`50`, `1.5`). Only used until a limit is saved under Settings on the page, which then wins |

The startup log shows the peer port, which kinds of peers the client can use
and where downloads go. `GET /api/client` also returns the peer port.
`Ctrl+C` destroys the client cleanly so it stops announcing to the swarm. If
another program already uses one of the ports, the server says which and
exits; pick other ports, or `0`.

### Port forwarding

The client finds peers without any router setup, but peers can only connect
to it if its ports are reachable, and many swarms have more peers that wait
for incoming connections than ones that accept them. For the most peers,
forward these on your router to the machine running the server:

- `TORRENT_PORT` (default `6881`), **TCP and UDP**
- `DHT_PORT` (default `6882`), **UDP**

Never forward the HTTP port (`PORT`): the app has no authentication.

Instead of forwarding by hand you can set `PORT_MAPPING=1`, and the client
asks the router to forward the peer port with UPnP or NAT-PMP if the router
allows it. It is off by default so the server never changes your router's
settings without you asking (Decision #7).

### Native modules

uTP and WebRTC use native modules, `utp-native` and `node-datachannel`. npm
installs prebuilt binaries for Linux x64, macOS and Windows; `node-datachannel`
downloads its binary during `npm install`, so that needs network access. On
other platforms, such as a Raspberry Pi (Linux on ARM), npm builds them from
source, which needs a C++ toolchain and CMake:

```sh
sudo apt install build-essential cmake python3
npm install
```

If either still fails to load, the server runs without it rather than
stopping: without `utp-native` it connects over TCP only, and without
`node-datachannel` it has no WebRTC peers. The startup log says which, for
example `peers over TCP, DHT, LSD, trackers`.

For frontend work, `npm run dev` starts the Vite dev server with hot reload.
It forwards `/api` to the Express server on `PORT` (default `1234`), so run
`npm start` in another terminal.

### Component gallery

`client/gallery/` is a page that shows every UI component in each of its
states, drawn from sample data with no server, with a switch to force light or
dark. In development open `http://localhost:5173/gallery/` from `npm run dev`.
`npm run build:gallery` builds it on its own into `dist-gallery/`.

On every push to `main`, `.github/workflows/gallery.yml` runs lint, typecheck
and the tests, then publishes the gallery to GitHub Pages at
<https://olidbooty.github.io/stream/>. This needs Pages turned on once:
Settings > Pages > Source: GitHub Actions.

## Using the app

Open the server's URL in a browser on any device on your network. Paste a
magnet link or pick a `.torrent` file to add a torrent. The list below
updates live with each torrent's state, progress, size, peers and speeds;
expand a torrent to see its files, with the one the player will pick marked
as the main file. Only that video and its subtitles download, so a torrent's
size reads like `1.4 GB of 2.1 GB selected` when it has extras, and the files
being downloaded are marked. **Play** opens the main video in the page, and
each video in the file list has its own Play. Subtitles that match the
video's name (`Film.srt`, `Film.en.srt`) are in the player's captions menu.
The player has its own address (`#play/...`), so Back returns to the list
and the link opens the same video on another device. **Remove** asks first,
because it deletes the downloaded files, and a failed torrent has **Retry**,
which adds it again.

### Watching on a TV with VLC

Below the torrent list, **Watch on TV** shows an address like
`http://192.168.1.20:1234/tv.m3u`. In VLC on the TV (a Fire Stick, Android
TV, or VLC on any computer), choose **Stream** (**Network Stream** in some
versions), enter that address and save it as a favourite. It is a playlist of
every video in the list, by name, so after that you only pick from it. VLC
fetches it again each time, so new torrents show up, and it plays formats
browsers often can't (MKV, HEVC, AC-3). Seeking works, and opening a video
downloads it and resumes its torrent, like Play in the page. Subtitles aren't
included: VLC can't load them from a playlist. The address uses the
computer's LAN address even when the page is open on `localhost`; if it
lists several, try the next one when the TV can't connect.

If the page loses its live connection, a red message above the list says so
and the list is dimmed until updates resume. The page reconnects by itself.

## API

The page uses this API, and scripts can too:

| Request | What it does |
| ------- | ------------ |
| `GET /api/torrents` | List torrents: info hash, name, magnet link, `hasMetadata`, `ready`, total `length`, `selectedLength` (bytes being downloaded), `progress` (over the selected files), the `mainFile` to play, peers, speeds, `state` and `errorMessage` |
| `GET /api/torrents/events` | The same list as a [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream of `torrents` events: sent at once, then whenever it changes, at most once a second. At most 32 streams are open at once; above that it answers `503` with `Retry-After: 10` |
| `GET /api/torrents/:infoHash` | One torrent, plus its `files` (index, name, path, length, `selected`, `media`, `sample`, and for a video its matching `subtitles` as `{index, language}`) and the `videos` to list. While a magnet link's metadata is still coming from peers, `hasMetadata` is `false` and `files`, `length`, `mainFile` and `videos` are `null`. For a failed torrent `files`, `mainFile` and `videos` are `null` |
| `POST /api/torrents` with JSON `{"magnet": "magnet:?xt=urn:btih:..."}` | Add a magnet link. `201` with the torrent, `400` if it isn't a BitTorrent magnet, `409` if it's already added |
| `POST /api/torrents` with a `.torrent` file as the body, `Content-Type: application/x-bittorrent` | Add a torrent file, up to 10 MiB (`413` above that) |
| `GET /api/torrents/:infoHash/files/:index/stream` | The file's bytes, for `<video src>`. Honours `Range` (`206` with `Content-Range`, `416` past the end), so playback and seeking start before the download finishes. `409` while the metadata is pending or for a failed torrent, `404` for an unknown file. Video, audio and `.vtt` files are served inline; anything else as a download (`application/octet-stream`) |
| `GET /api/torrents/:infoHash/files/:index/stream?play` | The same, and for a video also what Play does: selects it so the rest downloads in the background, and resumes a paused torrent. Used by the TV playlist |
| `POST /api/torrents/:infoHash/files/:index/select` | Start downloading another video and its subtitles, keeping what was already selected. `204`, `400` if the file isn't a video, `409` while the metadata is pending or for a failed torrent, `404` for an unknown file |
| `GET /api/torrents/:infoHash/files/:index/subtitles.vtt` | A `.srt` or `.vtt` file as WebVTT for a `<track>`: `.srt` is converted, both are decoded as UTF-8 or else Windows-1252. `400` for any other file, `413` above 2 MiB, and the same `404`/`409` as the stream route |
| `POST /api/torrents/:infoHash/pause` | Stop downloading and uploading, keeping the data: disconnects its peers and accepts no new ones. `204` (also if already paused), `409` for a failed torrent, `404` if it isn't there |
| `POST /api/torrents/:infoHash/resume` | Start a paused torrent again: reconnects the peers it had and looks for more. Same answers as pause |
| `DELETE /api/torrents/:infoHash` | Remove a torrent and delete its files, or clear a failed one. `204`, or `404` if it isn't there |
| `GET /api/client` | Whether the torrent client is listening, its peer port and total speeds |
| `GET /tv.m3u` | An M3U playlist for VLC: every video of every torrent with a file list, samples left out, each with an absolute `...stream?play` URL. Named after the torrent, or after the file when a torrent has several videos. URLs use the host the playlist was fetched on, or the LAN address when that is `localhost`. `Cache-Control: no-store` |
| `GET /api/tv` | `{"playlistUrls": [...]}`: the playlist's address as another device would use it, one per LAN address (or the page's own host when it isn't `localhost`); empty with no network |

Errors are JSON: `{"error": "..."}`.

Trackers and web seeds on `localhost` or a local IP address (`127.x`, `10.x`,
`192.168.x` and so on) are dropped from added torrents, as is a magnet's
`xs=` URL, so a torrent can't make the server send requests into your
network. The server logs what it dropped. See
[ARCHITECTURE.md](ARCHITECTURE.md#network-exposure).

`hasMetadata` turns true as soon as the file list is known. `ready` follows
once WebTorrent has also checked any data already on disk, which can take a
while for a large torrent that was partly downloaded before. A `.torrent`
upload has its metadata straight away; a magnet link waits until a peer
sends it, and with no peers it stays pending (`state` turns to `noPeers`).

`state` is one of:

| `state` | Meaning |
| ------- | ------- |
| `connecting` | Looking for peers, fetching a magnet link's metadata, or checking data already on disk |
| `downloading` | Has its metadata and at least one peer |
| `seeding` | Finished: every selected file is downloaded. It keeps uploading while it is listed |
| `noPeers` | No peer connected for about 30 seconds or more. It keeps looking until you remove it |
| `paused` | Paused with the Pause button or `POST .../pause`: no peers and no transfers until it is resumed. Playing one of its videos resumes it |
| `error` | It failed, and WebTorrent stopped it and deleted its files. `errorMessage` says why; `files` is `null`. It stays listed until you delete it or add it again to retry |

Each file's `media` is one of:

| `media` | Extensions |
| ------- | ---------- |
| `video` | `.mp4`, `.m4v`, `.webm`: should play in any current browser |
| `video-may-not-play` | `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.ts`, `.m2ts`, `.mts`, `.mpg`, `.mpeg`, `.vob`, `.ogv`, `.ogm`, `.3gp`, `.3g2`, `.asf`, `.f4v`, `.divx`, `.rm`, `.rmvb`: worth trying, but the browser may refuse it |
| `subtitle` | `.srt`, `.vtt` |
| `other` | anything else |

Only the extension is checked (case-insensitive), not the codecs inside.
`sample` is `true` for a video that looks like a short sample clip.
`mainFile` is the index of the video to play by default, or `null` if there
is none; `videos` lists the index of every video in the order to show them.
Only `mainFile` and its subtitles are `selected` at first, or every file of a
torrent with no video; the rest are fetched only while they are streamed.
How they are chosen is in
[ARCHITECTURE.md](ARCHITECTURE.md#choosing-the-media-file).

```sh
curl -X POST localhost:1234/api/torrents -H 'Content-Type: application/json' \
  -d '{"magnet": "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel"}'
curl -X POST localhost:1234/api/torrents -H 'Content-Type: application/x-bittorrent' \
  --data-binary @sintel.torrent
curl -N localhost:1234/api/torrents/events   # Ctrl+C to stop
curl -r 0-1023 -o head.bin \
  localhost:1234/api/torrents/08ada5a7a6183aae1e09d831df6748d566095a10/files/0/stream
```

```
event: torrents
data: [{"infoHash":"08ada5a7…","name":"Sintel",…,"numPeers":0,"state":"noPeers","errorMessage":null}]
```

In the browser, `new EventSource('/api/torrents/events')` reconnects by itself
if the server restarts.

Torrents survive a restart (Decision #13): each one is saved in
`DOWNLOAD_DIR/.torrents` as it changes, with its selected files and whether
it is paused, and added again when the server starts. Their downloaded data
is kept, re-checked at startup ("Checking files" for a while on a large
torrent), and the download carries on from there. Failed torrents are not
restored. Delete `DOWNLOAD_DIR/.torrents` to start with an empty list.

The disk limit (Decision #36) is set under Settings at the bottom of the page
and saved in `DOWNLOAD_DIR/.settings.json`, so every device sees the same
limit and it survives a restart. Once the torrents' data reaches it, every
torrent still downloading pauses ("Paused: disk limit reached"), and adding
or resuming one answers `507`. Finished torrents keep seeding, and what is on
disk still plays. Removing a torrent or raising the limit lets the paused
ones carry on by themselves. The same setting is at `/api/settings`:

```sh
curl localhost:1234/api/settings
curl -X PUT localhost:1234/api/settings -H 'Content-Type: application/json' \
  -d '{"diskLimit": 50000000000}'   # bytes; null for no limit
```

Files and folders in `DOWNLOAD_DIR` that no torrent owns, for example from a
torrent removed while the server was down, are listed under Settings as
leftover files (Decision #37), each with a Delete button. Nothing is deleted
until you press it. `GET /api/leftovers` lists them and
`DELETE /api/leftovers/<name>` deletes one.

## Layout

```
client/                   frontend source (Vite root)
client/gallery/           component gallery page (step 2.7)
client/src/gallery/       its entries, layout and smoke test
server/app.ts             Express app (createApp), no port binding
server/index.ts           entry point: checks WebRTC can load, then runs start.ts
server/start.ts           creates the torrent client, binds HOST/PORT
server/peer-support.ts    runs without WebRTC when node-datachannel can't load
server/webrtc-stub.ts     stands in for webrtc-polyfill in that case
server/torrent-client.ts  WebTorrent client setup, config from env vars
server/torrents-api.ts    /api/torrents routes
server/torrent-state.ts   torrent state (connecting, noPeers, ...) and failed torrents
server/saved-torrents.ts  saves torrents in DOWNLOAD_DIR/.torrents and loads them at startup
server/atomic-file.ts     writes a file through a temporary file and rename()
server/settings.ts        the user's settings in DOWNLOAD_DIR/.settings.json
server/settings-api.ts    /api/settings
server/disk-limit.ts      pauses downloads at the disk limit
server/leftovers.ts       /api/leftovers: files in DOWNLOAD_DIR no torrent owns
server/event-stream.ts    server-sent events broadcaster
server/file-stream.ts     serves a torrent file over HTTP with Range support
server/magnet.ts          magnet link validation
server/torrent-sources.ts drops trackers, web seeds and xs= URLs on local addresses
server/media.ts           classifies a torrent's files and picks the one to play
server/tv-playlist.ts     /tv.m3u playlist for VLC on a TV, and /api/tv
server/network.ts         the machine's LAN addresses
client/src/main.ts        page entry point: wires the modules below together
client/src/api.ts         typed client for /api/torrents
client/src/live-updates.ts  the page's one event stream (Decision #21)
client/src/torrent-form.ts  add a magnet link or .torrent file
client/src/torrent-list.ts  the live torrent list and its file lists
client/src/tv-playlist.ts   Watch on TV: the playlist address for VLC
client/src/settings-panel.ts  Settings: the disk limit, usage and leftover files
client/src/ui/            design system components (Decision #27)
client/src/styles/        design tokens and component styles
public/                   build output served by Express (gitignored)
dist-gallery/             component gallery build for GitHub Pages (gitignored)
.github/workflows/        publishes the gallery from main
downloads/                default DOWNLOAD_DIR (gitignored)
test/mocks/               shared test doubles, e.g. the WebTorrent fake
biome.json                Biome lint and format config
```

## Scripts

| Script               | What it does                         |
| -------------------- | ------------------------------------ |
| `npm start`          | Build the frontend, then run the Express server (via tsx) |
| `npm run dev`        | Vite dev server                      |
| `npm run build`      | Build the frontend into `public/`    |
| `npm run build:gallery` | Build the component gallery into `dist-gallery/` |
| `npm run typecheck`  | Type-check everything with `tsc`     |
| `npm run lint`       | Lint and check formatting with Biome |
| `npm run lint:fix`   | Apply Biome's safe fixes and format  |
| `npm run format`     | Format only, without lint fixes      |
| `npm test`           | Run the test suite once              |
| `npm run test:watch` | Run tests in watch mode              |
| `npm run coverage`   | Run tests with coverage              |

The code is TypeScript. `tsconfig.json` only type-checks (`noEmit`): Vite and
Vitest transpile it themselves and `tsx` runs the server, so there is no
compile step. Relative imports keep the `.js` extension (`./app.js` resolves
to `app.ts`), as Node's ESM resolution expects.

## Code style

[Biome](https://biomejs.dev) lints and formats the code, configured in
`biome.json`: 2-space indent, single quotes, semicolons, trailing commas,
80-column lines, sorted imports and the recommended lint rules. Run
`npm run lint` to check and `npm run lint:fix` to fix what it can. Use
`import type` for type-only imports (`verbatimModuleSyntax` enforces it), and
prefix unused parameters with `_`, such as Express's `req`.
Comments explain why, not what.

See [TESTING.md](TESTING.md) for test conventions.
See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and
the WebTorrent constraints that shape the design.
See [PROJECT_MANAGEMENT.md](PROJECT_MANAGEMENT.md) for the project tracker and
how work is planned.
