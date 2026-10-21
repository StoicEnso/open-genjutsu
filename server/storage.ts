import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Asset, Job, JobManifest, Settings, WorkflowGraph, WorkflowPack } from '../shared/types.js';

export interface StoredAsset { asset: Asset; filename: string; thumbnail?: string; sha256: string }
export interface StoredJob { job: Job; workflow: WorkflowPack; graph: WorkflowGraph; settings: Settings; manifest: JobManifest; submissionAttempted?: boolean; cancelRequested?: boolean; knownRemoteTerminalFailure?: boolean }
interface State { version: 1; settings: Settings; assets: Record<string, StoredAsset>; workflows: Record<string, WorkflowPack>; jobs: Record<string, StoredJob> }
export const DEFAULT_SETTINGS: Settings = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
export function defaultDataDir(): string {
  if (process.env.OPEN_GENJUTSU_DATA_DIR) return path.resolve(process.env.OPEN_GENJUTSU_DATA_DIR);
  if (platform() === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Open Genjutsu');
  if (platform() === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Open Genjutsu');
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'open-genjutsu');
}
export class Store {
  private state!: State;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {}
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(this.assetDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8')) as State;
      if (this.state.version !== 1 || !this.state.assets || !this.state.workflows || !this.state.jobs || !this.state.settings) throw new Error('Unsupported local state file. Preserve it before recovery.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, settings: { ...DEFAULT_SETTINGS }, assets: {}, workflows: {}, jobs: {} };
      await this.update(() => undefined);
    }
    // These are only uploads/downloads that had never become durable assets.
    for (const entry of await readdir(this.tempDir)) {
      if (!/^[a-f0-9-]+\.part$/.test(entry)) continue;
      // Keep abandoned files for the owner rather than delete potential evidence.
    }
  }
  get assetDir(): string { return path.join(this.dir, 'assets'); }
  get tempDir(): string { return path.join(this.dir, 'tmp'); }
  snapshot(): State { return structuredClone(this.state); }
  async update<T>(mutate: (state: State) => T): Promise<T> {
    const task = this.pending.then(async () => {
      const next = structuredClone(this.state);
      const value = mutate(next);
      const temporary = path.join(this.dir, `.state-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, path.join(this.dir, 'state.json'));
      this.state = next;
      return value;
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
}
