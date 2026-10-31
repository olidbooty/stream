import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from './atomic-file.js';

// Decision #36: settings the user changes on the page are kept in one JSON
// file in DOWNLOAD_DIR, next to the saved torrents (Decision #13), so they
// stay with the downloads they apply to.
export const SETTINGS_FILE = '.settings.json';

// Decimal, as the page shows sizes (formatBytes).
export const GB = 1_000_000_000;

export interface Settings {
  // Most bytes the torrents may keep in DOWNLOAD_DIR; null for no limit.
  diskLimit: number | null;
}

export type SettingsEnv = Partial<Record<'DISK_LIMIT_GB', string>>;

// What applies until a setting is saved: DISK_LIMIT_GB, or no limit.
export function defaultSettings(env: SettingsEnv = process.env): Settings {
  const value = env.DISK_LIMIT_GB;
  if (value === undefined || value === '' || value === '0') {
    return { diskLimit: null };
  }
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb <= 0) {
    throw new Error(
      `DISK_LIMIT_GB must be a number of gigabytes above 0, got "${value}"`,
    );
  }
  return { diskLimit: Math.round(gb * GB) };
}

function isDiskLimit(value: unknown): value is Settings['diskLimit'] {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

// Checks a PUT body or the saved file: each known key must be valid, and keys
// left out keep their current value. Returns null if anything is wrong.
export function parseSettings(
  value: unknown,
  current: Settings,
): Settings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { diskLimit = current.diskLimit } = value as Record<string, unknown>;
  if (!isDiskLimit(diskLimit)) return null;
  return { diskLimit };
}

// Saves are queued, so two quick changes land in the order they were made.
export class SettingsStore {
  readonly path: string;
  private current: Settings;
  private pending: Promise<void> = Promise.resolve();

  constructor(downloadDir: string, defaults: Settings = { diskLimit: null }) {
    this.path = join(downloadDir, SETTINGS_FILE);
    this.current = defaults;
  }

  get(): Settings {
    return this.current;
  }

  // Reads the saved file over the defaults. A missing file is normal; an
  // unreadable one is logged and left on disk for a person to look at.
  async load(): Promise<Settings> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.current;
      throw err;
    }
    let parsed: Settings | null = null;
    try {
      parsed = parseSettings(JSON.parse(text), this.current);
    } catch {
      // Not JSON; reported below.
    }
    if (parsed) this.current = parsed;
    else console.error(`ignoring unreadable settings in ${this.path}`);
    return this.current;
  }

  // Takes effect at once; the write follows. A failed write is logged and the
  // setting still applies until the next restart.
  set(settings: Settings): Promise<void> {
    this.current = settings;
    const text = `${JSON.stringify(settings, null, 2)}\n`;
    this.pending = this.pending
      .then(() => writeFileAtomically(this.path, text))
      .catch((err) => {
        console.error('saving settings failed:', err);
      });
    return this.pending;
  }

  // Resolves once every save started so far has finished.
  flush(): Promise<void> {
    return this.pending;
  }
}
