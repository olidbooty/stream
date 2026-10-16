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

For frontend work, `npm run dev` starts the Vite dev server with hot reload.

## Layout

```
client/          frontend source (Vite root)
server/app.ts    Express app (createApp), no port binding
server/index.ts  entry point: binds HOST/PORT
public/          build output served by Express (gitignored)
test/mocks/      shared test doubles, e.g. the WebTorrent fake
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
