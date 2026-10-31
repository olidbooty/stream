import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Writes through a temporary file and rename(), so a crash mid-write leaves
// the previous version rather than half a file. Creates the directory if it
// is missing.
export async function writeFileAtomically(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, data);
  await rename(temporary, path);
}
