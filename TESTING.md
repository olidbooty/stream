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
  them on `HTMLMediaElement.prototype`, dispatches `waiting`, `stalled`,
  `canplay` and `error` itself, and defines `video.error` for the error code.
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
network and be slow. Use the shared fake in `test/mocks/webtorrent.ts`.
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
  on disk, then call `torrent.simulateReady()`
- `torrent.simulateDownload(bytes, { downloadSpeed, numPeers })` emits `download`
- `torrent.simulateWire()` connects a peer: adds one to `numPeers` and emits `wire`
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

1. `npm run build && npm start`, then open `http://localhost:1234`. Use
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

Real peer tests use your network and upload to the swarm (see
[ARCHITECTURE.md](ARCHITECTURE.md#seeding)). Remove test torrents afterwards
and clear the download directory.

Only use content you have the right to share: open-licensed films such as
Sintel or Big Buck Bunny, or files you made yourself.

Record what you checked by hand in the pull request description.
