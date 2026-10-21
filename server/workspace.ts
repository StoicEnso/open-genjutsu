import lockfile from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';

/** An atomic directory lock with a heartbeat, shared by CLI and Electron. */
export async function acquireWorkspace(dir: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const release = await lockfile.lock(dir, { lockfilePath: path.join(dir, '.workspace.lock'), stale: 30000, update: 10000, retries: 0, onCompromised });
    let released = false;
    return async () => { if (released) return; released = true; await release(); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new HttpError(409, 'workspace_in_use', 'This workspace is already open in another Open Genjutsu instance. Close that instance, or choose a different OPEN_GENJUTSU_DATA_DIR. Your files were not changed.');
    throw error;
  }
}
