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
`Content-Range` and the body length, not just `200`.

## Client tests

`client/src/main.ts` is the entry point and runs as soon as it is imported,
so don't test it directly. Put logic in its own modules that take what they
need as arguments (a root element, an API helper) and keep `main.ts`
to wiring them together. Then a test builds its own DOM:

```ts
import { afterEach, expect, it } from 'vitest';
import { renderTorrentForm } from './torrent-form.js';

afterEach(() => {
  document.body.replaceChildren();
});

it('rejects an invalid magnet link', () => {
  const root = document.createElement('main');
  document.body.append(root);

  renderTorrentForm(root);
  // ...fill in the input, submit, assert on root
});
```

The browser doesn't run WebTorrent (see [ARCHITECTURE.md](ARCHITECTURE.md)),
so client tests stub the server's API, for example by passing in a fake
`fetch`, rather than mocking WebTorrent.

Pure functions (magnet validation, picking the media file in 3.1) need no
DOM at all; prefer them where you can.

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

- `torrent.simulateMetadata({ name, files: [{ name, length }] })` emits `metadata` and `ready`
- `torrent.simulateDownload(bytes, { downloadSpeed, numPeers })` emits `download`
- `torrent.simulateDone()` emits `done`
- `torrent.simulateNoPeers()` emits `noPeers`
- `torrent.simulateError(err)` / `client.simulateError(err)` emit `error`
- `file.streamTo(element)` records the element in `file.streamedTo`
- `client.simulateListening(port)` emits `listening` and makes `address()`
  return the port (it returns `null` before that and after `destroy()`)

The fake also records what the server passes in: `client.opts` (ports,
`tracker.wrtc`), `torrent.path` from `add()`'s `path` option, and
`torrent.storeDestroyed`, which is `true` when removing or destroying the
torrent would have deleted its files (`destroyStore` or
`destroyStoreOnDestroy`). Like the real client, `get()` and `remove()` are
async and `remove()` rejects for an unknown torrent, so `await` them.

`add()` takes the info hash from a parsed torrent (what the API passes) or a
hex magnet link, as the real client does. For anything else, such as a raw
`.torrent` buffer, it uses a fixed default or the `infoHash` option.

API tests that upload a `.torrent` file build one with `parse-torrent`'s
`toTorrentFile()` (see `torrentFile()` in `server/torrents-api.test.ts`), so
the real parser runs and no fixture file is needed.

If the app starts using more of the WebTorrent API, add it to the fake (and
to `test/mocks/webtorrent.test.ts`) rather than mocking ad hoc in each test.

The fake doesn't cover `file.createReadStream({ start, end })` yet; 3.2 adds
it for streaming. The fake is plain TypeScript on
`node:events`, so it works in both the `server` and `client` test projects.

## Manual testing

Peer connectivity, playback and codecs can only be checked with the real
client and a real browser. Until 4.5 adds a Playwright test, check them by
hand:

1. `npm run build && npm start`, then open `http://localhost:3000`. Use
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
