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

The server only serves the built frontend. All torrent work is planned to
happen in the browser (M3 onwards). That choice is still open; see
[Open decisions](#open-decisions).

## WebTorrent in the browser

Things checked against the installed `webtorrent@3` that the M3 and M4 steps
have to deal with.

### Bundling

`import WebTorrent from 'webtorrent'` builds, but Vite warns that the Node
built-ins `events` and `path` (imported by WebTorrent's dependencies) are
"externalized for browser compatibility". The build succeeds, but the bundle
will fail at runtime when that code runs. Step 2.1 has to pick one of these
and record the choice here:

- Import the prebuilt browser bundle, `webtorrent/dist/webtorrent.min.js`.
  It needs no polyfills but has no types, so add a local declaration that
  re-exports the `@types/webtorrent` types for that path.
- Keep `import 'webtorrent'` and add browser polyfills (`events`, `path`) as
  dependencies, aliased in `vite.config.ts`.

Whichever is chosen, test files still `vi.mock('webtorrent', ...)` (see
[TESTING.md](TESTING.md#mocking-webtorrent)), so the mock path must match the
import path used in `client/src`.

### Peers

The browser client can only connect to WebRTC peers (other WebTorrent
clients, or hybrid clients such as WebTorrent Desktop), and only finds them
through WebSocket (`wss://`) trackers. It cannot reach ordinary TCP/UDP
BitTorrent peers or the DHT. Most public torrents therefore show zero usable
peers in the browser. This is Risk & Decision #1, and it has to be settled
before 2.1.

### Streaming to `<video>`

In WebTorrent 2 and later, `file.streamTo(video)` only sets `video.src` to a
URL served by a service worker. Before any file can be streamed:

1. Serve WebTorrent's worker, `node_modules/webtorrent/dist/sw.min.js`, from
   the site root. Its scope decides which URLs it can serve.
2. Register it, then hand the registration to the client:
   ```ts
   const registration = await navigator.serviceWorker.register('/sw.min.js', { scope: '/' });
   await navigator.serviceWorker.ready;
   client.createServer({ controller: registration });
   ```
3. Only then call `file.streamTo(video)`. Without a server it throws
   `No server created`.

`file.appendTo` and `file.renderTo` (named in the original plan for 3.3) no
longer exist. The options are `streamTo` (above) or `file.blob()` for small
files.

Service workers need a secure context. `http://localhost` counts, but the LAN
URLs printed by `npm start` (`http://192.168.x.x:3000`) do not, so streaming
from another device needs HTTPS. Plan for this before 3.3.

The shared fake in `test/mocks/webtorrent.ts` does not model `createServer`
or `streamURL` yet. Its `streamTo` just records the element. Extend it when
3.3 starts using them.

### Storage

The chunk store is passed when a torrent is added (`store` option). In the
browser it defaults to `fsa-chunk-store` (the origin private file system,
via the File System Access API) where the browser supports it, and falls back
to memory where it doesn't, which can exhaust memory on large files.
Settle Risk & Decision #4 (chunk store) during 2.1, since the client and
`add()` calls are written there.

## Open decisions

These live in the Risks & Decisions tab of the
[project tracker](PROJECT_MANAGEMENT.md#where-things-live). When one is
decided, update the tab and summarise the outcome in this file, so the reason
for the design stays next to the code.

| # | Decision | Needed by |
| - | -------- | --------- |
| 1 | Browser-side WebTorrent vs. a Node-side client streaming over HTTP | 2.1 |
| 2 | Whether explicit sequential piece selection is needed | 3.2 |
| 3 | Whether to list `.mkv` and similar with a warning | 3.1 |
| 4 | Chunk store / storage strategy | 2.1 |
| 5 | Run the codec audit (4.1) early on test files | 3.1 |
