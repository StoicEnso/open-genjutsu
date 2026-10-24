import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, Cloud, Film, FolderOpen, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { Asset, CloudInput, CloudJob, CloudQuote, CloudStatus } from '../shared/types';
import { api, formatBytes, formatDuration } from './api';
import { AssetInput } from './AssetInput';
import { Modal } from './Modal';
import { cloudInputIssue, quoteCanBeApproved, quotePrice } from './cloud-controls';

const active = new Set(['queued', 'uploading', 'running']);

export function CloudStudio() {
  const [status, setStatus] = useState<CloudStatus>();
  const [source, setSource] = useState<Asset>();
  const [reference, setReference] = useState<Asset>();
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState<CloudInput['resolution']>('480p');
  const [ratio, setRatio] = useState<CloudInput['ratio']>('16:9');
  const [uploadConsent, setUploadConsent] = useState(false);
  const [paidConsent, setPaidConsent] = useState(false);
  const [quote, setQuote] = useState<CloudQuote>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [jobs, setJobs] = useState<CloudJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [rememberKey, setRememberKey] = useState(false);
  const [busy, setBusy] = useState<'key' | 'quote' | 'submit' | 'job'>();
  const [picker, setPicker] = useState<'video' | 'image'>();
  const [savedAssets, setSavedAssets] = useState<Asset[]>([]);
  const keyInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);

  const input: CloudInput = { sourceVideoId: source?.id || '', referenceImageId: reference?.id || '', prompt: prompt.trim(), duration, resolution, ratio };
  const inputRef = useRef(input); inputRef.current = input;
  const issue = cloudInputIssue(input, source, reference);
  const validQuote = quoteCanBeApproved(quote, input, now);
  const selectedJob = jobs.find(job => job.id === selectedJobId);
  const output = selectedJob?.outputs.find(asset => asset.kind === 'video');

  const refresh = useCallback(async () => {
    const [nextStatus, nextJobs] = await Promise.all([api<CloudStatus>('/cloud/status'), api<CloudJob[]>('/cloud/jobs')]);
    setStatus(nextStatus); setJobs(nextJobs);
  }, []);

  useEffect(() => {
    let alive = true;
    void refresh().catch(() => { if (alive) setError('Cloud settings are unavailable. Check the local app server, then try again.'); }).finally(() => { if (alive) setLoading(false); });
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 4000);
    return () => { alive = false; window.clearInterval(timer); if (keyInput.current) keyInput.current.value = ''; };
  }, [refresh]);

  useEffect(() => {
    if (!quote) return;
    setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(quote.expiresAt) - Date.now() + 5));
    return () => window.clearTimeout(timer);
  }, [quote]);

  function invalidate() { setQuote(undefined); setPaidConsent(false); setUploadConsent(false); setReviewOpen(false); setError(''); }

  async function connect(event: FormEvent) {
    event.preventDefault();
    const key = keyInput.current?.value.trim() || '';
    if (!key || busy) return;
    if (keyInput.current) keyInput.current.value = '';
    setBusy('key'); setError(''); invalidate();
    try {
      await api('/cloud/key', { method: 'PUT', body: JSON.stringify({ apiKey: key, remember: rememberKey && Boolean(status?.canRemember) }) });
      await refresh(); setMessage(rememberKey && status?.canRemember ? 'Key encrypted on this Mac with operating system protection. It is not saved in this browser.' : 'Key added to the app server session. It is not saved in this browser.');
    } catch (cause) {
      const text = (cause as Error).message;
      setError(text.includes(key) ? 'The key could not be added. Check it and try again.' : text);
    } finally { setBusy(undefined); }
  }

  async function forget() {
    if (busy) return;
    setBusy('key'); setError(''); invalidate();
    try { await api('/cloud/key', { method: 'DELETE' }); await refresh(); setMessage('Cloud key removed. Local rendering is still available.'); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(undefined); }
  }

  async function upload(file: File, kind: 'video' | 'image') {
    const form = new FormData(); form.append('file', file);
    const asset = await api<Asset>('/assets', { method: 'POST', body: form });
    if (asset.kind !== kind) throw new Error(`Choose ${kind === 'video' ? 'a video' : 'an image'} file.`);
    invalidate(); if (kind === 'video') setSource(asset); else setReference(asset);
    return asset;
  }

  async function browse(kind: 'video' | 'image') {
    setError('');
    try { setSavedAssets((await api<Asset[]>('/assets')).filter(asset => asset.kind === kind)); setPicker(kind); }
    catch (cause) { setError((cause as Error).message); }
  }

  async function getQuote() {
    if (busy || issue || !status?.keyConfigured || !uploadConsent) return;
    const requested = input;
    setBusy('quote'); setError(''); setQuote(undefined); setPaidConsent(false);
    try {
      const result = await api<CloudQuote>('/cloud/quote', { method: 'POST', body: JSON.stringify({ ...requested, uploadConsent: true }) });
      if (!quoteCanBeApproved(result, inputRef.current, Date.now())) throw new Error('A valid price quote was not returned for these settings. No render was submitted. Request a fresh quote.');
      setNow(Date.now()); setQuote(result); setReviewOpen(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(undefined); }
  }

  async function submit() {
    if (submitting.current || busy || !paidConsent || !quote || !quoteCanBeApproved(quote, inputRef.current, Date.now()) || !status?.keyConfigured) return;
    submitting.current = true; setBusy('submit'); setError('');
    const quoteId = quote.id;
    // Remove approval before the request; a failed/ambiguous POST is never retried.
    setPaidConsent(false); setQuote(undefined); setReviewOpen(false); setUploadConsent(false);
    try {
      const job = await api<CloudJob>('/cloud/jobs', { method: 'POST', body: JSON.stringify({ quoteId, consent: true }) });
      setSelectedJobId(job.id); setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]);
      setMessage('One cloud render submitted. Track this job here; it will not fall back to another provider.');
    } catch (cause) { setError(`${(cause as Error).message} Check cloud takes before requesting another render; this submission was not retried.`); }
    finally { submitting.current = false; setBusy(undefined); await refresh().catch(() => undefined); }
  }

  async function jobAction(job: CloudJob, action: 'cancel' | 'resume') {
    if (busy) return;
    setBusy('job'); setError('');
    try { await api(`/cloud/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: '{}' }); await refresh(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(undefined); }
  }

  return <div className="cloud-studio">
    <main className="cloud-workspace">
      <div className="workspace-heading"><div><div className="eyebrow">COMFY ROUTER · YOUR API KEY</div><h1>A separate cloud take.</h1></div><Cloud size={24} aria-hidden="true" /></div>
      <p className="cloud-intro">Use a hosted video model with your own Comfy account. This sends your selected original files outside this Mac. Local rendering stays available in the Local tab.<span className="cloud-validation-badge">Cloud output quality unverified</span></p>
      {error && <div className="banner error cloud-banner" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss cloud error" onClick={() => setError('')}><X size={16} /></button></div>}
      {message && <div className="cloud-message" role="status"><Check size={15} /><span>{message}</span><button type="button" aria-label="Dismiss cloud message" onClick={() => setMessage('')}><X size={14} /></button></div>}

      <section className="cloud-result" aria-label="Cloud result">
        {output ? <video key={output.id} src={output.url} poster={output.thumbnailUrl} controls playsInline preload="metadata" /> : <div className="cloud-result-empty">{selectedJob && active.has(selectedJob.status) ? <LoaderCircle size={32} className="spin" /> : <Film size={32} />}<h2>{selectedJob ? cloudStatusLabel(selectedJob.status) : 'Your cloud output appears here.'}</h2><p>{selectedJob?.error || selectedJob?.message || 'Choose both references, review a price, then approve one render.'}</p></div>}
      </section>
      {selectedJob && <div className="cloud-result-meta"><span>{cloudStatusLabel(selectedJob.status)}</span><div><a href={selectedJob.manifestUrl} download><FolderOpen size={14} />Receipt</a>{output && <a href={output.url} download={output.name}><ArrowDownToLine size={14} />Video</a>}{selectedJob.status === 'interrupted' && selectedJob.requestId && <button disabled={Boolean(busy)} onClick={() => void jobAction(selectedJob, 'resume')}><RefreshCw size={14} />Reconnect</button>}{active.has(selectedJob.status) && <button disabled={Boolean(busy)} onClick={() => void jobAction(selectedJob, 'cancel')}>Cancel this job</button>}</div></div>}
      <p className="honest-note cloud-result-note">The hosted model uses your video and image as references. Exact motion, likeness and scene preservation are not guaranteed. This cloud route is separate from the open local model.</p>

      <section className="cloud-history" aria-label="Cloud takes"><div className="cloud-section-title"><h2>Cloud takes</h2><button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => void refresh().catch(() => setError('Could not refresh cloud takes. Try again.'))}><RefreshCw size={13} />Refresh</button></div>
        {!jobs.length ? <p className="field-hint">No cloud render submitted in this workspace. A quote does not create a render.</p> : <div className="cloud-job-list">{jobs.map(job => <button type="button" key={job.id} className={`cloud-job ${selectedJobId === job.id ? 'selected' : ''}`} onClick={() => setSelectedJobId(job.id)}><span>{active.has(job.status) ? <LoaderCircle size={14} className="spin" /> : <Film size={14} />}<strong>{cloudStatusLabel(job.status)}</strong><small>{new Date(job.createdAt).toLocaleString()}</small></span><ArrowUpRight size={15} /></button>)}</div>}
      </section>
    </main>

    <aside className="cloud-inspector" aria-label="Cloud render settings">
      <div className="inspector-title"><Cloud size={16} /><h2>Comfy Router</h2><span>OPTIONAL · PAID</span></div>
      <div className="cloud-inspector-content">
        <section className="cloud-key-section" aria-label="Cloud API key">
          <div className="cloud-section-title"><h3><KeyRound size={14} />Your Comfy key</h3><span className={`status-chip ${status?.keyConfigured ? 'ready' : ''}`}>{loading ? 'Checking…' : status?.keyConfigured ? 'Key available' : 'Not set'}</span></div>
          <form onSubmit={event => void connect(event)}><label className="modal-field" htmlFor="cloud-api-key">API key<input ref={keyInput} id="cloud-api-key" type="password" required autoComplete="off" spellCheck={false} disabled={Boolean(busy)} placeholder="Paste your Comfy API key…" /></label>{status?.canRemember && <label className="cloud-remember"><input type="checkbox" checked={rememberKey} disabled={Boolean(busy)} onChange={event => setRememberKey(event.target.checked)} /><span>Remember securely on this Mac</span></label>}<div className="cloud-key-actions"><button className="quiet-button" type="submit" disabled={Boolean(busy)}>{busy === 'key' && <LoaderCircle size={13} className="spin" />}{status?.keyConfigured ? 'Replace key' : 'Add key'}</button>{status?.keyConfigured && <button className="quiet-button" type="button" disabled={Boolean(busy)} onClick={() => void forget()}>Forget key</button>}</div></form>
          <p className="field-hint"><a href="https://platform.comfy.org" target="_blank" rel="noreferrer">Manage keys in your Comfy workspace</a>. {status?.storage === 'encrypted' ? 'Encrypted on this Mac with operating system protection.' : 'Held in this app server session; forgotten when the server closes.'} The key is never saved in browser storage or a render receipt.</p>
        </section>
        <div className="cloud-model"><span>Provider</span><strong>Comfy Router</strong><span>Hosted model</span><strong>{status?.modelName || 'Loading model…'}</strong>{status?.modelId && <code>{status.modelId}</code>}</div>

        <fieldset className="cloud-fields" disabled={Boolean(busy)}>
          <div className="input-heading"><label>Whole driving video</label><span>01</span></div>
          <AssetInput kind="video" accept="video/mp4,video/quicktime" asset={source} onUpload={file => upload(file, 'video')} onError={setError} onRemove={() => { invalidate(); setSource(undefined); }} />
          <button type="button" className="browse-assets" onClick={() => void browse('video')}><FolderOpen size={11} />Choose a saved clip</button>
          <p className={`field-hint ${source && (!source.duration || source.duration > 15) ? 'invalid-window' : ''}`}>MP4/MOV · up to 15 seconds and 20 MB. Sends the entire clip, without the Local tab’s crop or start selection.</p>
          <div className="input-heading"><label>Whole character reference</label><span>02</span></div>
          <AssetInput kind="image" accept="image/png,image/jpeg" asset={reference} onUpload={file => upload(file, 'image')} onError={setError} onRemove={() => { invalidate(); setReference(undefined); }} />
          <button type="button" className="browse-assets" onClick={() => void browse('image')}><FolderOpen size={11} />Choose a saved reference</button>
          <p className="field-hint">PNG/JPEG · up to 10 MB. The original image is sent. Use files you have permission to upload and use.</p>
          <div className="input-heading"><label htmlFor="cloud-direction">Direction</label><span>03</span></div>
          <textarea id="cloud-direction" value={prompt} rows={4} maxLength={1800} onChange={event => { invalidate(); setPrompt(event.target.value); }} placeholder="Describe the intended character, motion and scene…" />
          <p className="field-hint">{prompt.length}/1,800 characters · silent video output</p>
          <div className="cloud-render-fields"><label htmlFor="cloud-duration">Output seconds<input id="cloud-duration" type="number" min={4} max={15} step={1} value={duration} onChange={event => { invalidate(); setDuration(Number(event.target.value)); }} /></label><label htmlFor="cloud-resolution">Resolution<select id="cloud-resolution" value={resolution} onChange={event => { invalidate(); setResolution(event.target.value as CloudInput['resolution']); }}><option value="480p">480p</option><option value="720p">720p</option></select></label><label htmlFor="cloud-ratio">Aspect ratio<select id="cloud-ratio" value={ratio} onChange={event => { invalidate(); setRatio(event.target.value as CloudInput['ratio']); }}><option value="16:9">16:9 · Landscape</option><option value="9:16">9:16 · Portrait</option><option value="1:1">1:1 · Square</option></select></label></div>
          <label className="cloud-consent"><input type="checkbox" checked={uploadConsent} onChange={event => setUploadConsent(event.target.checked)} /><span>Send these whole files to Comfy Router for a price quote. This uploads the media but does not start a render.</span></label>
        </fieldset>
        {status?.warnings.map((warning, index) => <p key={index} className="field-hint cloud-warning">{warning}</p>)}
        <div className="cloud-quote-action">{validQuote && <button type="button" className="quiet-button cloud-review-again" disabled={Boolean(busy)} onClick={() => { setPaidConsent(false); setReviewOpen(true); }}>Review {quotePrice(quote!)} quote<ArrowUpRight size={13} /></button>}<button type="button" className="render-button" disabled={Boolean(busy) || loading || !status?.keyConfigured || Boolean(issue) || !uploadConsent} onClick={() => void getQuote()}>{busy === 'quote' ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}<span>{busy === 'quote' ? 'Uploading for a quote…' : 'Upload & get price'}</span><ArrowUpRight size={16} /></button><p className="field-hint">{issue || (!status?.keyConfigured ? 'Add a key to request a quote.' : !uploadConsent ? 'Approve the file upload above to continue.' : 'No render charge until you review and approve the returned price.')}</p></div>
      </div>
    </aside>

    {reviewOpen && quote && <Modal title="Review this cloud render" wide onClose={() => { setReviewOpen(false); setPaidConsent(false); }}>
      <p className="modal-intro">One hosted video via Comfy Router. Check the exact request and quoted charge before submitting.</p>
      <div className="cloud-review-assets"><ReviewAsset title="Whole source clip" asset={quote.source} /><ReviewAsset title="Whole reference image" asset={quote.reference} /></div>
      <dl className="cloud-review-details"><div><dt>Provider</dt><dd>Comfy Router</dd></div><div><dt>Model</dt><dd>{quote.modelName}<small>{quote.modelId}</small></dd></div><div><dt>Output</dt><dd>{quote.input.duration}s · {quote.input.resolution} · {quote.input.ratio} · 1 video · silent</dd></div><div><dt>Direction</dt><dd className="cloud-review-prompt">{quote.input.prompt}</dd></div></dl>
      <div className="cloud-price"><div><span>Estimated render charge</span><strong>{quotePrice(quote)}</strong></div><p>{validQuote ? `Estimate expires at ${new Date(quote.expiresAt).toLocaleTimeString()}.` : 'This quote expired or no longer matches your inputs. Close this review and request a new quote.'}</p></div>
      {quote.warnings.map((warning, index) => <p key={index} className="field-hint cloud-warning">{warning}</p>)}
      <label className="cloud-consent cloud-pay-consent"><input type="checkbox" checked={paidConsent} disabled={!validQuote || Boolean(busy)} onChange={event => setPaidConsent(event.target.checked)} /><span>I approve one paid render on my Comfy account at the provider’s {quotePrice(quote)} estimate, using the files and settings above.</span></label>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={() => { setReviewOpen(false); setPaidConsent(false); }}>Back to settings</button><button type="button" className="primary-small cloud-paid-button" disabled={!validQuote || !paidConsent || Boolean(busy) || !status?.keyConfigured} onClick={() => void submit()}>Approve {quotePrice(quote)} & render<ArrowUpRight size={15} /></button></div>
      <p className="field-hint cloud-review-footnote">The amount is a provider estimate, not a billing cap. A failed or ambiguous submission is never automatically retried. Provider terms and retention policy apply.</p>
    </Modal>}
    {picker && <Modal title={picker === 'video' ? 'Choose a saved cloud source' : 'Choose a saved cloud reference'} wide onClose={() => setPicker(undefined)}><p className="modal-intro">These files are saved locally. Nothing is sent to the cloud until you approve the upload and request a quote.</p>{!savedAssets.length ? <p className="field-hint">No matching files saved. Upload one in the cloud panel.</p> : <div className="asset-picker-grid">{savedAssets.map(asset => <button type="button" className="saved-asset" key={asset.id} onClick={() => { invalidate(); if (asset.kind === 'video') setSource(asset); else setReference(asset); setPicker(undefined); }}><div>{asset.thumbnailUrl || asset.kind === 'image' ? <img src={asset.thumbnailUrl || asset.url} alt="" /> : <Film size={24} />}</div><strong>{asset.name}</strong><span>{asset.width} × {asset.height} · {asset.kind === 'video' ? formatDuration(asset.duration) : formatBytes(asset.bytes)}</span></button>)}</div>}</Modal>}
  </div>;
}

function ReviewAsset({ title, asset }: { title: string; asset: Asset }) {
  return <div className="cloud-review-asset"><div>{asset.thumbnailUrl || asset.kind === 'image' ? <img src={asset.thumbnailUrl || asset.url} alt={title} /> : <Film size={24} />}</div><section><span>{title}</span><strong>{asset.name}</strong><small>{asset.width} × {asset.height} · {asset.kind === 'video' ? `${formatDuration(asset.duration)} · ` : ''}{formatBytes(asset.bytes)}</small></section></div>;
}

function cloudStatusLabel(status: CloudJob['status']): string {
  return ({ queued: 'Queued', uploading: 'Preparing inputs', running: 'Rendering in cloud', succeeded: 'Complete', failed: 'Render failed', cancelled: 'Cancelled', interrupted: 'Tracking interrupted' })[status];
}
