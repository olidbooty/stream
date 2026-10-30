# Testing

Tests run with [Vitest](https://vitest.dev), which reuses `vite.config.ts`.

```sh
npm test            # run once
npm run test:watch  # re-run on change
npm run coverage    # run with v8 coverage (report in coverage/)
```

## Layout and environments

Test files sit next to the code they cover and end in `.test.ts`.
`vitest.config.ts` splits them into two projects:

| Project  | Environment | Files                                      |
| -------- | ----------- | ------------------------------------------ |
| `server` | node        | `server/**/*.test.ts`                      |
| `client` | jsdom       | `client/**/*.test.ts`, `test/**/*.test.ts` |

## Server tests

`server/app.ts` exports `createApp()` without calling `listen()`. Drive it
with supertest and pass `staticDir` a fixture directory, so tests do not
depend on `npm run build` or bind a port (see `server/app.test.ts`).

`createApp()` also requires the torrent client. Tests pass a
`FakeWebTorrent` instead, so no test opens a peer port or touches the
network:

```ts
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';

const client = new FakeWebTorrent();
const app = createApp({ staticDir, client: client as unknown as WebTorrent });
```

Streaming routes return byte ranges, so assert on the status (`206`/`416`),
`Content-Range` and the body, not just `200`. supertest only buffers text and
JSON, so give it a `.parse()` that collects the bytes (see `get()` in the
stream tests in `server/torrents-api.test.ts`). What happens when the browser
hangs up needs a real connection: those tests use `app.listen(0)`, `fetch`
and an `AbortController`, like the event stream test.

Server-sent events never end, so supertest can't read them. Test the pieces
instead: `EventStream` with a fake sink and `vi.useFakeTimers()`
(`server/event-stream.test.ts`), and the state rules as a pure function
(`server/torrent-state.test.ts`). The one end-to-end check starts the router
on an ephemeral port with `app.listen(0)`, reads events with `fetch` and a
stream reader, then aborts (see `GET /events` in
`server/torrents-api.test.ts`).

A restart is two routers on the same directory. `server/saved-torrents.test.ts`
and `server/torrents-restore.test.ts` give each test its own `DOWNLOAD_DIR`
from `mkdtempSync()`, build a router with a `SavedTorrents` on it, then build
a second one with a fresh `FakeWebTorrent` from what `saved.load()` returns,
as `server/start.ts` does at startup (Decision #13). Remove the directory in
`afterEach`.

The TV playlist's addresses depend on the request's `Host` header and the
machine's LAN addresses, so `server/tv-playlist.test.ts` sets `Host` with
supertest's `.set()` and passes `createApp()` its own `lanAddresses`
function rather than reading the real network interfaces.

## Client tests

`client/src/main.ts` is the entry point and runs as soon as it is imported,
so don't test it directly. Put logic in its own modules that take what they
need as arguments (a root element, an API helper) and keep `main.ts`
to wiring them together. Then a test builds its own DOM:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { sampleSummary } from './sample-data.js';
import { torrentForm } from './torrent-form.js';

afterEach(() => {
  document.body.replaceChildren();
});

it('adds a magnet link', async () => {
  const api = {
    addMagnet: vi.fn().mockResolvedValue(sampleSummary()),
    addTorrentFile: vi.fn(),
  };
  const root = torrentForm({ api, onAdded: vi.fn() });
  document.body.append(root);
  // ...fill in the input, submit, assert on api and root
});
```

The browser doesn't run WebTorrent (see [ARCHITECTURE.md](ARCHITECTURE.md)),
so client tests stub the server's API rather than mocking WebTorrent: pass
the module a fake `api` object (see `client/src/torrent-list.test.ts`), or
pass `createApi()` a fake `fetch` (see `client/src/api.test.ts`).
`client/src/sample-data.ts` builds torrents shaped like the server's answers;
its types come from `server/torrents-api.ts`, so they can't drift.

jsdom lacks three browser APIs the page uses:

- **`EventSource`.** `startLiveUpdates()` takes a `createEventSource`
  function, so `client/src/live-updates.test.ts` passes a fake that opens,
  sends events, drops (the browser retries by itself) or refuses (a `503`,
  after which the browser gives up), and switches `document.visibilityState`.
- **`<dialog>`'s `showModal()` and `close()`.** `client/src/ui/components.test.ts`
  stands in for them on `HTMLDialogElement.prototype`.
- **Media playback.** jsdom's `<video>` never loads or plays, and `load()` and
  `pause()` only log "not implemented". `client/src/player.test.ts` stubs
  them (and `play()`) on `HTMLMediaElement.prototype`, dispatches `waiting`,
  `stalled`, `canplay`, `loadedmetadata` and `error` itself, and defines
  `video.error` for the error code. jsdom's `videoWidth` is always 0, which
  looks like a picture the browser can't decode, so tests that need a picture
  define it. jsdom's `readyState` is 0 and `buffered` is empty, so the buffer
  health tests (step 3.5) define `readyState`, `duration`, `currentTime` and
  `buffered` on the element, and pass `createPlayer()` a `now` clock for the
  slow-download warning's delay. The arithmetic itself is pure
  (`client/src/buffer-health.ts`).
  Real playback, seeking and subtitles are checked by hand in a browser.

Pure functions such as `isMagnetURI()` (`server/magnet.ts`),
`selectMedia()` (`server/media.ts`) and `filterSources()`
(`server/torrent-sources.ts`) need no DOM or fake client at all; prefer them
where you can.

What happens when a native module can't load is tested in a child process,
because module hooks and imports can't be undone inside the test run:
`server/peer-support.test.ts` runs `node --import tsx` with a resolve hook
that makes `node-datachannel` fail, and checks that `webtorrent` loads with
`disableWebRTC()` and fails without it.

## Mocking WebTorrent

Unit tests never join a real swarm: it would open ports, depend on the
network and be slow. Use the shared fake in `test/mocks/webtorrent.ts`. The
exception is `server/peer-handshake.test.ts`, which checks a fix inside
WebTorrent's own peer code: it runs a real client with DHT, trackers and LSD
off and dials it over loopback.
Prefer passing a `new FakeWebTorrent()` to the code under test (see
[Server tests](#server-tests)). Where code creates the client itself,
replace the module:

```ts
import { afterEach, vi } from 'vitest';
import { FakeWebTorrent } from '../../test/mocks/webtorrent.js';

vi.mock('webtorrent', () => import('../../test/mocks/webtorrent.js'));

afterEach(() => FakeWebTorrent.reset());
```

Code under test then gets a `FakeWebTorrent` from `new WebTorrent()`. Grab it
from `FakeWebTorrent.instances`, which is typed as the fake. A test that calls
`new WebTorrent()` itself gets the real module's types, so cast it with
`as unknown as FakeWebTorrent` (see `createClient()` in
`test/mocks/webtorrent.test.ts`). Then drive the swarm with the test-only helpers:

- `torrent.simulateMetadata({ name, files: [{ name, length, path }] })` sets
  `torrent.metadata`, emits `metadata` and then `ready`. Pass `ready: false`
  to stop after `metadata`, as the real client does while it verifies data
  on disk, then call `torrent.simulateReady()`. `metadata` sets the
  `.torrent` bytes it holds (empty by default)
- `torrent.simulateDownload(bytes, { downloadSpeed, numPeers })` emits `download`
- `torrent.simulateWire(address, type)` connects a peer: adds a `FakeWire`
  (default `127.0.0.1:688x`, `'tcpOutgoing'`) to `torrent.wires`, adds one to
  `numPeers` and emits `wire`. `wire.destroy()` takes it out again
- `torrent.pause()`, `torrent.resume()` and `torrent.paused` behave like the
  real ones: while paused `addPeer()` returns `false`. `torrent.urlList` holds
  web seeds and `torrent.addedWebSeeds` records `addWebSeed()` calls
- `torrent.simulateFileDownload(index, bytes)` adds bytes to one file
  (`file.downloaded`, `file.progress`) and the torrent; the file is `done`
  once all its bytes are in, and the torrent once every file is. Use it
  where progress or `seeding` over the selection matters (Decisions #18
  and #23)
- `torrent.simulateDone()` marks every file and the torrent done and emits `done`
- `torrent.simulateNoPeers(source)` emits `noPeers` with `'tracker'`, `'dht'`,
  `'lsd'` or `'ut_pex'`
- `torrent.simulateError(err)` fails the torrent as the real client does: it
  is destroyed (deleting its store with `destroyStoreOnDestroy`) and removed
  from `client.torrents`, then `error` is emitted on the torrent, or on the
  client if the torrent has no `error` listener, then `close`
- `client.simulateError(err)` emits `error` on the client
- `file.createReadStream({ start, end })` streams the range and records it in
  `file.readStreams` (`{ start, end, stream }`). Byte `i` of a fake file is
  `i % 256`; `fakeFileBytes(start, end)` builds the expected body. Like the
  real file, `end: 0` reads to the end of the file. A file made with
  `available: n` serves only its first `n` bytes and then waits, as the real
  stream waits for pieces, until it is destroyed
- `file.type` is the MIME type from the extension (a few common ones), or
  the `type` option
- `file.streamTo(element)` records the element in `file.streamedTo`
- `client.simulateListening(port)` emits `listening` and makes `address()`
  return the port (it returns `null` before that and after `destroy()`)
- `FakeWebTorrent.UTP_SUPPORT` stands for whether `utp-native` loaded; set it
  to `false` to test the TCP-only path, and back to `true` afterwards

The fake also records what the server passes in: `client.opts` (ports,
`tracker.wrtc`), `torrent.path` from `add()`'s `path` option, and
`torrent.storeDestroyed`, which is `true` when removing or destroying the
torrent would have deleted its files (`destroyStore` or
`destroyStoreOnDestroy`), and `torrent.deselect`. A torrent added with
`deselect: true` starts with every `file.selected` false until `file.select()`;
`selected` is fake-only, as the real file doesn't expose it. Like the real client, `get()` and `remove()` are
async and `remove()` rejects for an unknown torrent, so `await` them.

`add()` takes the info hash from a parsed torrent (what the API passes) or a
hex magnet link, as the real client does. For anything else, such as a raw
`.torrent` buffer, it uses a fixed default or the `infoHash` option.

API tests that upload a `.torrent` file build one with `parse-torrent`'s
`toTorrentFile()` (see `torrentFile()` in `server/torrents-api.test.ts`), so
the real parser runs and no fixture file is needed.

If the app starts using more of the WebTorrent API, add it to the fake (and
to `test/mocks/webtorrent.test.ts`) rather than mocking ad hoc in each test.

The fake is plain TypeScript on `node:events` and `node:stream`, so it works
in both the `server` and `client` test projects.

## Component gallery and style checks

The component gallery (`client/gallery/`, see
[README](README.md#component-gallery)) is the visual check for UI changes:
open it with `npm run dev` at `/gallery/` and look at the states you touched,
in light and dark and at phone width. When you add a component or a state,
add an entry to `client/src/gallery/entries.ts`.

Two tests keep it honest without screenshots (those come with Playwright in
4.5):

- `client/src/gallery/gallery.test.ts` renders every entry in jsdom and fails
  if one throws or comes out empty, if a state badge tone has no entry, or if
  the theme switch stops setting `data-theme`.
- `client/src/styles/styles.test.ts` fails on a colour, length or opacity
  literal in `components.css` (use a token from `tokens.css`), on a `var()`
  no token defines, and if the forced dark theme drifts from the OS one.

## Manual testing

Peer connectivity, playback and codecs can only be checked with the real
client and a real browser. Until 4.5 adds a Playwright test, check them by
hand:

1. `npm start` (it builds first), then open `http://localhost:1234`. Use
   `npm run dev` for quick UI work, but check playback against the built
   app served by Express.
2. Test both kinds of swarm the server should reach:
   - an ordinary BitTorrent torrent (TCP/uTP peers, DHT), for example a
     Linux distribution ISO or an open-licensed film
   - a WebRTC-seeded torrent such as WebTorrent's demo, Sintel
     (`https://webtorrent.io/torrents/sintel.torrent`)
3. To test DHT alone, use a magnet link with no `tr=` trackers.
4. Open a LAN URL printed at startup on another device (a phone, a TV
   browser) and check it plays there too.
5. Watch the server log for errors, the browser console, and for M4 steps
   the `<video>` element's `waiting` and `stalled` events. Seek forward to
   check the range requests.
6. Restart the server with Ctrl+C and `npm start` while a torrent is part
   downloaded. It should come back with the same progress, selected files
   and paused state, and its files should still be in `DOWNLOAD_DIR`.
   To check the disk limit (Decision #36), set a limit on the Settings page a
   little above what the torrents use now, and play or add something. Once
   usage reaches it, the downloading torrents show "Paused: disk limit
   reached", the list shows the amber disk-limit banner, and adding another
   is refused; raising the limit resumes them.
   A restart keeps the limit. Put a folder of your own in `DOWNLOAD_DIR`
   and reload: it shows under Leftover files, and Delete removes it after
   the confirmation.

7. To see how playback copes when peers slow down (step 3.5), seed a file
   you made from a second WebTorrent client on the same machine with the
   DHT, trackers and LSD off, and add it with a magnet carrying
   `x.pe=127.0.0.1:<its port>`. Change the seeder's speed with
   `client.throttleUpload(bytesPerSecond)` during playback (`-1` removes the
   limit): above the video's bitrate the stats line's "buffered" figure
   stays up; below it the warning line appears before the video stops to
   buffer; at 0 the status turns to "Waiting for data from peers". An
   ffmpeg test clip works, for example `ffmpeg -f lavfi -i
   testsrc2=size=640x360:rate=25 -f lavfi -i sine -t 240 -c:v libvpx -b:v
   1200k -c:a libopus Clip.webm`.

8. For the TV playlist (step 3.11), open the `/tv.m3u` address shown under
   **Watch on TV** (Settings page) in VLC on the TV (Stream, or Network Stream). Each video
   should be listed by name, play, and seek; playing one of a paused torrent
   should resume it. Without a TV, `cvlc --play-and-exit -vv <address>`
   (VLC refuses to run as root) logs each entry's name and its `Range`
   requests.

Real peer tests use your network and upload to the swarm (see
[ARCHITECTURE.md](ARCHITECTURE.md#seeding)). Remove test torrents afterwards
and clear the download directory.

Only use content you have the right to share: open-licensed films such as
Sintel or Big Buck Bunny, or files you made yourself.

Record what you checked by hand in the pull request description.
