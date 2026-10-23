# stream

Browser video streaming from torrents with WebTorrent. Read these before changing code:

- [README.md](README.md): setup, scripts, layout, code style
- [ARCHITECTURE.md](ARCHITECTURE.md): design and WebTorrent constraints (server-side client, peers, streaming)
- [TESTING.md](TESTING.md): test layout, the WebTorrent fake, manual browser checks
- [PROJECT_MANAGEMENT.md](PROJECT_MANAGEMENT.md): steps, commit prefixes, PR checklist, decisions

Before pushing, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. There is no CI on pull requests; a workflow on `main` runs the checks before publishing the component gallery.
