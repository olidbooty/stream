import express, { type ErrorRequestHandler, Router } from 'express';
import type { DiskLimit } from './disk-limit.js';
import {
  parseSettings,
  type Settings,
  type SettingsStore,
} from './settings.js';

export interface SettingsRouterOptions {
  settings: SettingsStore;
  disk: DiskLimit;
}

// What GET and PUT /api/settings answer: the settings, and how much of the
// limit the torrents use now.
export interface SettingsInfo extends Settings {
  diskUsed: number;
  diskLimitReached: boolean;
}

// Decision #36: the settings form on the page. PUT takes any of the settings'
// keys and keeps the rest; it applies at once and is saved for the next start.
export function settingsRouter({
  settings,
  disk,
}: SettingsRouterOptions): Router {
  const router = Router();

  const info = (): SettingsInfo => {
    const usage = disk.usage();
    return {
      ...settings.get(),
      diskUsed: usage.used,
      diskLimitReached: usage.reached,
    };
  };

  router.get('/api/settings', (_req, res) => {
    res.json(info());
  });

  router.put('/api/settings', express.json(), async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Send the settings as JSON' });
    }
    const next = parseSettings(req.body, settings.get());
    if (!next) {
      return res.status(400).json({
        error:
          'diskLimit must be a whole number of bytes above 0, or null for no limit',
      });
    }
    await settings.set(next);
    disk.check();
    res.json(info());
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json({ error: 'The request body is not valid JSON' });
    }
    next(err);
  };
  router.use(onError);

  return router;
}
