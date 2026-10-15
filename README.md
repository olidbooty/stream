# stream

Stream video from torrents in the browser using WebTorrent.

## Requirements

Node.js 20.19+ (22 recommended, see `.nvmrc`).

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
server/app.js    Express app (createApp), no port binding
server/index.js  entry point: binds HOST/PORT
public/          build output served by Express (gitignored)
test/mocks/      shared test doubles, e.g. the WebTorrent fake
```

## Scripts

| Script               | What it does                       |
| -------------------- | ---------------------------------- |
| `npm start`          | Run the Express server             |
| `npm run dev`        | Vite dev server                    |
| `npm run build`      | Build the frontend into `public/`  |
| `npm test`           | Run the test suite once            |
| `npm run test:watch` | Run tests in watch mode            |
| `npm run coverage`   | Run tests with coverage            |

See [TESTING.md](TESTING.md) for test conventions.
