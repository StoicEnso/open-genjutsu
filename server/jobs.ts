import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import type { Job as ComfyJob } from '@comfyorg/sdk';
import type { Asset, Job, JobManifest, JobRerunRequest, JobRequest, JsonValue, Settings, WorkflowPack } from '../shared/types.js';
import { Backend } from './comfy.js';
import { HttpError, messageOf } from './errors.js';
import { Media, MAX_FILE_BYTES } from './media.js';
import { Store, type StoredJob } from './storage.js';
import { bindParameters } from './workflows.js';

const terminal = new Set(['succeeded','failed','cancelled','interrupted']);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Jobs {
  private active?: Promise<void>;
  private closing = false;
  private controllers = new Map<string, AbortController>();
  constructor(private store: Store, private media: Media, private backend: Backend, private pollMs = 1500) {}
  async init(start = true): Promise<void> {
    await this.store.update(state => {
      for (const record of Object.values(state.jobs)) {
        if (!['uploading','running','queued'].includes(record.job.status) && !(record.job.promptId && (record.job.status === 'interrupted' || record.job.status === 'failed' && !record.knownRemoteTerminalFailure))) continue;
        if (record.job.promptId) { record.job.status = 'queued'; record.job.message = 'Recovering the existing Comfy job; no generation is resubmitted.'; }
        else if (record.job.status !== 'queued') { record.job.status = 'interrupted'; record.job.error = 'The app stopped without a confirmed submission receipt. Check your Comfy queue before starting another job.'; record.job.message = record.job.error; }
      }
    });
    if (start) this.kick();
  }
  start(): void { this.kick(); }
  get(id: string): StoredJob {
    const record = this.store.snapshot().jobs[id];
    if (!record) throw new HttpError(404, 'job_not_found', 'No local job has that ID.');
    return record;
  }
  async create(input: JobRequest, context?: { workflow: WorkflowPack; settings: Settings }): Promise<Job> {
    const snapshot = this.store.snapshot();
    const workflow = context?.workflow || snapshot.workflows[input.workflowId];
    const settings = context?.settings || snapshot.settings;
    if (!workflow) throw new HttpError(404, 'workflow_not_found', 'Choose an imported workflow.');
    const source = snapshot.assets[input.sourceVideoId]; const reference = snapshot.assets[input.referenceImageId];
    if (!source || source.asset.kind !== 'video' || !reference || reference.asset.kind !== 'image') throw new HttpError(400, 'input_assets', 'Choose an existing source video and reference image.');
    const { workflowId: _workflowId, sourceVideoId: _sourceVideoId, referenceImageId: _referenceImageId, ...parameters } = input;
    const graph = bindParameters(workflow, parameters);
    for (const control of ['width','height','frames'] as const) {
      const binding = workflow.bindings[control];
      if (!binding) continue;
      const value = Number(graph[binding.nodeId]?.inputs[binding.input]);
      if (!Number.isInteger(value) || value < 1 || value > (control === 'frames' ? 49 : 480)) throw new HttpError(400, 'preview_limits', 'This local preview accepts at most 49 frames and 480px dimensions. Lower the workflow defaults or exposed controls.');
    }
    const status = await this.backend.status(settings, { ...workflow, graph });
    const mediaStatus = await this.media.status();
    if (!mediaStatus.available) throw new HttpError(503, 'media_tools_missing', [mediaStatus.ffmpeg.error, mediaStatus.ffprobe.error].filter(Boolean).join(' '), mediaStatus);
    if (!status.ready) throw new HttpError(409, 'workflow_not_ready', 'Connect the local services and resolve the workflow requirements before queuing.', status);
    const id = randomUUID(); const now = new Date().toISOString();
    const job: Job = { id, workflowId: workflow.id, workflowName: workflow.name, sourceVideoId: source.asset.id, referenceImageId: reference.asset.id, parameters, status: 'queued', progress: 0, message: 'Queued for a local preview. No cloud or paid API will be used.', outputs: [], createdAt: now, updatedAt: now, manifestUrl: `/api/jobs/${id}/manifest`, workflowUrl: `/api/jobs/${id}/workflow` };
    const manifest: JobManifest = { version: 1, app: 'Open Genjutsu', job, workflow, settings, source: source.asset, reference: reference.asset, sourceSha256: source.sha256, referenceSha256: reference.sha256, workflowSha256: digest(graph), integration: '@comfyorg/sdk@0.5.0 / self-hosted comfy-api-proxy', notice: 'Execution manifest, not a claim of character fidelity. Conditioning uses a bounded, aspect-preserving first-49-frame maximum 24fps preview at up to 480px. Original uploads remain intact. Output quality and local model runtime require review.' };
    await this.store.update(state => { state.jobs[id] = { job, workflow, graph, settings, manifest }; });
    this.kick();
    return job;
  }
  async rerun(id: string, overrides: JobRerunRequest): Promise<Job> {
    const original = this.get(id);
    return this.create({ workflowId: original.workflow.id, sourceVideoId: original.job.sourceVideoId, referenceImageId: original.job.referenceImageId, ...original.job.parameters, ...overrides }, { workflow: original.workflow, settings: original.settings });
  }
  private async patch(id: string, mutate: (record: StoredJob) => void): Promise<void> {
    await this.store.update(state => { const record = state.jobs[id]; if (!record) return; mutate(record); record.job.updatedAt = new Date().toISOString(); record.manifest.job = record.job; });
  }
  private kick(): void {
    if (this.closing || this.active) return;
    this.active = this.drain().catch(error => { this.closing = true; console.error('[open-genjutsu] Queue stopped after a storage/worker error:', messageOf(error)); }).finally(() => { this.active = undefined; if (!this.closing && Object.values(this.store.snapshot().jobs).some(record => record.job.status === 'queued')) this.kick(); });
  }
  private async drain(): Promise<void> {
    while (!this.closing) {
      const next = Object.values(this.store.snapshot().jobs).filter(record => record.job.status === 'queued').sort((a,b) => a.job.createdAt.localeCompare(b.job.createdAt))[0];
      if (!next) return;
      await this.run(next.job.id);
    }
  }
  private async run(id: string): Promise<void> {
    const controller = new AbortController(); this.controllers.set(id, controller);
    const signal = controller.signal;
    let knownRemoteTerminalFailure = false;
    try {
      let record = this.get(id);
      if (record.job.status !== 'queued') return;
      const client = this.backend.client(record.settings);
      let remote: ComfyJob;
      if (record.job.promptId) {
        await this.patch(id, value => { value.job.status = 'running'; value.job.message = 'Recovering the existing Comfy job.'; });
        remote = await client.jobs.get(record.job.promptId);
      } else {
        await this.patch(id, value => { value.job.status = 'uploading'; value.job.message = 'Preparing a short source preview and uploading through the local Comfy SDK.'; });
        const source = this.store.snapshot().assets[record.job.sourceVideoId]!;
        const reference = this.store.snapshot().assets[record.job.referenceImageId]!;
        const frameBinding = record.workflow.bindings.frames;
        const defaultFrames = frameBinding ? Number(record.graph[frameBinding.nodeId]?.inputs[frameBinding.input]) : 49;
        const frames = Math.min(49, record.job.parameters.frames ?? (Number.isFinite(defaultFrames) ? defaultFrames : 49));
        const prepared = await this.media.prepareVideo(source, frames, signal);
        await this.patch(id, value => { value.manifest.preprocessing = { preparedSource: prepared.asset, sha256: prepared.sha256, fps: 24, maxFrames: frames, maxDimension: 480, aspect: 'preserved', audio: 'removed from conditioning preview' }; });
        // Recheck node/model availability immediately before execution; imported graphs are never trusted as an audit.
        const status = await this.backend.status(record.settings, record.workflow);
        if (!status.ready) throw new HttpError(409, 'workflow_not_ready', 'Workflow requirements changed before execution.', status);
        const sourceRef = await client.assets.fromFile(prepared.filename).asReference(signal);
        const referenceRef = await client.assets.fromFile(reference.filename).asReference(signal);
        const graph = structuredClone(record.graph);
        graph[record.workflow.bindings.sourceVideo.nodeId]!.inputs[record.workflow.bindings.sourceVideo.input] = sourceRef as unknown as JsonValue;
        graph[record.workflow.bindings.referenceImage.nodeId]!.inputs[record.workflow.bindings.referenceImage.input] = referenceRef as unknown as JsonValue;
        if (this.get(id).cancelRequested || signal.aborted) return;
        await this.patch(id, value => {
          value.graph = graph; value.manifest.workflowSha256 = digest(graph); value.submissionAttempted = true;
          value.manifest.assetBindings = {
            sourceVideo: { proxyAssetId: sourceRef.info.id, localAssetId: prepared.asset.id, sha256: prepared.sha256, filePath: sourceRef.info.file_path },
            referenceImage: { proxyAssetId: referenceRef.info.id, localAssetId: reference.asset.id, sha256: reference.sha256, filePath: referenceRef.info.file_path },
          };
        });
        // A durable attempt flag precedes the network call. An ambiguous error is never auto-resubmitted.
        remote = await client.submit(client.workflows.fromJson(graph), { idempotencyKey: id, signal });
        await this.patch(id, value => { value.job.promptId = remote.id; value.job.status = 'running'; value.job.message = 'Running on your local ComfyUI.'; });
      }
      const deadline = Date.now() + 6 * 60 * 60 * 1000;
      let failures = 0;
      for (;;) {
        signal.throwIfAborted();
        record = this.get(id);
        this.validateRemote(remote, record.job.promptId!, record.settings);
        if (record.cancelRequested && !['canceling','canceled','succeeded','failed','expired'].includes(remote.status)) await remote.cancel(signal);
        const status = remote.status;
        if (status === 'succeeded') break;
        if (status === 'canceled') { await this.patch(id, value => { value.job.status = 'cancelled'; value.job.message = 'Comfy confirmed this job was cancelled.'; }); return; }
        if (status === 'failed' || status === 'expired') { knownRemoteTerminalFailure = true; throw new Error(remote.error?.message || `Comfy job ${status}.`); }
        const progress = remote.progress?.value;
        await this.patch(id, value => { value.job.progress = typeof progress === 'number' && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : value.job.progress; value.job.message = record.cancelRequested ? 'Cancellation requested for this job; waiting for Comfy confirmation.' : status === 'queued' ? 'Waiting in your local Comfy queue.' : remote.progress?.message || 'Running on your local ComfyUI.'; });
        if (Date.now() > deadline) throw new Error('Stopped following after six hours. The existing Comfy job may still be running; check its ID before retrying.');
        await pause(this.pollMs, undefined, { signal });
        try { await remote.refresh(signal); failures = 0; }
        catch (error) { if (signal.aborted || ++failures >= 5) throw error; await pause(Math.min(failures * Math.max(1, this.pollMs), 10000), undefined, { signal }); }
      }
      if (this.closing) return;
      const outputs = record.workflow.outputNodeIds.flatMap(node => remote.getOutputs(node)).filter(output => output.type === 'video' || output.type === 'image');
      if (!outputs.length || outputs.length > 16) throw new Error('The workflow produced no supported image/video outputs, or too many outputs. Check its output-node bindings.');
      let total = 0;
      const assets: Asset[] = [];
      for (const output of outputs) {
        // The local proxy reports 0 when output size is not yet known. The SDK
        // transport caps every streamed response; enforce the combined limit
        // using actual bytes rather than trusting optional proxy metadata.
        if (!Number.isFinite(output.sizeBytes) || output.sizeBytes < 0 || output.sizeBytes > MAX_FILE_BYTES) throw new Error('Workflow output exceeds the 200MB limit.');
        const temporary = path.join(this.store.tempDir, `${randomUUID()}.part`);
        try {
          await output.toFile(temporary, { signal, timeoutMs: 120000 });
          const downloaded = await stat(temporary);
          if (!downloaded.isFile() || downloaded.size <= 0 || (total += downloaded.size) > MAX_FILE_BYTES) throw new Error('Workflow output exceeds the 200MB combined limit or is empty.');
          // Legacy Comfy history slots may label a SaveVideo MP4 as "image".
          // Decode/probe downloaded outputs instead of trusting that slot label;
          // source/reference uploads retain their explicit expected-kind checks.
          const saved = await this.media.adopt(temporary, output.name);
          assets.push(saved.asset);
        } finally { await unlink(temporary).catch(() => undefined); }
      }
      await this.patch(id, value => { value.job.outputs = assets; value.job.status = 'succeeded'; value.job.progress = 1; value.job.message = 'Local generation finished. Review the result and export its manifest.'; delete value.job.error; });
    } catch (error) {
      await this.patch(id, record => {
        if (record.job.status === 'cancelled') return;
        const interrupted = !knownRemoteTerminalFailure && (this.closing || !!record.job.promptId || !!record.submissionAttempted);
        record.knownRemoteTerminalFailure = knownRemoteTerminalFailure;
        record.job.status = interrupted ? 'interrupted' : 'failed';
        record.job.error = messageOf(error);
        record.job.message = interrupted ? `Execution tracking interrupted: ${messageOf(error)}. Check the existing Comfy queue before retrying.` : messageOf(error);
      });
    } finally { this.controllers.delete(id); }
  }
  async cancel(id: string): Promise<Job> {
    const record = this.get(id);
    if (terminal.has(record.job.status) && !(record.job.status === 'interrupted' && record.job.promptId)) return record.job;
    await this.patch(id, value => {
      value.cancelRequested = true;
      if (!value.job.promptId && !value.submissionAttempted) { value.job.status = 'cancelled'; value.job.message = 'Cancelled before submission.'; }
      else value.job.message = 'Cancellation requested for this job only.';
    });
    if (!record.job.promptId && !record.submissionAttempted) this.controllers.get(id)?.abort(new Error('Cancelled before submission.'));
    if (record.job.promptId) {
      const remote = await this.backend.client(record.settings).jobs.get(record.job.promptId);
      this.validateRemote(remote, record.job.promptId, record.settings);
      await remote.cancel();
      if (remote.status === 'canceled') await this.patch(id, value => { value.job.status = 'cancelled'; value.job.message = 'Comfy confirmed this job was cancelled.'; });
    }
    return this.get(id).job;
  }
  private validateRemote(remote: ComfyJob, expectedId: string, settings: Settings): void {
    if (remote.id !== expectedId) throw new HttpError(502, 'remote_job_mismatch', 'The proxy returned a different job ID. No cancellation or global queue operation was sent.');
    for (const [key, suffix] of [['self',''],['cancel','/cancel']] as const) {
      const target = new URL(remote.urls[key], settings.proxyUrl);
      if (target.origin !== new URL(settings.proxyUrl).origin || target.pathname !== `/api/v2/jobs/${encodeURIComponent(expectedId)}${suffix}` || target.search || target.hash) throw new HttpError(502, 'unsafe_job_link', 'The proxy returned an unexpected job link. Only this job ID may be followed or cancelled.');
    }
  }
  async resume(id: string): Promise<Job> {
    const record = this.get(id);
    if (record.job.status !== 'interrupted' || !record.job.promptId || record.knownRemoteTerminalFailure) throw new HttpError(409, 'not_resumable', 'Only interrupted jobs with a confirmed Comfy ID can be followed again. No generation will be resubmitted.');
    await this.patch(id, value => { value.job.status = 'queued'; value.job.message = 'Following the existing Comfy job again; not resubmitting.'; delete value.job.error; });
    this.kick(); return this.get(id).job;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort(new Error('The local app is shutting down.'));
    await this.active;
  }
}
