/** Optional Comfy Router adapter. No provider keys, signed URLs or raw errors are exported.
 * Contract verified 2026-10-23 against docs.comfy.org/development/comfy-router/{queue,quickstart}
 * and router-schemas/byteplus/dreamina-seedance-2-0-260128.json. Live billing is untested.
 */
import { Comfy } from '@comfyorg/sdk';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import type { CloudInput, CloudJob, CloudManifest, CloudQuote, CloudStatus } from '../shared/types.js';
import { Store, type StoredAsset } from './storage.js';
import { Media, MAX_FILE_BYTES, sha256 } from './media.js';
import { HttpError } from './errors.js';
import { idSchema } from './workflows.js';
import type { FetchLike } from './security.js';

export interface CloudCredentialStore { read(): Promise<string | undefined>; write(secret: string): Promise<void>; clear(): Promise<void> }
export const CLOUD_MODEL = 'byteplus/dreamina-seedance-2-0-260128';
const MODEL_NAME = 'Seedance 2.0 · reference video';
const API = 'https://api.comfy.org';
const CLOUD = 'https://cloud.comfy.org';
const ROUTE = `${API}/v2/models/${CLOUD_MODEL}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const warnings = ['Uses your Comfy workspace credits, not Higgsfield website credits. No automatic paid fallback.', 'Quotes upload the whole original source and reference to Comfy storage. Asset API access is required; uploads may be retained by Comfy.', 'An estimate is not a price lock. Failures/cancellation may still be billed; use workspace billing for final charges.', 'Hosted Seedance output has not been quality-tested in this app. Local portrait remains available.'];
export const cloudInputSchema = z.object({ sourceVideoId: idSchema, referenceImageId: idSchema, prompt: z.string().trim().min(1).max(1800), duration: z.number().int().min(4).max(15), resolution: z.enum(['480p','720p']), ratio: z.enum(['1:1','16:9','9:16']) }).strict();
const remoteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type NativeInput = { content: unknown[]; duration: number; resolution: string; ratio: string; generate_audio: false };
interface PrivateQuote { public: CloudQuote; native: NativeInput; keyEpoch: string; used: boolean }
interface Record { job: CloudJob; manifest: CloudManifest; native: NativeInput; attempted?: boolean; cancelRequested?: boolean }
interface CloudState { version: 1; jobs: { [id: string]: Record } }
/** Signed storage endpoints are fixed, public object-storage hosts, never arbitrary user URLs. */
export function cloudStorageUrl(value: string): URL {
  let u: URL;
  try { u = new URL(value); } catch { throw new HttpError(502, 'cloud_media_url', 'The provider returned an invalid media link.'); }
  if (u.protocol !== 'https:' || u.hostname !== 'storage.googleapis.com' || u.port || u.username || u.password || u.hash) throw new HttpError(502, 'cloud_media_url', 'The provider returned a media host outside the audited Comfy storage allowlist.');
  return u;
}
function safeFailure(status: number): HttpError {
  if (status === 401) return new HttpError(401, 'cloud_unauthorized', 'Comfy rejected the key. Reconnect a valid workspace key.');
  if (status === 402) return new HttpError(402, 'cloud_insufficient_credits', 'This Comfy workspace has insufficient credits. No top-up was performed.');
  if (status === 403) return new HttpError(403, 'cloud_not_enabled', 'This operation is not enabled for this Comfy workspace. Asset, estimate and queue access must all be available.');
  if (status === 422 || status === 400) return new HttpError(400, 'cloud_input_rejected', 'Comfy rejected this request. Check the model/media settings; no automatic fallback was used.');
  if (status === 429) return new HttpError(429, 'cloud_rate_limited', 'Comfy is limiting requests. No new generation was automatically retried.');
  return new HttpError(502, 'cloud_request_failed', 'The Comfy request failed. Check workspace usage before starting another generation.');
}
function safeError(error: unknown): HttpError {
  return error instanceof HttpError ? error : new HttpError(502, 'cloud_connection', 'Cloud tracking or media transfer was interrupted. Check Comfy usage; no new generation was resubmitted.');
}
export class Cloud {
  private key?: string;
  private keyEpoch = randomUUID();
  private storage: 'session' | 'encrypted' = 'session';
  private quotes = new Map<string, PrivateQuote>();
  private quoting = false;
  private admission = false;
  private quoteController?: AbortController;
  private quoteDone: Promise<void> = Promise.resolve();
  private credentialWarning = false;
  private historyUnavailable = false;
  private state: CloudState = { version: 1, jobs: {} };
  private pending: Promise<unknown> = Promise.resolve();
  private workers = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private closing = false;
  constructor(private store: Store, private media: Media, private transport: FetchLike = fetch, private credentials?: CloudCredentialStore, private pollMs = 2000) {}
  async init(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(path.join(this.store.dir, 'cloud-state.json'), 'utf8')) as CloudState;
      if (saved.version !== 1 || !saved.jobs || typeof saved.jobs !== 'object') throw new Error('invalid state');
      this.state = saved;
      for (const r of Object.values(this.state.jobs)) if (['queued','uploading','running'].includes(r.job.status)) {
        r.job.status = 'interrupted'; r.job.message = r.job.requestId ? 'App restarted. Follow the existing request; no generation was resubmitted.' : 'App stopped without a confirmed provider receipt. Check Comfy usage before creating another job.';
      }
      await this.update(() => undefined);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { this.historyUnavailable=true; this.state={version:1,jobs:{}}; } }
    if (this.credentials) {
      try { const key = await this.credentials.read(); if (key && this.validKey(key)) { this.key = key; this.storage = 'encrypted'; } } catch { this.credentialWarning = true; /* Local mode still starts. */ }
    }
  }
  status(): CloudStatus { return { provider: 'comfy-router', keyConfigured: !!this.key, storage: this.storage, canRemember: !!this.credentials, modelId: CLOUD_MODEL, modelName: MODEL_NAME, warnings: [...warnings,...(this.credentialWarning?['The saved key could not be opened. Reconnect a session key; local mode is unaffected.']:[]),...(this.historyUnavailable?['Cloud history is unreadable; hosted operations are blocked. Preserve cloud-state.json before recovery. Local mode is unaffected.']:[])] }; }
  private validKey(value: unknown): value is string { return typeof value === 'string' && /^comfyui-[^\s\x00-\x1f\x7f]{8,512}$/.test(value); }
  async setKey(body: unknown): Promise<CloudStatus> {
    // Do not let a validator include an invalid credential value in its issues.
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['apiKey','remember'].includes(k))) throw new HttpError(400, 'cloud_key', 'Provide a Comfy workspace key and optional remember choice.');
    const b = body as { apiKey?: unknown; remember?: unknown };
    if (!this.validKey(b.apiKey) || b.remember !== undefined && typeof b.remember !== 'boolean') throw new HttpError(400, 'cloud_key', 'Enter a valid Comfy workspace key.');
    if (this.workers.size || this.quoting || this.admission) throw new HttpError(409, 'cloud_busy', 'Finish or pause cloud tracking before changing the key.');
    try {
      if (b.remember) { if (!this.credentials) throw new Error('no secure store'); await this.credentials.write(b.apiKey); }
      else await this.credentials?.clear();
    } catch { throw new HttpError(503, 'cloud_secure_storage', 'Secure key storage is unavailable. Use a session-only connection instead.'); }
    this.credentialWarning = false; this.key = b.apiKey; this.storage = b.remember ? 'encrypted' : 'session'; this.keyEpoch = randomUUID(); this.quotes.clear();
    return this.status();
  }
  async clearKey(): Promise<CloudStatus> {
    this.key = undefined; this.keyEpoch = randomUUID(); this.storage = 'session'; this.quotes.clear();
    this.quoteController?.abort();
    for (const w of this.workers.values()) w.controller.abort();
    await Promise.all([this.quoteDone,...[...this.workers.values()].map(w=>w.promise)]);
    try { await this.credentials?.clear(); } catch { throw new HttpError(503, 'cloud_secure_storage', 'Session key removed, but the encrypted saved key could not be removed. Check local secure storage.'); }
    return this.status();
  }
  private requireKey(): string { if(this.historyUnavailable)throw new HttpError(503,'cloud_history','Cloud history is unreadable. Preserve it before recovery; local mode is unaffected.'); if (!this.key) throw new HttpError(409, 'cloud_key_missing', 'Connect your Comfy workspace key first.'); return this.key; }
  private async update(fn: (state: CloudState) => void): Promise<void> {
    const op = this.pending.then(async () => { const next = structuredClone(this.state); fn(next); const temporary = path.join(this.store.dir, `.cloud-${randomUUID()}.tmp`); await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, path.join(this.store.dir, 'cloud-state.json')); this.state = next; });
    this.pending = op.catch(() => undefined); return op;
  }
  private async patch(id: string, fn: (r: Record) => void): Promise<void> { await this.update(s => { const r = s.jobs[id]; if (r) { fn(r); r.job.updatedAt = new Date().toISOString(); r.manifest.job = r.job; } }); }
  list(): CloudJob[] { return Object.values(this.state.jobs).map(r => structuredClone(r.job)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): CloudJob { return structuredClone(this.record(id).job); }
  manifest(id: string): CloudManifest { return structuredClone(this.record(id).manifest); }
  private record(id: string): Record { const r = this.state.jobs[id]; if (!r) throw new HttpError(404, 'cloud_job_not_found', 'No cloud job has that ID.'); return r; }
  private async json(url: string, key: string, init: RequestInit = {}): Promise<{ body: any; response: Response }> {
    const u = new URL(url); if (u.origin !== API || !u.pathname.startsWith('/v2/models/')) throw new HttpError(500, 'cloud_target', 'Unexpected cloud target.');
    let response: Response;
    try { response = await this.transport(u, { ...init, headers: { 'X-API-Key': key, 'Content-Type': 'application/json', ...init.headers }, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
    catch { throw safeError(undefined); }
    if (response.status===409 && init.method==='PUT' && u.pathname.endsWith('/cancel')) { await response.body?.cancel(); return {body:{status:'ALREADY_COMPLETED'},response}; }
    if (!response.ok) { await response.body?.cancel(); throw safeFailure(response.status); }
    const reader = response.body?.getReader(); const decoder=new TextDecoder(); let data = ''; let bytes = 0;
    if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2_000_000) { await reader.cancel(); throw safeError(undefined); } data += decoder.decode(part.value, { stream: true }); }
    try { return { body: data ? JSON.parse(data) : {}, response }; } catch { throw safeError(undefined); }
  }
  private assetClient(key: string): Comfy {
    const previous = process.env.COMFY_BASE_URL;
    process.env.COMFY_BASE_URL = CLOUD;
    try {
      return new Comfy({ apiKey: key, clientInfo: 'open-genjutsu/optional-router', timeoutMs: 30000, fetch: async (input, init) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.origin !== CLOUD || !u.pathname.startsWith('/api/v2/assets')) throw new HttpError(502, 'cloud_asset_target', 'Unexpected cloud asset endpoint.');
        return this.transport(input, { ...init, redirect: 'manual' });
      } });
    } finally { if (previous === undefined) delete process.env.COMFY_BASE_URL; else process.env.COMFY_BASE_URL = previous; }
  }
  private async checkedAssets(input: CloudInput): Promise<{ source: StoredAsset; reference: StoredAsset }> {
    const s = this.store.snapshot(); const source = s.assets[input.sourceVideoId]; const reference = s.assets[input.referenceImageId];
    if (!source || source.asset.kind !== 'video' || !reference || reference.asset.kind !== 'image') throw new HttpError(400, 'cloud_assets', 'Choose a source video and reference image already uploaded to this app.');
    if (source.asset.mimeType !== 'video/mp4' || source.asset.bytes > 20 * 1024 * 1024 || !source.asset.duration || source.asset.duration > 15.05) throw new HttpError(400, 'cloud_video_limits', 'Use an MP4/MOV source up to15seconds and20MB. Whole originals are sent; local crop selections do not apply.');
    if (!['image/png','image/jpeg'].includes(reference.asset.mimeType) || reference.asset.bytes > 10 * 1024 * 1024) throw new HttpError(400, 'cloud_image_limits', 'Use a PNG/JPEG reference up to10MB.');
    for (const a of [source,reference]) if (!path.resolve(a.filename).startsWith(path.resolve(this.store.assetDir)+path.sep) || await sha256(a.filename) !== a.sha256) throw new HttpError(409, 'cloud_asset_changed', 'A local input changed. Upload it again before requesting a quote.');
    return { source, reference };
  }
  private async estimate(native: NativeInput, key: string, signal?: AbortSignal): Promise<string> {
    const {body} = await this.json(`${ROUTE}/estimate?fallback_provider=false`, key, { method: 'POST', body: JSON.stringify(native), signal });
    if (body.currency !== 'USD' || typeof body.amount !== 'string' || !/^\d+(\.\d{1,8})?$/.test(body.amount) || Number(body.amount) > 1000 || body.model && body.model !== CLOUD_MODEL) throw new HttpError(502, 'cloud_quote_unavailable', 'Comfy did not return a usable USD estimate. Generation remains blocked.');
    return body.amount;
  }
  async quote(body: unknown): Promise<CloudQuote> {
    if(this.closing)throw new HttpError(503,'cloud_closed','The application is closing.');
    const parsed = cloudInputSchema.extend({ uploadConsent: z.literal(true) }).parse(body);
    const { uploadConsent: _consent, ...input } = parsed;
    const key = this.requireKey(); const epoch = this.keyEpoch;
    if(input.prompt.includes('comfyui-'))throw new HttpError(400,'cloud_prompt','Do not include API keys in a generation prompt.');
    if (this.quoting || this.workers.size) throw new HttpError(409, 'cloud_busy', 'Wait for the current cloud operation before requesting another quote.');
    this.quoting = true; this.quoteController=new AbortController(); const signal=AbortSignal.any([this.quoteController.signal,AbortSignal.timeout(240000)]);
    let finishQuote!:()=>void; this.quoteDone=new Promise<void>(resolve=>{finishQuote=resolve;});
    try {
      const {source,reference} = await this.checkedAssets(input);
      const client = this.assetClient(key);
      const sourceHandle = client.assets.fromFile(source.filename); const referenceHandle = client.assets.fromFile(reference.filename);
      const sourceUrl = await sourceHandle.getDownloadUrl(signal); const referenceUrl = await referenceHandle.getDownloadUrl(signal);
      cloudStorageUrl(sourceUrl.url); cloudStorageUrl(referenceUrl.url);
      const native: NativeInput = { content: [{type:'text',text:input.prompt},{type:'image_url',image_url:{url:referenceUrl.url},role:'reference_image'},{type:'video_url',video_url:{url:sourceUrl.url},role:'reference_video'}], duration: input.duration, resolution: input.resolution, ratio: input.ratio, generate_audio: false };
      const amount = await this.estimate(native,key,signal);
      signal.throwIfAborted();
      if (this.closing || epoch !== this.keyEpoch) throw new HttpError(409, 'cloud_key_changed', 'The key changed. Request a fresh quote.');
      const expiry = Math.min(Date.now()+5*60_000,...[sourceUrl.expiresAt,referenceUrl.expiresAt].filter((d): d is Date => !!d).map(d => d.getTime()-60_000));
      if (expiry < Date.now()+30_000) throw new HttpError(409, 'cloud_media_expiry', 'The uploaded media link expires too soon. Request another quote.');
      for (const [id,q] of this.quotes) if (q.used || Date.parse(q.public.expiresAt)<Date.now()) this.quotes.delete(id);
      const value: CloudQuote = { id: randomUUID(), provider:'comfy-router', modelId:CLOUD_MODEL, modelName:MODEL_NAME, input, source:source.asset, reference:reference.asset, amount, currency:'USD', expiresAt:new Date(expiry).toISOString(), requestHash:digest(native), warnings };
      this.quotes.set(value.id,{public:value,native,keyEpoch:epoch,used:false}); return structuredClone(value);
    } catch (e) { throw safeError(e); } finally { this.quoting = false; this.quoteController=undefined; finishQuote(); }
  }
  async create(body: unknown): Promise<CloudJob> {
    const {quoteId} = z.object({quoteId:idSchema,consent:z.literal(true)}).strict().parse(body);
    this.requireKey();
    const q = this.quotes.get(quoteId);
    if (!q || q.used || q.keyEpoch !== this.keyEpoch || Date.parse(q.public.expiresAt) <= Date.now()) throw new HttpError(409,'cloud_quote_expired','This quote expired or was already used. Review a fresh quote before generating.');
    if (this.closing || this.workers.size || this.admission) throw new HttpError(409,'cloud_busy','Wait for the current cloud request.');
    this.admission=true;
    try {
    q.used = true; // Before the first await: a quote cannot admit two billable submissions.
    const source = this.store.snapshot().assets[q.public.input.sourceVideoId]!; const reference = this.store.snapshot().assets[q.public.input.referenceImageId]!;
    const id = randomUUID(); const now = new Date().toISOString();
    const job: CloudJob = {id,modelId:CLOUD_MODEL,input:q.public.input,quotedAmount:q.public.amount,currency:'USD',status:'queued',message:'Approved one hosted generation. Preparing submission.',outputs:[],createdAt:now,updatedAt:now,manifestUrl:`/api/cloud/jobs/${id}/manifest`};
    const manifest: CloudManifest = {version:1,app:'Open Genjutsu',provider:'comfy-router',modelId:CLOUD_MODEL,job,source:source.asset,reference:reference.asset,sourceSha256:source.sha256,referenceSha256:reference.sha256,requestHash:q.public.requestHash,quote:{amount:q.public.amount,currency:'USD',approvedAt:now},notice:'Whole originals uploaded to Comfy storage; no local crop/trim applied. Hosted proprietary model. Estimate is not final billing; confirm usage in Comfy workspace. No API keys or signed media URLs are included. Paid fallback is disabled.'};
    await this.update(s => {s.jobs[id]={job,manifest,native:q.native};});
    this.kick(id,false); return this.get(id);
    }finally{this.admission=false;}
  }
  private kick(id: string, recover: boolean): void {
    const controller = new AbortController();
    const promise = this.run(id,recover,controller.signal).catch(() => undefined).finally(() => this.workers.delete(id));
    this.workers.set(id,{promise,controller});
  }
  private async run(id: string, recover: boolean, signal: AbortSignal): Promise<void> {
    let terminalFailure = false;
    try {
      const key = this.requireKey(); let record = this.record(id);
      if (!recover) {
        await this.checkedAssets(record.job.input);
        const amount = await this.estimate(record.native,key,signal);
        if (Number(amount)>Number(record.job.quotedAmount)) throw new HttpError(409,'cloud_price_changed','The estimate increased. No generation was submitted; review a fresh quote.');
        if (this.record(id).cancelRequested) return;
        await this.patch(id,r => {if(r.cancelRequested)throw new HttpError(409,'cloud_cancelled','Cancelled before submission.');r.attempted=true;r.job.status='running';r.job.message='Submitting one hosted generation; tracking by its saved receipt.';});
        const {body} = await this.json(`${ROUTE}/requests?fallback_provider=false`,key,{method:'POST',headers:{'Idempotency-Key':id},body:JSON.stringify(record.native),signal});
        if (typeof body.request_id !== 'string' || !remoteId.test(body.request_id)) throw new HttpError(502,'cloud_receipt','Comfy did not return a valid request receipt. Check usage before starting another generation.');
        await this.patch(id,r => {r.job.requestId=body.request_id;});
        if(this.record(id).cancelRequested)await this.json(`${ROUTE}/requests/${encodeURIComponent(body.request_id)}/cancel`,key,{method:'PUT',signal});
      }
      record = this.record(id); const requestId = record.job.requestId;
      if (!requestId || !remoteId.test(requestId)) throw new HttpError(409,'cloud_no_receipt','Only requests with a confirmed provider ID can be followed. No generation was resubmitted.');
      const base = `${ROUTE}/requests/${encodeURIComponent(requestId)}`;
      const deadline = Date.now()+30*60_000; let failures=0;
      for (;;) {
        signal.throwIfAborted();
        let snap: {body:any;response:Response};
        try { snap = await this.json(`${base}/status`,key,{signal});failures=0; }
        catch(e) { if (signal.aborted || ++failures>=5) throw e;await pause(Math.min(this.pollMs*failures,10000),undefined,{signal});continue; }
        const {body,response} = snap;
        if (body.status==='COMPLETED') {
          if (body.error_type) {
            terminalFailure=true;const cancelled=['cancelled','canceled','request_cancelled','request_canceled'].includes(body.error_type);
            await this.patch(id,r => {r.job.status=cancelled?'cancelled':'failed';r.job.message=cancelled?'Comfy confirmed cancellation. Billing may still apply.':'Comfy reported generation failure. Check workspace billing for charges.';});return;
          }
          break;
        }
        await this.patch(id,r => {r.job.status='running';r.job.message=r.cancelRequested?'Cancellation requested; awaiting Comfy confirmation. Billing may still apply.':body.status==='IN_QUEUE'?'Queued at Comfy.':'Generating at Comfy. Progress percentage is not available.';});
        if (Date.now()>deadline) throw new HttpError(504,'cloud_tracking_timeout','Stopped tracking after30minutes. Follow the saved request again; do not resubmit.');
        const delay=Number(response.headers.get('retry-after'));await pause(Number.isFinite(delay)&&delay>0?Math.min(60_000,delay*1000):this.pollMs,undefined,{signal});
      }
      const {body} = await this.json(base,key,{signal});
      if (body.status!=='succeeded' || typeof body.content?.video_url!=='string') { terminalFailure=true;throw new HttpError(502,'cloud_no_output','The completed request returned no supported video. Check workspace billing.'); }
      const url=cloudStorageUrl(body.content.video_url);
      await this.patch(id,r => {r.job.message='Downloading the completed video to this device.';});
      const temporary=path.join(this.store.tempDir,`${randomUUID()}.part`);
      try {
        const response=await this.transport(url,{method:'GET',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
        if (!response.ok || Number(response.headers.get('content-length'))>MAX_FILE_BYTES || !response.body) {await response.body?.cancel();throw new HttpError(502,'cloud_output','The provider output could not be safely downloaded. Follow the saved request to retry download.');}
        const handle=await open(temporary,'wx',0o600);let size=0;
        try {const reader=response.body.getReader();try {for (;;) {const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_FILE_BYTES){await reader.cancel();throw new Error('size');}await handle.writeFile(chunk.value);}}finally{reader.releaseLock();}}finally{await handle.close();}
        if(!size)throw new Error('empty');const saved=await this.media.adopt(temporary,'seedance-2-reference-output.mp4','video');
        await this.patch(id,r => {r.job.status='succeeded';r.job.message='Hosted result downloaded. Review quality and final charges in Comfy billing.';r.job.outputs=[saved.asset];delete r.job.error;});
      }finally{await unlink(temporary).catch(()=>undefined);}
    }catch(e){
      const error=safeError(e);
      await this.patch(id,r => {if(r.job.status==='cancelled')return;const definitiveRejection=!r.job.requestId&&['cloud_unauthorized','cloud_insufficient_credits','cloud_not_enabled','cloud_input_rejected','cloud_rate_limited'].includes(error.code);const ambiguous=!terminalFailure&&!definitiveRejection&&(!!r.job.requestId||!!r.attempted);r.job.status=ambiguous?'interrupted':'failed';r.job.error=error.message;r.job.message=ambiguous?'Tracking interrupted. A generation may still be running or billed. Use Follow existing when a receipt exists; never blindly regenerate.':error.message;});
    }
  }
  async resume(id:string):Promise<CloudJob>{
    this.requireKey();const r=this.record(id);if(r.job.status!=='interrupted'||!r.job.requestId||!remoteId.test(r.job.requestId))throw new HttpError(409,'cloud_not_resumable','Only interrupted requests with a provider receipt can be followed. No generation will be resubmitted.');
    if(this.workers.size||this.closing||this.admission)throw new HttpError(409,'cloud_busy','Wait for the current cloud request.');this.admission=true;try{await this.patch(id,v=>{v.job.status='running';v.job.message='Following the existing provider receipt; no generation resubmitted.';delete v.job.error;});this.kick(id,true);return this.get(id);}finally{this.admission=false;}
  }
  async cancel(id:string):Promise<CloudJob>{
    const r=this.record(id);if(['succeeded','failed','cancelled'].includes(r.job.status))return this.get(id);
    await this.patch(id,v=>{v.cancelRequested=true;if(!v.attempted&&!v.job.requestId){v.job.status='cancelled';v.job.message='Cancelled before provider submission.';}else v.job.message='Requesting cancellation; this does not guarantee no charge.';});
    if(!r.attempted&&!r.job.requestId){this.workers.get(id)?.controller.abort();return this.get(id);}
    if(r.job.requestId){const key=this.requireKey();await this.json(`${ROUTE}/requests/${encodeURIComponent(r.job.requestId)}/cancel`,key,{method:'PUT'});}
    return this.get(id);
  }
  async close():Promise<void>{this.closing=true;this.keyEpoch=randomUUID();this.quotes.clear();this.quoteController?.abort();for(const w of this.workers.values())w.controller.abort();await Promise.all([this.quoteDone,...[...this.workers.values()].map(w=>w.promise)]);this.key=undefined;}
}
