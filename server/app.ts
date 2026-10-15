import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export interface AppOptions {
  staticDir?: string;
}

// Build the Express app without binding a port, so tests can drive it with supertest.
export function createApp({ staticDir = DEFAULT_STATIC_DIR }: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.static(staticDir));

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}
