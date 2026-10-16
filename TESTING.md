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

## Client tests

`client/src/main.ts` is the entry point and runs as soon as it is imported,
so don't test it directly. Put logic in its own modules that take what they
need as arguments (a root element, a WebTorrent client) and keep `main.ts`
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

Pure functions (magnet validation, picking the media file in 3.1) need no
DOM at all; prefer them where you can.

## Mocking WebTorrent

jsdom has no WebRTC and cannot play video, so client unit tests never use a
real swarm. Replace the module with the shared fake in `test/mocks/webtorrent.ts`:

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

If the app starts using more of the WebTorrent API, add it to the fake (and
to `test/mocks/webtorrent.test.ts`) rather than mocking ad hoc in each test.

The fake follows the real API for the parts it implements, but it is not a
full copy: for example `streamTo` works without `client.createServer()`,
which the real client requires (see
[ARCHITECTURE.md](ARCHITECTURE.md#streaming-to-video)). When the app starts
relying on such behaviour, make the fake enforce it too.

## Manual testing in a browser

Real playback, codecs and peer connectivity can only be checked in a real
browser. Until 4.5 adds a Playwright test, check them by hand:

1. `npm run build && npm start`, then open `http://localhost:3000`. Use
   `npm run dev` for quick UI work, but check streaming against the built
   app too, since service worker scope and asset paths differ.
2. Use a torrent that has WebRTC seeders. The browser client can't reach
   ordinary BitTorrent peers (see
   [ARCHITECTURE.md](ARCHITECTURE.md#peers)), so most public torrents show
   zero peers. WebTorrent's own demo torrent, Sintel
   (`https://webtorrent.io/torrents/sintel.torrent`), is seeded over WebRTC.
3. For a torrent you control, seed it with a WebRTC-capable client
   (WebTorrent Desktop, or `webtorrent-hybrid`) and announce it to a
   `wss://` tracker.
4. Check the browser console for errors, and for M4 steps watch the
   `<video>` element's `waiting` and `stalled` events.
5. Service workers need a secure context. `http://localhost` qualifies,
   LAN URLs don't, so streaming tests from another device need HTTPS.

Only use content you have the right to share: open-licensed films such as
Sintel or Big Buck Bunny, or files you made yourself.

Record what you checked by hand in the pull request description.
