import { Comfy } from '@comfyorg/sdk';
import type { BackendStatus, Settings, WorkflowPack } from '../shared/types.js';
import { guardedFetch, localUrl, type FetchLike } from './security.js';
import { auditWorkflow, type ObjectInfo } from './workflows.js';
import { HttpError, messageOf } from './errors.js';
import { MAX_FILE_BYTES } from './media.js';

/** Do not inherit a cloud credential or let an SDK-supplied link leave localhost. */
export function localComfy(settings: Settings, transport?: FetchLike): Comfy {
  const previousUrl = process.env.COMFY_BASE_URL;
  const previousKey = process.env.COMFY_API_KEY;
  try {
    process.env.COMFY_BASE_URL = localUrl(settings.proxyUrl);
    delete process.env.COMFY_API_KEY;
    // Constructor reads env synchronously. No await occurs inside this scoped change.
    return new Comfy({ clientInfo: 'open-genjutsu/0.2.0', timeoutMs: 15000, fetch: cappedFetch(guardedFetch(settings.proxyUrl, transport)) });
  } finally {
    if (previousUrl === undefined) delete process.env.COMFY_BASE_URL; else process.env.COMFY_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.COMFY_API_KEY; else process.env.COMFY_API_KEY = previousKey;
  }
}
function cappedFetch(transport: FetchLike): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await transport(input, init);
    if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) { await response.body?.cancel(); throw new HttpError(502, 'output_size', 'The local backend response exceeded 200MB.'); }
    if (!response.body) return response;
    let bytes = 0;
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      const value = await reader.read();
      if (value.done) { controller.close(); return; }
      bytes += value.value.byteLength;
      if (bytes > MAX_FILE_BYTES) { await reader.cancel(); controller.error(new Error('Local backend response exceeded 200MB.')); return; }
      controller.enqueue(value.value);
    }, cancel(reason) { return reader.cancel(reason); } });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as FetchLike;
}
export class Backend {
  constructor(private transport?: FetchLike) {}
  async objectInfo(settings: Settings): Promise<ObjectInfo> {
    const response = await guardedFetch(settings.comfyUrl, this.transport)(`${localUrl(settings.comfyUrl)}/object_info`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new HttpError(502, 'comfy_unavailable', `ComfyUI object_info returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > 30_000_000) { await response.body?.cancel(); throw new HttpError(502, 'object_info_size', 'ComfyUI node metadata is unexpectedly large.'); }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('ComfyUI returned no node metadata.');
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 30_000_000) { await reader.cancel(); throw new HttpError(502, 'object_info_size', 'ComfyUI node metadata is unexpectedly large.'); } chunks.push(chunk.value); }
    const text = Buffer.concat(chunks).toString('utf8');
    const data = JSON.parse(text) as ObjectInfo;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('ComfyUI returned invalid node metadata.');
    return data;
  }
  async status(settings: Settings, workflow?: WorkflowPack): Promise<BackendStatus> {
    let info: ObjectInfo = {}; let connected = false; let proxyConnected = false;
    const errors: string[] = [];
    await Promise.all([
      this.objectInfo(settings).then(value => { info = value; connected = true; }).catch(error => errors.push(messageOf(error))),
      guardedFetch(settings.proxyUrl, this.transport)(`${localUrl(settings.proxyUrl)}/api/v2/health`, { signal: AbortSignal.timeout(5000) }).then(async response => { if (!response.ok) throw new Error(`Local API proxy returned HTTP ${response.status}.`); proxyConnected = true; await response.body?.cancel(); }).catch(error => errors.push(`Proxy: ${messageOf(error)}`)),
    ]);
    const audit = auditWorkflow(workflow, info);
    return { connected, proxyConnected, nodes: Object.keys(info).sort(), ...audit, ready: connected && proxyConnected && !audit.missingNodes.length && !audit.missingModels.length && !audit.blockedNodes.length, warnings: ['Readiness checks node metadata and model filenames only. It does not verify model-file integrity, local inference speed or output quality.'], error: errors.length ? errors.join(' ') : undefined };
  }
  client(settings: Settings): Comfy { return localComfy(settings, this.transport); }
}
