import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: {
    // Express serves public/ (see server/app.ts).
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    // Reachable from other devices on the LAN, matching the Express server.
    host: true,
  },
});
