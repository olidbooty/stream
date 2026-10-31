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
  // Whether the disk limit applies. Kept apart from the number, so turning
  // the limit off and on again keeps it.
  diskLimitOn: boolean;
  // Most bytes the torrents may keep in DOWNLOAD_DIR while the limit is on;
  // null if none was ever set.
  diskLimit: number | null;
  // Step 3.12: whether the DLNA server lists the torrents in VLC's Local
  // network.
  dlnaOn: boolean;
}

export const NO_SETTINGS: Settings = {
  diskLimitOn: false,
  diskLimit: null,
  dlnaOn: true,
};

// The limit DiskLimit enforces: the number while it is on, otherwise none.
export function activeDiskLimit({
  diskLimitOn,
  diskLimit,
}: Settings): number | null {
  return diskLimitOn ? diskLimit : null;
}

export type SettingsEnv = Partial<Record<'DISK_LIMIT_GB' | 'DLNA', string>>;

// DLNA=0 starts with the DLNA server off; it is on by default.
export function dlnaEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Error(`DLNA must be 1 or 0, got "${value}"`);
}

// What applies until a setting is saved: DISK_LIMIT_GB, or no limit, and
// DLNA.
export function defaultSettings(env: SettingsEnv = process.env): Settings {
  const dlnaOn = dlnaEnabled(env.DLNA);
  const value = env.DISK_LIMIT_GB;
  if (value === undefined || value === '' || value === '0') {
    return { ...NO_SETTINGS, dlnaOn };
  }
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb <= 0) {
    throw new Error(
      `DISK_LIMIT_GB must be a number of gigabytes above 0, got "${value}"`,
    );
  }
  return { diskLimitOn: true, diskLimit: Math.round(gb * GB), dlnaOn };
}

function isDiskLimit(value: unknown): value is Settings['diskLimit'] {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

// Checks a PUT body or the saved file: each known key must be valid, and keys
// left out keep their current value. Returns null if anything is wrong,
// including turning the limit on with no number. A diskLimit sent without
// diskLimitOn, as before the checkbox, turns the limit on for a number and
// off for null.
export function parseSettings(
  value: unknown,
  current: Settings,
): Settings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  const diskLimit =
    'diskLimit' in fields ? fields.diskLimit : current.diskLimit;
  if (!isDiskLimit(diskLimit)) return null;
  let diskLimitOn: unknown = fields.diskLimitOn;
  if (diskLimitOn === undefined) {
    diskLimitOn =
      'diskLimit' in fields ? diskLimit !== null : current.diskLimitOn;
  }
  if (typeof diskLimitOn !== 'boolean') return null;
  if (diskLimitOn && diskLimit === null) return null;
  const dlnaOn = 'dlnaOn' in fields ? fields.dlnaOn : current.dlnaOn;
  if (typeof dlnaOn !== 'boolean') return null;
  // Turning it off with null keeps the number for when it is turned on.
  return {
    diskLimitOn,
    diskLimit: diskLimit ?? (diskLimitOn ? null : current.diskLimit),
    dlnaOn,
  };
}

// Saves are queued, so two quick changes land in the order they were made.
export class SettingsStore {
  readonly path: string;
  private current: Settings;
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners: ((settings: Settings) => void)[] = [];

  constructor(downloadDir: string, defaults: Settings = NO_SETTINGS) {
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
    for (const listener of this.listeners) listener(settings);
    const text = `${JSON.stringify(settings, null, 2)}\n`;
    this.pending = this.pending
      .then(() => writeFileAtomically(this.path, text))
      .catch((err) => {
        console.error('saving settings failed:', err);
      });
    return this.pending;
  }

  // Called with the new settings each time they are set, e.g. to start or
  // stop the DLNA server.
  onChange(listener: (settings: Settings) => void): void {
    this.listeners.push(listener);
  }

  // Resolves once every save started so far has finished.
  flush(): Promise<void> {
    return this.pending;
  }
}
