# stream

Stream video from torrents to any browser on your network. A WebTorrent client
in the Node server joins BitTorrent (TCP, uTP, DHT) and WebRTC swarms and
streams files to the page over HTTP.

## Requirements

Node.js 24 LTS or newer (see `.nvmrc`).

## Getting started

```sh
npm install
npm run build   # bundle client/ into public/
npm start       # serve public/ on http://localhost:3000
```

The server binds to `0.0.0.0`, so other devices on your network can open the
LAN URLs it prints at startup. Set `HOST=127.0.0.1` to keep it local, or
`PORT` to change the port.

`npm start` also starts the WebTorrent client, which joins swarms over TCP,
uTP, the DHT and WebRTC. It is configured with environment variables:

| Variable       | Default       | What it sets |
| -------------- | ------------- | ------------ |
| `PORT`         | `3000`        | HTTP port for the app |
| `HOST`         | `0.0.0.0`     | HTTP bind address. The peer port always listens on all interfaces |
| `DOWNLOAD_DIR` | `./downloads` | Where torrent files are stored (gitignored). Created at startup if missing; must be writable. Removing a torrent deletes its files |
| `TORRENT_PORT` | `0` (random)  | TCP/uTP port for incoming peers |
| `DHT_PORT`     | `0` (random)  | UDP port for the DHT |

The peer port is printed at startup and returned by `GET /api/client`.
`Ctrl+C` destroys the client cleanly so it stops announcing to the swarm.

WebRTC and uTP use native modules (`node-datachannel`, `utp-native`) that
install prebuilt binaries. On a platform without one, such as Linux on ARM,
npm needs a C++ toolchain to build them; if `utp-native` fails, WebTorrent
falls back to TCP only.

For frontend work, `npm run dev` starts the Vite dev server with hot reload.

## API

There is no UI for torrents yet (2.5), so use the API directly:

| Request | What it does |
| ------- | ------------ |
| `GET /api/torrents` | List torrents: info hash, name, magnet link, `ready` (metadata known), progress, peers, speeds |
| `POST /api/torrents` with JSON `{"magnet": "magnet:?xt=urn:btih:..."}` | Add a magnet link. `201` with the torrent, `400` if it isn't a BitTorrent magnet, `409` if it's already added |
| `POST /api/torrents` with a `.torrent` file as the body, `Content-Type: application/x-bittorrent` | Add a torrent file, up to 10 MiB (`413` above that) |
| `DELETE /api/torrents/:infoHash` | Remove a torrent and delete its files. `204`, or `404` if it isn't there |
| `GET /api/client` | Whether the torrent client is listening, its peer port and total speeds |

Errors are JSON: `{"error": "..."}`.

```sh
curl -X POST localhost:3000/api/torrents -H 'Content-Type: application/json' \
  -d '{"magnet": "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel"}'
curl -X POST localhost:3000/api/torrents -H 'Content-Type: application/x-bittorrent' \
  --data-binary @sintel.torrent
```

Torrents live in memory: after a restart the list is empty, but their files
stay in `DOWNLOAD_DIR` (see Risks & Decisions #13).

## Layout

```
client/                   frontend source (Vite root)
server/app.ts             Express app (createApp), no port binding
server/index.ts           entry point: creates the torrent client, binds HOST/PORT
server/torrent-client.ts  WebTorrent client setup, config from env vars
server/torrents-api.ts    /api/torrents routes
server/magnet.ts          magnet link validation
public/                   build output served by Express (gitignored)
downloads/                default DOWNLOAD_DIR (gitignored)
test/mocks/               shared test doubles, e.g. the WebTorrent fake
```

## Scripts

| Script               | What it does                       |
| -------------------- | ---------------------------------- |
| `npm start`          | Run the Express server (via tsx)   |
| `npm run dev`        | Vite dev server                    |
| `npm run build`      | Build the frontend into `public/`  |
| `npm run typecheck`  | Type-check everything with `tsc`   |
| `npm test`           | Run the test suite once            |
| `npm run test:watch` | Run tests in watch mode            |
| `npm run coverage`   | Run tests with coverage            |

The code is TypeScript. `tsconfig.json` only type-checks (`noEmit`): Vite and
Vitest transpile it themselves and `tsx` runs the server, so there is no
compile step. Relative imports keep the `.js` extension (`./app.js` resolves
to `app.ts`), as Node's ESM resolution expects.

## Code style

There is no linter or formatter yet, so match the existing code: 2-space
indent, single quotes, semicolons, trailing commas in multi-line literals,
and `import type` for type-only imports (`verbatimModuleSyntax` enforces it).
Comments explain why, not what.

See [TESTING.md](TESTING.md) for test conventions.
See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and
the WebTorrent constraints that shape the design.
See [PROJECT_MANAGEMENT.md](PROJECT_MANAGEMENT.md) for the project tracker and
how work is planned.
