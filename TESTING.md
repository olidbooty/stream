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

Real playback, codecs and peer connectivity can only be checked in a real
browser.
