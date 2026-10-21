/** Protocol/integration tests only. No model generation or quality claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { request } from 'node:http';
import { discoverMediaBinaries } from '../server/media.js';
import { startServer } from '../server/app.js';
import { guardedFetch } from '../server/security.js';
import { parseWorkflow, auditWorkflow } from '../server/workflows.js';
import type { Asset, Job, WorkflowImport, WorkflowGraph } from '../shared/types.js';

const exec = promisify(execFile);
const binaries = { ffmpeg: process.env.OPEN_GENJUTSU_TEST_FFMPEG, ffprobe: process.env.OPEN_GENJUTSU_TEST_FFPROBE };
const graph: WorkflowGraph = {
  '1': { class_type: 'LoadVideo', inputs: { file: 'source.mp4' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
  '3': { class_type: 'ImageScale', inputs: { image: ['2',0], width: 64, height: 64, upscale_method: 'nearest-exact', crop: 'disabled' } },
  '4': { class_type: 'SaveImage', inputs: { images: ['3',0], filename_prefix: 'protocol-output' } },
};
const pack: WorkflowImport = { id: 'protocol-fixture', name: 'Protocol fixture (not a generative model)', description: 'A transport fixture only.', graph, bindings: { sourceVideo: { nodeId: '1', input: 'file' }, referenceImage: { nodeId: '2', input: 'image' }, width: { nodeId: '3', input: 'width' }, height: { nodeId: '3', input: 'height' } }, outputNodeIds: ['4'], license: 'MIT' };
function fakeBackend(image: Uint8Array, hold = false, unknownOutputSize = false, outputName = 'protocol-output.png') {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const submissions: { workflow: WorkflowGraph; extra_data?: unknown }[] = [];
  const remoteJobs = new Map<string, { polls: number; canceled: boolean; failed?: boolean }>();
  const objectInfo = Object.fromEntries(Object.values(graph).map(node => [node.class_type, { python_module: 'nodes', api_node: false, input: { required: {} } }]));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const model = (id: string) => {
    const state = remoteJobs.get(id)!;
    const succeeded = !hold && state.polls >= 2;
    return { id, status: state.canceled ? 'canceled' : state.failed ? 'failed' : succeeded ? 'succeeded' : 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(), completed_at: succeeded ? new Date().toISOString() : null, expires_at: new Date(Date.now()+86400000).toISOString(), queue_position: null, progress: { value: succeeded ? 1 : 0.4, nodes_done: 1, nodes_total: 4 }, error: state.failed ? { code: 'execution_error', message: 'Protocol fixture: known model failure.' } : null, outputs: succeeded ? [{ id: 'output-asset', node_id: '4', name: outputName, type: 'image', content_type: outputName.endsWith('.mp4') ? 'video/mp4' : 'image/png', size_bytes: unknownOutputSize ? 0 : image.byteLength, hash: null, url: '/api/v2/assets/output-asset/content', url_expires_at: new Date(Date.now()+86400000).toISOString() }] : [], urls: { self: `/api/v2/jobs/${id}`, cancel: `/api/v2/jobs/${id}/cancel`, events: `/api/v2/jobs/${id}/events` } };
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method || 'GET';
    calls.push({ method, url: url.href, auth: new Headers(init?.headers).get('authorization') });
    assert.equal(url.hostname, '127.0.0.1', 'transport must never target a paid/provider host');
    if (url.pathname === '/object_info') return json(objectInfo);
    if (url.pathname === '/api/v2/health') return json({ status: 'ok' });
    if (url.pathname.startsWith('/api/v2/assets/by-hash/')) return new Response(null, { status: 404 });
    if (url.pathname === '/api/v2/assets' && method === 'POST') {
      assert.ok(init?.body instanceof FormData, 'official SDK must upload multipart assets');
      const form = init.body as FormData;
      assert.ok(form.get('file') instanceof Blob);
      const id = randomUUID();
      return json({ id, hash: form.get('expected_hash'), content_type: form.get('content_type'), file_path: form.get('file_path'), size_bytes: (form.get('file') as Blob).size, created_new: true, created_at: new Date().toISOString(), url: `/api/v2/assets/${id}/content`, url_expires_at: new Date(Date.now()+86400000).toISOString() }, 201);
    }
    if (url.pathname === '/api/v2/jobs' && method === 'POST') {
      const payload = JSON.parse(String(init?.body)); submissions.push(payload);
      const id = randomUUID(); remoteJobs.set(id, { polls: 0, canceled: false });
      return json(model(id), 201);
    }
    const match = url.pathname.match(/^\/api\/v2\/jobs\/([^/]+)(\/cancel)?$/);
    if (match) {
      if (!remoteJobs.has(match[1]!)) return json({ error: { code: 'not_found', message: 'missing' } }, 404);
      if (match[2]) remoteJobs.get(match[1]!)!.canceled = true; else remoteJobs.get(match[1]!)!.polls++;
      return json(model(match[1]!));
    }
    if (url.pathname === '/api/v2/assets/output-asset/content') return new Response(image as BodyInit, { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected protocol request: ${method} ${url.href}`);
  };
  return { transport, calls, submissions, remoteJobs };
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'open-genjutsu-protocol-'));
  await mkdir(path.join(dir, 'packs'));
  const image = path.join(dir, 'reference.png'); const video = path.join(dir, 'source.mp4');
  const tools = await discoverMediaBinaries(binaries); const testFfmpeg = tools.ffmpeg.path;
  assert.ok(testFfmpeg && tools.available, 'Install FFmpeg or explicitly set the test FFmpeg/ffprobe paths.');
  await exec(testFfmpeg, ['-nostdin','-y','-v','error','-f','lavfi','-i','color=red:s=64x64','-frames:v','1',image]);
  await exec(testFfmpeg, ['-nostdin','-y','-v','error','-f','lavfi','-i','color=blue:s=64x64:r=24','-t','0.5','-c:v','libx264','-pix_fmt','yuv420p',video]);
  return { dir, image, video, imageBytes: new Uint8Array(await readFile(image)), dataDir: path.join(dir, 'data'), workflowsDir: path.join(dir, 'packs') };
}
async function upload(base: string, file: string, mime: string): Promise<Asset> {
  const form = new FormData(); form.append('file', new Blob([await readFile(file)], { type: mime }), path.basename(file));
  const response = await fetch(`${base}/api/assets`, { method: 'POST', body: form });
  assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<Asset>;
}
async function waitFor(base: string, id: string, predicate: (job: Job) => boolean): Promise<Job> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = await (await fetch(`${base}/api/jobs/${id}`)).json() as Job;
    if (predicate(job)) return job;
    if (job.status === 'failed' || job.status === 'interrupted') assert.fail(JSON.stringify(job));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Protocol job did not reach expected state.');
}
function zipEntries(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])); assert.ok(end >= 0);
  let cursor = bytes.readUInt32LE(end+16); const files = new Map<string, Buffer>();
  for (let n = 0; n < bytes.readUInt16LE(end+10); n++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor+10); const size = bytes.readUInt32LE(cursor+20);
    const nameLength = bytes.readUInt16LE(cursor+28); const extraLength = bytes.readUInt16LE(cursor+30); const commentLength = bytes.readUInt16LE(cursor+32); const local = bytes.readUInt32LE(cursor+42);
    const name = bytes.subarray(cursor+46,cursor+46+nameLength).toString();
    const start = local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28); const data = bytes.subarray(start,start+size);
    assert.ok(method === 0 || method === 8); files.set(name, method === 8 ? inflateRawSync(data) : data);
    cursor += 46+nameLength+extraLength+commentLength;
  }
  return files;
}

test('protocol: real SDK asset binding, submit, poll, download and durable reproducibility', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes, false, true);
  const previousKey = process.env.COMFY_API_KEY; const previousUrl = process.env.COMFY_BASE_URL;
  process.env.COMFY_API_KEY = 'protocol-dummy-must-never-be-sent'; process.env.COMFY_BASE_URL = 'https://cloud.comfy.org';
  let instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
  try {
    let base = `http://127.0.0.1:${instance.port}`;
    assert.equal((await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) })).status, 201);
    const source = await upload(base, f.video, 'video/mp4'); const reference = await upload(base, f.image, 'image/png');
    const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: pack.id, sourceVideoId: source.id, referenceImageId: reference.id }) });
    assert.equal(response.status, 202, await response.clone().text());
    const queued = await response.json() as Job;
    const done = await waitFor(base, queued.id, job => job.status === 'succeeded');
    assert.equal(done.outputs.length, 1); assert.equal(done.progress, 1);
    assert.equal(fake.submissions.length, 1); assert.equal(fake.submissions[0]!.extra_data, undefined);
    assert.equal((fake.submissions[0]!.workflow['1']!.inputs.file as { __type: string }).__type, 'core/ASSET');
    assert.equal((fake.submissions[0]!.workflow['2']!.inputs.image as { __type: string }).__type, 'core/ASSET');
    assert.ok(fake.calls.every(call => call.auth === null));
    assert.equal(process.env.COMFY_API_KEY, 'protocol-dummy-must-never-be-sent'); assert.equal(process.env.COMFY_BASE_URL, 'https://cloud.comfy.org');
    assert.deepEqual(new Uint8Array(await (await fetch(base+done.outputs[0]!.url)).arrayBuffer()), f.imageBytes);
    const manifest = await (await fetch(`${base}/api/jobs/${queued.id}/manifest`)).json();
    assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/); assert.equal(manifest.preprocessing.maxDimension, 480); assert.equal(manifest.integration, '@comfyorg/sdk@0.5.0 / self-hosted comfy-api-proxy');
    const bundle = await fetch(`${base}/api/jobs/${queued.id}/bundle`); assert.equal(bundle.status, 200);
    const entries = zipEntries(Buffer.from(await bundle.arrayBuffer()));
    const portable = JSON.parse(entries.get('portable-workflow-api.json')!.toString());
    const sourceName = portable['1'].inputs.file; const referenceName = portable['2'].inputs.image;
    assert.equal(typeof sourceName, 'string'); assert.ok(sourceName.startsWith('open-genjutsu-'));
    assert.equal(createHash('sha256').update(entries.get('inputs/'+sourceName)!).digest('hex'), manifest.preprocessing.sha256);
    assert.equal(createHash('sha256').update(entries.get('inputs/'+referenceName)!).digest('hex'), manifest.referenceSha256);
    assert.equal(createHash('sha256').update(entries.get('originals/source.mp4')!).digest('hex'), manifest.sourceSha256);
    assert.ok(!entries.get('manifest.json')!.toString().includes(f.dir));
    assert.equal(manifest.assetBindings.sourceVideo.sha256, manifest.preprocessing.sha256);
    const changed = structuredClone(pack); changed.graph['4']!.inputs.filename_prefix = 'updated-global-workflow';
    await fetch(`${base}/api/workflows/${pack.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changed) });
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comfyUrl: 'http://127.0.0.1:8186', proxyUrl: 'http://127.0.0.1:8187' }) });
    const second = await (await fetch(`${base}/api/jobs/${queued.id}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ width: 80 }) })).json() as Job;
    await waitFor(base, second.id, job => job.status === 'succeeded');
    assert.equal(fake.submissions[1]!.workflow['4']!.inputs.filename_prefix, 'protocol-output'); assert.equal(fake.submissions[1]!.workflow['3']!.inputs.width, 80);
    const lastSubmit = fake.calls.filter(call => call.method === 'POST' && call.url.endsWith('/api/v2/jobs')).at(-1)!;
    assert.equal(new URL(lastSubmit.url).port, '8189', 'rerun must use the saved engine, not new global settings');
    await instance.close();
    instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
    base = `http://127.0.0.1:${instance.port}`;
    const recovered = await (await fetch(`${base}/api/jobs/${queued.id}`)).json() as Job;
    assert.equal(recovered.status, 'succeeded'); assert.equal(fake.submissions.length, 2);
  } finally {
    await instance.close(); await rm(f.dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.COMFY_API_KEY; else process.env.COMFY_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.COMFY_BASE_URL; else process.env.COMFY_BASE_URL = previousUrl;
  }
});

test('protocol: owned cancellation and restart recovery never resubmit or interrupt global queue', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes, true);
  let instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
  try {
    let base = `http://127.0.0.1:${instance.port}`;
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
    const source = await upload(base, f.video, 'video/mp4'); const reference = await upload(base, f.image, 'image/png');
    const queued = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: pack.id, sourceVideoId: source.id, referenceImageId: reference.id }) })).json() as Job;
    const running = await waitFor(base, queued.id, job => !!job.promptId);
    await instance.close();
    instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
    base = `http://127.0.0.1:${instance.port}`;
    await waitFor(base, queued.id, job => job.status === 'running');
    assert.equal(fake.submissions.length, 1);
    assert.equal((await fetch(`${base}/api/jobs/${randomUUID()}/cancel`, { method: 'POST' })).status, 404);
    const cancelled = await fetch(`${base}/api/jobs/${queued.id}/cancel`, { method: 'POST' }); assert.equal(cancelled.status, 200);
    await waitFor(base, queued.id, job => job.status === 'cancelled');
    const cancellations = fake.calls.filter(call => call.method === 'POST' && call.url.endsWith('/cancel'));
    assert.ok(cancellations.length >= 1); assert.ok(cancellations.every(call => call.url.endsWith(`/jobs/${running.promptId}/cancel`)));
    assert.ok(!fake.calls.some(call => /\/interrupt|\/queue/.test(call.url)));
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('protocol: legacy image-slot MP4 output with unknown size is probed as video; input kinds stay strict', async () => {
  const f = await fixture(); const videoBytes = new Uint8Array(await readFile(f.video));
  const fake = fakeBackend(videoBytes, false, true, 'legacy-video-output.mp4');
  const instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
  try {
    const base = `http://127.0.0.1:${instance.port}`;
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
    const wrongInput = new FormData(); wrongInput.append('file', new Blob([videoBytes], { type: 'image/png' }), 'pretend-image.png');
    assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', body: wrongInput })).status, 400);
    const source = await upload(base, f.video, 'video/mp4'); const reference = await upload(base, f.image, 'image/png');
    const queued = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: pack.id, sourceVideoId: source.id, referenceImageId: reference.id }) })).json() as Job;
    const done = await waitFor(base, queued.id, job => job.status === 'succeeded');
    const output = done.outputs[0]!;
    assert.equal(output.kind, 'video'); assert.equal(output.mimeType, 'video/mp4');
    assert.equal(output.width, 64); assert.equal(output.height, 64); assert.ok(output.duration! > 0);
    assert.equal(output.bytes, videoBytes.byteLength);
    const response = await fetch(base+output.url); assert.match(response.headers.get('content-type') || '', /^video\/mp4/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
    assert.equal(fake.submissions.length, 1);
    const bundle = await fetch(`${base}/api/jobs/${queued.id}/bundle`);
    const entries = zipEntries(Buffer.from(await bundle.arrayBuffer())); assert.deepEqual(new Uint8Array(entries.get('outputs/output-1.mp4')!), videoBytes);
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('protocol: lost tracking stays recoverable; restart and cancellation follow the confirmed remote ID', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes, true);
  let offline = false; let rejectedPolls = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (offline && (init?.method || 'GET') === 'GET' && /^\/api\/v2\/jobs\/[^/]+$/.test(url.pathname)) { rejectedPolls++; throw new TypeError('Protocol fixture: proxy connection lost.'); }
    return fake.transport(input, init);
  };
  let instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport, pollMs: 5, binaries });
  try {
    let base = `http://127.0.0.1:${instance.port}`;
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
    const source = await upload(base, f.video, 'video/mp4'); const reference = await upload(base, f.image, 'image/png');
    const queued = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: pack.id, sourceVideoId: source.id, referenceImageId: reference.id }) })).json() as Job;
    const running = await waitFor(base, queued.id, job => !!job.promptId);
    offline = true;
    const interrupted = await waitFor(base, queued.id, job => job.status === 'interrupted');
    assert.equal(interrupted.promptId, running.promptId); assert.ok(rejectedPolls >= 5); assert.equal(fake.submissions.length, 1);
    offline = false; await instance.close();
    instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport, pollMs: 5, binaries });
    base = `http://127.0.0.1:${instance.port}`;
    await waitFor(base, queued.id, job => job.status === 'running'); assert.equal(fake.submissions.length, 1);
    offline = true; await waitFor(base, queued.id, job => job.status === 'interrupted'); offline = false;
    const canceled = await fetch(`${base}/api/jobs/${queued.id}/cancel`, { method: 'POST' }); assert.equal(canceled.status, 200);
    assert.equal((await canceled.json() as Job).status, 'cancelled');
    assert.equal(fake.submissions.length, 1);
    assert.ok(fake.calls.filter(call => call.method === 'POST' && call.url.endsWith('/cancel')).every(call => call.url.endsWith(`/jobs/${running.promptId}/cancel`)));
    assert.ok(!fake.calls.some(call => /\/interrupt|\/queue/.test(call.url)));
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('protocol: a confirmed model failure remains terminal after restart', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes, true);
  let instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
  try {
    let base = `http://127.0.0.1:${instance.port}`;
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
    const source = await upload(base, f.video, 'video/mp4'); const reference = await upload(base, f.image, 'image/png');
    const queued = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: pack.id, sourceVideoId: source.id, referenceImageId: reference.id }) })).json() as Job;
    const running = await waitFor(base, queued.id, job => !!job.promptId);
    fake.remoteJobs.get(running.promptId!)!.failed = true;
    await waitFor(base, queued.id, job => job.status === 'failed');
    await instance.close();
    instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, pollMs: 5, binaries });
    base = `http://127.0.0.1:${instance.port}`;
    assert.equal((await (await fetch(`${base}/api/jobs/${queued.id}`)).json() as Job).status, 'failed');
    assert.equal((await fetch(`${base}/api/jobs/${queued.id}/resume`, { method: 'POST' })).status, 409);
    assert.equal(fake.submissions.length, 1);
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('protocol: a lost submission receipt is never automatically submitted twice', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes, true);
  const transport: typeof fetch = async (input, init) => {
    const response = await fake.transport(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/api/v2/jobs' && init?.method === 'POST') throw new TypeError('Protocol fixture: receipt lost after remote acceptance.');
    return response;
  };
  let instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport, pollMs: 5, binaries });
  try {
    let base = `http://127.0.0.1:${instance.port}`;
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
    const source = await upload(base, f.video, 'video/mp4'); const reference = await upload(base, f.image, 'image/png');
    const queued = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: pack.id, sourceVideoId: source.id, referenceImageId: reference.id }) })).json() as Job;
    const interrupted = await waitFor(base, queued.id, job => job.status === 'interrupted');
    assert.equal(interrupted.promptId, undefined); assert.equal(fake.submissions.length, 1);
    await instance.close();
    instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport, pollMs: 5, binaries });
    base = `http://127.0.0.1:${instance.port}`;
    assert.equal((await (await fetch(`${base}/api/jobs/${queued.id}`)).json() as Job).status, 'interrupted');
    assert.equal((await fetch(`${base}/api/jobs/${queued.id}/resume`, { method: 'POST' })).status, 409);
    assert.equal(fake.submissions.length, 1);
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('security: explicitly allowed Vite origin can upload, without granting unrelated origins', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes);
  const instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries, allowedOrigins: ['http://127.0.0.1:5173'] });
  try {
    const base = `http://127.0.0.1:${instance.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: base } })).status, 200);
    const form = new FormData(); form.append('file', new Blob([await readFile(f.image)], { type: 'image/png' }), 'reference.png');
    const response = await fetch(`${base}/api/assets`, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' }, body: form });
    assert.equal(response.status, 201, await response.clone().text());
    const asset = await response.json() as Asset; assert.equal((await fetch(base+asset.url)).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: 'http://127.0.0.1:5174' } })).status, 403);
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('durability: one workspace owner, intact state and lock release after shutdown or listen failure', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes);
  let instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries });
  let other: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const base = `http://127.0.0.1:${instance.port}`;
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) });
    const before = await readFile(path.join(f.dataDir, 'state.json'));
    await assert.rejects(startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries }), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'workspace_in_use');
    assert.deepEqual(await readFile(path.join(f.dataDir, 'state.json')), before);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const otherDir = path.join(f.dir, 'other-workspace');
    await assert.rejects(startServer({ port: instance.port, dataDir: otherDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries }), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE');
    other = await startServer({ port: 0, dataDir: otherDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries });
    await other.close(); other = undefined;
    await instance.close();
    instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries });
    const workflows = await (await fetch(`http://127.0.0.1:${instance.port}/api/workflows`)).json() as WorkflowImport[];
    assert.ok(workflows.some(workflow => workflow.id === pack.id));
    assert.equal(fake.submissions.length, 0);
  } finally { await other?.close(); await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('security: reject cross-origin/Host rebinding, provider URLs, bad bindings and unsafe media', async () => {
  const f = await fixture(); const fake = fakeBackend(f.imageBytes);
  const instance = await startServer({ port: 0, dataDir: f.dataDir, workflowsDir: f.workflowsDir, transport: fake.transport, binaries });
  try {
    const base = `http://127.0.0.1:${instance.port}`;
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: 'https://attacker.example' } })).status, 403);
    const hostStatus = await new Promise<number>(resolve => { const req = request({ hostname: '127.0.0.1', port: instance.port, path: '/api/health', headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode!); }); req.end(); });
    assert.equal(hostStatus, 403);
    assert.match((await fetch(`${base}/api/health`)).headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comfyUrl: 'https://cloud.comfy.org', proxyUrl: 'http://127.0.0.1:8189' }) })).status, 400);
    const invalid = structuredClone(pack); invalid.bindings.sourceVideo.input = 'missing';
    assert.equal((await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalid) })).status, 400);
    const duplicate = structuredClone(pack); duplicate.bindings.referenceImage = duplicate.bindings.sourceVideo;
    assert.throws(() => parseWorkflow(duplicate), /same input/);
    const poison = new FormData(); poison.append('file', new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'evil.svg');
    assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', body: poison })).status, 415);
    const disguised = new FormData(); disguised.append('file', new Blob(['not a PNG'], { type: 'image/png' }), '../../evil.png');
    assert.equal((await fetch(`${base}/api/assets`, { method: 'POST', body: disguised })).status, 400);
    const unsafePack = { ...pack, id: 'unsafe', graph: { ...graph, '9': { class_type: 'ThirdPartyAPI', inputs: {} } } };
    await fetch(`${base}/api/workflows/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(unsafePack) });
    const readiness = await (await fetch(`${base}/api/backend/status?workflowId=unsafe`)).json(); assert.equal(readiness.ready, false); assert.ok(readiness.missingNodes.includes('ThirdPartyAPI'));
    const fixturePack = { ...parseWorkflow(pack), id: pack.id!, createdAt: '', updatedAt: '' };
    const audited = auditWorkflow(fixturePack, { LoadVideo: { python_module: 'nodes' }, LoadImage: { python_module: 'nodes' }, ImageScale: { api_node: true }, SaveImage: { python_module: 'custom_nodes.untrusted' } });
    assert.ok(audited.blockedNodes.some(node => node.startsWith('ImageScale:'))); assert.ok(audited.blockedNodes.some(node => node.startsWith('SaveImage:')));
    let touched = false;
    await assert.rejects(guardedFetch('http://127.0.0.1:8189', async () => { touched = true; return new Response(); })('https://cloud.comfy.org/api/v2/jobs'), /outside/); assert.equal(touched, false);
    await assert.rejects(guardedFetch('http://127.0.0.1:8189', async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }))('http://127.0.0.1:8189/api/v2/health'), /redirects/);
  } finally { await instance.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('audit: missing model names are actionable and only the pinned local GGUF class/module is permitted', () => {
  const p = { ...parseWorkflow(pack), id: pack.id!, createdAt: '', updatedAt: '', graph: { ...graph, '5': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'missing.gguf', type: 'wan' } } } };
  const info = Object.fromEntries(Object.values(graph).map(node => [node.class_type, { python_module: 'nodes', input: { required: {} } }]));
  const audited = auditWorkflow(p, { ...info, CLIPLoaderGGUF: { python_module: 'custom_nodes.ComfyUI-GGUF', input: { required: { clip_name: [['installed.gguf']] } } } });
  assert.equal(audited.blockedNodes.length, 0); assert.deepEqual(audited.missingModels, ['CLIPLoaderGGUF.clip_name: missing.gguf']);
  assert.ok(auditWorkflow(p, { ...info, CLIPLoaderGGUF: { python_module: 'custom_nodes.some-other-plugin' } }).blockedNodes.length);
});
