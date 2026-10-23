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
    // The API lives in the Express server, so run `npm start` alongside
    // `npm run dev`. Server-sent events pass through unbuffered.
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 1234}`,
    },
  },
});
