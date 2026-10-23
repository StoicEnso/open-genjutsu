import express, { type Express, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Server } from 'node:http';
import { Backend } from './comfy.js';
import { streamBundle } from './bundles.js';
import { HttpError, messageOf } from './errors.js';
import { Jobs } from './jobs.js';
import { MAX_FILE_BYTES, Media } from './media.js';
import { localUrl, requestGuard, type FetchLike } from './security.js';
import { defaultDataDir, Store } from './storage.js';
import { idSchema, jobSchema, rerunSchema, parseWorkflow } from './workflows.js';
import { acquireWorkspace } from './workspace.js';
import type { WorkflowPack } from '../shared/types.js';

export interface AppOptions {
  dataDir?: string;
  staticDir?: string;
  workflowsDir?: string;
  allowedOrigins?: string[];
  /** Protocol tests inject only HTTP transport; the real Comfy SDK still runs. */
  transport?: FetchLike;
  pollMs?: number;
  binaries?: { ffmpeg?: string; ffprobe?: string };
}
export async function createApp(options: AppOptions = {}, deferRecovery = false): Promise<Express> {
  const store = new Store(options.dataDir || defaultDataDir());
  let jobs: Jobs | undefined;
  let compromised = false;
  let closed = false;
  let serviceClosing: Promise<void> | undefined;
  const release = await acquireWorkspace(store.dir, error => {
    compromised = true;
    console.error('[open-genjutsu] Workspace lock lost; stopping this instance:', messageOf(error));
    void jobs?.close().catch(failure => console.error('[open-genjutsu]', messageOf(failure)));
  });
  const close = (): Promise<void> => {
    if (serviceClosing) return serviceClosing;
    closed = true;
    serviceClosing = (async () => { try { await jobs?.close(); } finally { await release().catch(error => { if (!compromised) throw error; }); } })();
    return serviceClosing;
  };
  try {
  await store.init();
  const settings = store.snapshot().settings;
  localUrl(settings.comfyUrl); localUrl(settings.proxyUrl);
  const workflowsDir = options.workflowsDir || fileURLToPath(new URL('../workflows', import.meta.url));
  let files: string[] = [];
  try { files = await readdir(workflowsDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const file of files.filter(file => file.endsWith('.json')).sort()) {
    const parsed = parseWorkflow(JSON.parse(await readFile(path.join(workflowsDir, file), 'utf8')));
    if (!parsed.id) throw new Error(`Bundled workflow ${file} needs a stable ID.`);
    if (!store.snapshot().workflows[parsed.id]) {
      const now = new Date().toISOString();
      await store.update(state => { state.workflows[parsed.id!] = { ...parsed, id: parsed.id!, createdAt: now, updatedAt: now }; });
    }
  }
  const media = new Media(store, options.binaries);
  const backend = new Backend(options.transport);
  jobs = new Jobs(store, media, backend, options.pollMs);
  const queue = jobs;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.use(requestGuard(options.allowedOrigins));
  app.use((_req, _res, next) => next(compromised || closed ? new HttpError(503, 'workspace_unavailable', 'This instance no longer owns its workspace. Close it and reopen the application before making changes.') : undefined));
  app.use(express.json({ limit: '2mb', strict: true }));
  app.locals.services = { store, media, backend, jobs: queue, close, start: () => { if (!compromised && !closed) queue.start(); } };
  const routeId = (value: unknown): string => idSchema.parse(value);
  app.get('/api/health', async (_req, res) => { res.json({ ok: true, app: 'Open Genjutsu', version: '0.2.0', mode: 'keyless-local', integration: '@comfyorg/sdk@0.5.0', media: await media.status(), limits: { uploadBytes: MAX_FILE_BYTES, sourceSeconds: 30, previewFrames: 49, previewFps: { min: 8, max: 30, default: 'workflow' }, previewMaxDimension: 480 } }); });
  app.get('/api/settings', (_req, res) => { res.json(store.snapshot().settings); });
  app.put('/api/settings', async (req, res) => {
    const input = z.object({ comfyUrl: z.string().max(200), proxyUrl: z.string().max(200) }).strict().parse(req.body);
    const next = { comfyUrl: localUrl(input.comfyUrl), proxyUrl: localUrl(input.proxyUrl) };
    await store.update(state => { state.settings = next; });
    res.json(next);
  });
  app.get('/api/backend/status', async (req, res) => {
    const snapshot = store.snapshot();
    const id = req.query.workflowId === undefined ? undefined : routeId(req.query.workflowId);
    const jobId = req.query.jobId === undefined ? undefined : routeId(req.query.jobId);
    if (id && jobId) throw new HttpError(400, 'ambiguous_status', 'Choose a workflow ID or a job ID, not both.');
    const saved = jobId ? queue.get(jobId) : undefined;
    const workflow = saved?.workflow || (id ? snapshot.workflows[id] : undefined);
    if (id && !workflow) throw new HttpError(404, 'workflow_not_found', 'No workflow has that ID.');
    const [status, tools] = await Promise.all([backend.status(saved?.settings || snapshot.settings, workflow), media.status()]);
    status.media = tools; status.ready = status.ready && tools.available;
    if (!tools.available) status.error = [status.error, tools.ffmpeg.error, tools.ffprobe.error].filter(Boolean).join(' ');
    res.json(status);
  });
  const upload = multer({ storage: multer.diskStorage({ destination: store.tempDir, filename: (_req, _file, cb) => cb(null, `${randomUUID()}.part`) }), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1 }, fileFilter: (_req, file, cb) => {
    if (!['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime'].includes(file.mimetype)) cb(new HttpError(415, 'unsupported_media', 'Upload a PNG/JPEG/WebP image or MP4/WebM/MOV video.'));
    else cb(null, true);
  } });
  app.post('/api/assets', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'missing_file', 'Choose a file to upload.');
    const record = await media.adopt(req.file.path, req.file.originalname, req.file.mimetype.startsWith('image/') ? 'image' : 'video');
    res.status(201).json(record.asset);
  });
  app.get('/api/assets', (_req, res) => { res.json(Object.values(store.snapshot().assets).map(record => record.asset).sort((a,b) => b.createdAt.localeCompare(a.createdAt))); });
  app.get('/api/assets/:id/file', (req, res, next) => {
    const record = store.snapshot().assets[routeId(req.params.id)];
    if (!record) throw new HttpError(404, 'asset_not_found', 'No local asset has that ID.');
    if (!path.resolve(record.filename).startsWith(path.resolve(store.assetDir) + path.sep)) throw new HttpError(500, 'invalid_asset_record', 'The local asset record is invalid.');
    res.type(record.asset.mimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(record.asset.name)}`);
    res.sendFile(path.basename(record.filename), { root: store.assetDir, dotfiles: 'deny' }, error => { if (error) next(error); });
  });
  app.get('/api/assets/:id/thumbnail', (req, res, next) => {
    const record = store.snapshot().assets[routeId(req.params.id)];
    if (!record?.thumbnail) throw new HttpError(404, 'thumbnail_not_found', 'No thumbnail is available.');
    if (!path.resolve(record.thumbnail).startsWith(path.resolve(store.assetDir) + path.sep)) throw new HttpError(500, 'invalid_asset_record', 'The local thumbnail record is invalid.');
    res.type('image/jpeg').sendFile(path.basename(record.thumbnail), { root: store.assetDir, dotfiles: 'deny' }, error => { if (error) next(error); });
  });
  app.get('/api/workflows', (_req, res) => { res.json(Object.values(store.snapshot().workflows).sort((a,b) => a.name.localeCompare(b.name))); });
  const saveWorkflow = async (body: unknown, forcedId?: string): Promise<WorkflowPack> => {
    const data = parseWorkflow(body);
    const id = forcedId || data.id || randomUUID();
    const existing = store.snapshot().workflows[id];
    const now = new Date().toISOString();
    const result = { ...data, id, createdAt: existing?.createdAt || now, updatedAt: now };
    await store.update(state => { state.workflows[id] = result; });
    return result;
  };
  app.post('/api/workflows/import', async (req, res) => { res.status(201).json(await saveWorkflow(req.body)); });
  app.put('/api/workflows/:id', async (req, res) => {
    const id = routeId(req.params.id);
    if (!store.snapshot().workflows[id]) throw new HttpError(404, 'workflow_not_found', 'No workflow has that ID.');
    res.json(await saveWorkflow(req.body, id));
  });
  app.post('/api/jobs', async (req, res) => { res.status(202).json(await queue.create(jobSchema.parse(req.body))); });
  app.get('/api/jobs', (_req, res) => { res.json(Object.values(store.snapshot().jobs).map(record => record.job).sort((a,b) => b.createdAt.localeCompare(a.createdAt))); });
  app.get('/api/jobs/:id', (req, res) => { res.json(queue.get(routeId(req.params.id)).job); });
  app.post('/api/jobs/:id/cancel', async (req, res) => { res.json(await queue.cancel(routeId(req.params.id))); });
  app.post('/api/jobs/:id/resume', async (req, res) => { res.json(await queue.resume(routeId(req.params.id))); });
  app.post('/api/jobs/:id/rerun', async (req, res) => { res.status(202).json(await queue.rerun(routeId(req.params.id), rerunSchema.parse(req.body))); });
  app.get('/api/jobs/:id/manifest', (req, res) => { res.json(queue.get(routeId(req.params.id)).manifest); });
  app.get('/api/jobs/:id/workflow', (req, res) => { res.json(queue.get(routeId(req.params.id)).graph); });
  app.get('/api/jobs/:id/bundle', async (req, res) => { await streamBundle(store, queue.get(routeId(req.params.id)), res); });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'No API route matches this request.')));
  if (options.staticDir) {
    const staticDir = path.resolve(options.staticDir);
    app.use(express.static(staticDir, { index: 'index.html', dotfiles: 'deny', fallthrough: true }));
    app.get('/{*path}', async (_req, res, next) => {
      try { await stat(path.join(staticDir, 'index.html')); res.sendFile(path.join(staticDir, 'index.html')); } catch { next(new HttpError(404, 'frontend_not_built', 'Build the frontend first, or run npm run dev.')); }
    });
  }
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof ZodError) { res.status(400).json({ error: { code: 'validation_error', message: 'Check the submitted fields.', details: error.issues } }); return; }
    if (error instanceof multer.MulterError) { res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 200MB or smaller.' : 'Upload exactly one file in the file field.' } }); return; }
    const status = error instanceof HttpError ? error.status : typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: { code: error instanceof HttpError ? error.code : 'server_error', message: status === 500 ? 'The local operation failed. Check the application terminal for diagnostics.' : messageOf(error), details: error instanceof HttpError ? error.details : undefined } });
    if (status === 500) console.error('[open-genjutsu]', messageOf(error));
  };
  app.use(handleError);
  if (compromised) throw new HttpError(503, 'workspace_unavailable', 'The workspace lock was lost during startup.');
  await queue.init(!deferRecovery);
  return app;
  } catch (error) { await close(); throw error; }
}
export interface StartOptions extends AppOptions { port?: number }
export async function startServer(options: StartOptions = {}): Promise<{ port: number; close: () => Promise<void>; app: Express; server: Server }> {
  const port = options.port ?? Number(process.env.OPEN_GENJUTSU_PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('OPEN_GENJUTSU_PORT must be a valid port.');
  const app = await createApp(options, true);
  try {
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, '127.0.0.1');
    listening.once('error', reject);
    listening.once('listening', () => { listening.off('error', reject); resolve(listening); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine the local server port.');
  app.locals.services.start();
  let closing: Promise<void> | undefined;
  return { app, server, port: address.port, close: () => closing ||= (async () => {
    // Keep the workspace lock until HTTP handlers have drained, so a final
    // upload/export cannot race a newly opened instance's state file.
    try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { await app.locals.services.close(); }
  })() };
  } catch (error) { await app.locals.services.close(); throw error; }
}
