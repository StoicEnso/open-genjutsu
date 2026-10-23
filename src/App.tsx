import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronDown, CircleHelp,
  Clapperboard, Cloud, Code2, Film, FolderOpen, GitBranch, ImagePlus, LoaderCircle, Monitor,
  Pause, Play, Plus, RefreshCw, ScanFace, Settings2, SlidersHorizontal,
  Sparkles, Upload, X,
} from 'lucide-react';
import type { Asset, BackendStatus, CropRegion, Job, JobManifest, Settings, WorkflowPack } from '../shared/types';
import { api, formatBytes, formatDuration } from './api';
import { CropEditor } from './CropEditor';
import { AssetInput } from './AssetInput';
import { Modal } from './Modal';
import { CloudStudio } from './CloudStudio';
import { sourceCanvas, squareCrop, workflowDefaults } from './workflow-controls';

type View = 'studio' | 'library' | 'workflows';
type Mode = 'recast' | 'reshoot' | 'batch';
const defaultPrompt = 'A single performer follows the motion of the driving video. Preserve the reference character’s appearance and outfit. Natural movement, consistent proportions, coherent lighting.';
const reshootPrompt = 'Follow the performance and timing in the driving video. Keep the reference character consistent. A cinematic medium shot, soft studio lighting, a minimal new background, deliberate camera movement.';
const defaultSettings: Settings = { comfyUrl: 'http://127.0.0.1:8188', proxyUrl: 'http://127.0.0.1:8189' };
const activeStatuses = new Set(['queued', 'uploading', 'running']);

export default function App() {
  const [view, setView] = useState<View>('studio');
  const [renderEngine, setRenderEngine] = useState<'local' | 'cloud'>('local');
  const [mode, setMode] = useState<Mode>('recast');
  const [source, setSource] = useState<Asset>();
  const [characters, setCharacters] = useState<Asset[]>([]);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [workflowId, setWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<WorkflowPack[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [restoredJobId, setRestoredJobId] = useState<string>();
  const [restoredManifest, setRestoredManifest] = useState<JobManifest>();
  const [backend, setBackend] = useState<BackendStatus>();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(defaultSettings);
  const [seed, setSeed] = useState(42);
  const [width, setWidth] = useState(256);
  const [height, setHeight] = useState(256);
  const [frames, setFrames] = useState(17);
  const [startSeconds, setStartSeconds] = useState(0);
  const [fps, setFps] = useState(24);
  const [motionStrength, setMotionStrength] = useState(.35);
  const [sourceCrop, setSourceCrop] = useState<CropRegion>();
  const [referenceCrops, setReferenceCrops] = useState<Record<string, CropRegion>>({});
  const [cropAspects, setCropAspects] = useState<Record<string, number>>({});
  const [cropEditor, setCropEditor] = useState<{ kind: 'source' | 'reference'; asset: Asset }>();
  const [selectedManifest, setSelectedManifest] = useState<JobManifest>();
  const sourcePlayer = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiOnline, setApiOnline] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [compare, setCompare] = useState<'split' | 'wipe'>('split');
  const [workflowInspect, setWorkflowInspect] = useState<WorkflowPack>();
  const [assetPicker, setAssetPicker] = useState<'video' | 'image'>();
  const [savedAssets, setSavedAssets] = useState<Asset[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const loadedDefaults = useRef('');

  const selectedJob = jobs.find(job => job.id === selectedJobId);
  const selectedWorkflow = restoredJobId ? restoredManifest?.workflow : workflows.find(workflow => workflow.id === workflowId);
  const effectiveFps = selectedWorkflow?.bindings.fps ? fps : workflowDefaults(selectedWorkflow).fps;
  const requestedDuration = frames / effectiveFps;
  const portrait = selectedWorkflow?.metadata?.portrait;
  const requiresCrops = Boolean(portrait && typeof portrait === 'object' && !Array.isArray(portrait) && portrait.requiresCrop);
  const cropsReady = !requiresCrops || Boolean(squareCrop(sourceCrop, source, source && cropAspects[source.id]) && characters.every(asset => squareCrop(referenceCrops[asset.id], asset, cropAspects[asset.id])));
  const clipFits = Number.isFinite(startSeconds) && startSeconds >= 0 && startSeconds <= 29 && (!source?.duration || startSeconds + requestedDuration <= source.duration + 0.001);
  const matchedSource = selectedManifest?.preprocessing?.preparedSource || source;
  const currentOutput = selectedJob?.status === 'succeeded' ? selectedJob.outputs.find(output => output.kind === 'video') : undefined;
  const activeJobCount = jobs.filter(job => activeStatuses.has(job.status)).length;
  const canRender = Boolean(source && characters.length && selectedWorkflow && apiOnline && backend?.ready && !busy && cropsReady && (!selectedWorkflow?.bindings.motionStrength || Number.isFinite(motionStrength) && motionStrength >= 0 && motionStrength <= 1) &&
    (!selectedWorkflow.bindings.width || width >= 128 && width <= 480 && width % 16 === 0) &&
    (!selectedWorkflow.bindings.height || height >= 128 && height <= 480 && height % 16 === 0) &&
    (!selectedWorkflow.bindings.frames || frames >= 5 && frames <= 49 && frames % 4 === 1) && clipFits && Number.isInteger(effectiveFps) && effectiveFps >= 8 && effectiveFps <= 30);

  const refresh = useCallback(async () => {
    try {
      const [nextBackend, nextJobs] = await Promise.all([
        api<BackendStatus>(`/backend/status${restoredJobId ? `?jobId=${encodeURIComponent(restoredJobId)}` : workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''}`),
        api<Job[]>('/jobs'),
      ]);
      setBackend(nextBackend); setJobs(nextJobs); setApiOnline(true);
    } catch { setApiOnline(false); }
  }, [workflowId, restoredJobId]);

  useEffect(() => {
    let alive = true;
    void Promise.all([api<WorkflowPack[]>('/workflows'), api<Settings>('/settings')])
      .then(([packs, config]) => {
        if (!alive) return;
        setWorkflows(packs); setWorkflowId(previous => packs.some(pack => pack.id === previous) ? previous : packs.find(pack => pack.id === 'liveportrait-portrait')?.id || packs.find(pack => pack.id === 'wan-vace-human-quality')?.id || packs.find(pack => pack.id === 'wan-vace-1-3b-detail')?.id || packs[0]?.id || ''); setSettings(config); setSettingsDraft(config);
      }).catch((cause: Error) => { if (alive) { setApiOnline(false); setError(cause.message); } });
    return () => { alive = false; };
  }, [apiOnline]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedJobId) { setSelectedManifest(undefined); return; }
    let alive = true;
    void api<JobManifest>(`/jobs/${selectedJobId}/manifest`).then(manifest => { if (alive) setSelectedManifest(manifest); }).catch(() => undefined);
    return () => { alive = false; };
  }, [selectedJobId, selectedJob?.updatedAt]);

  useEffect(() => {
    if (restoredJobId) { loadedDefaults.current = ''; return; }
    const pack = workflows.find(item => item.id === workflowId);
    if (!pack) return;
    const key = `${pack.id}:${pack.updatedAt}`;
    if (loadedDefaults.current === key) return;
    loadedDefaults.current = key;
    const defaults = workflowDefaults(pack);
    if (pack.metadata?.portrait) setMode(current => current === 'reshoot' ? 'recast' : current);
    setWidth(defaults.width); setHeight(defaults.height); setFrames(defaults.frames); setSeed(defaults.seed); setFps(defaults.fps); setMotionStrength(defaults.motionStrength);
    if (mode === 'reshoot') setPrompt(reshootPrompt);
    else if (defaults.prompt) setPrompt(defaults.prompt);
  }, [workflowId, workflows, restoredJobId]);

  useEffect(() => { if (sourcePlayer.current) sourcePlayer.current.currentTime = startSeconds; }, [startSeconds]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function upload(file: File, kind: 'video' | 'image') {
    setError('');
    const form = new FormData(); form.append('file', file);
    const asset = await api<Asset>('/assets', { method: 'POST', body: form });
    if (asset.kind !== kind) throw new Error(`Please choose ${kind === 'video' ? 'a video' : 'an image'} file.`);
    setSelectedJobId(undefined);
    if (kind === 'video') { setSource(asset); setStartSeconds(0); setSourceCrop(undefined); }
    else setCharacters(previous => mode === 'batch' ? [...previous, asset].slice(0, 5) : [asset]);
    return asset;
  }

  async function render() {
    if (!canRender || !source || !selectedWorkflow) return;
    setBusy(true); setError('');
    const queued: Job[] = [];
    try {
      for (const character of mode === 'batch' ? characters : characters.slice(0, 1)) {
        const parameters = Object.fromEntries(Object.entries({ prompt, seed, width, height, frames, fps, motionStrength }).filter(([key]) => key in selectedWorkflow.bindings));
        const payload = { ...parameters, startSeconds, ...(sourceCrop ? { sourceCrop } : {}), ...(referenceCrops[character.id] ? { referenceCrop: referenceCrops[character.id] } : {}), sourceVideoId: source.id, referenceImageId: character.id, ...(restoredJobId ? {} : { workflowId }) };
        queued.push(await api<Job>(restoredJobId ? `/jobs/${restoredJobId}/rerun` : '/jobs', { method: 'POST', body: JSON.stringify(payload) }));
        if (queued.length === 1) setSelectedJobId(queued[0].id);
      }
      setSelectedJobId(queued[0]?.id);
      setNotice(`${queued.length === 1 ? 'Render' : `${queued.length} renders`} queued on your Comfy engine.`);
    } catch (cause) { setError(`${queued.length ? `${queued.length} render(s) were queued before this error. ` : ''}${(cause as Error).message}`); }
    finally { setBusy(false); await refresh(); }
  }

  async function reopen(job: Job) {
    setError('');
    try {
      const manifest = await api<JobManifest>(`/jobs/${job.id}/manifest`);
      setRestoredJobId(job.id); setRestoredManifest(manifest); setSelectedManifest(manifest);
      setSource(manifest.source); setCharacters([manifest.reference]);
      setSourceCrop(manifest.preprocessing?.sourceCrop ?? job.parameters.sourceCrop);
      const savedReferenceCrop = manifest.preprocessing?.referenceCrop ?? job.parameters.referenceCrop;
      setReferenceCrops(savedReferenceCrop ? { [manifest.reference.id]: savedReferenceCrop } : {});
      const defaults = workflowDefaults(manifest.workflow);
      setPrompt(job.parameters.prompt ?? defaults.prompt ?? defaultPrompt); setSeed(job.parameters.seed ?? defaults.seed);
      setWidth(job.parameters.width ?? defaults.width); setHeight(job.parameters.height ?? defaults.height); setFrames(job.parameters.frames ?? defaults.frames);
      setFps(manifest.preprocessing?.fps ?? job.parameters.fps ?? defaults.fps); setStartSeconds(manifest.preprocessing?.startSeconds ?? job.parameters.startSeconds ?? 0);
      setMotionStrength(job.parameters.motionStrength ?? defaults.motionStrength);
      setWorkflowId(job.workflowId); setSelectedJobId(job.id); setMode('recast'); setRenderEngine('local'); setView('studio');
    } catch (cause) { setError((cause as Error).message); }
  }

  async function importWorkflow(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setError('');
    try {
      const data: unknown = JSON.parse(await file.text());
      const pack = await api<WorkflowPack>('/workflows/import', { method: 'POST', body: JSON.stringify(data) });
      setWorkflows(previous => [...previous.filter(item => item.id !== pack.id), pack]); setWorkflowId(pack.id);
      setNotice(`Imported ${pack.name}.`);
    } catch (cause) { setError(`Could not import the workflow pack: ${(cause as Error).message}`); }
  }

  async function saveSettings() {
    setBusy(true); setError('');
    try {
      const saved = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settingsDraft) });
      setSettings(saved); setSettingsOpen(false); setNotice('Engine settings saved.'); await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function browseAssets(kind: 'video' | 'image') {
    setError('');
    try { setSavedAssets((await api<Asset[]>('/assets')).filter(asset => asset.kind === kind)); setAssetPicker(kind); }
    catch (cause) { setError((cause as Error).message); }
  }

  function useSavedAsset(asset: Asset) {
    if (asset.kind === 'video') { setSource(asset); setStartSeconds(0); setSourceCrop(undefined); }
    else setCharacters(previous => mode === 'batch' ? [...previous.filter(item => item.id !== asset.id), asset].slice(0, 5) : [asset]);
    setSelectedJobId(undefined); setAssetPicker(undefined);
  }

  const chooseMode = (next: Mode) => {
    setMode(next); setSelectedJobId(undefined); setRestoredJobId(undefined); setRestoredManifest(undefined);
    if (next !== 'batch') setCharacters(previous => previous.slice(0, 1));
    if (next === 'reshoot') setPrompt(reshootPrompt);
    if (next === 'recast') setPrompt(workflowDefaults(selectedWorkflow).prompt ?? defaultPrompt);
  };

  return <div className="app-shell">
    <aside className="rail" aria-label="Main navigation">
      <button className="brand" aria-label="Open Genjutsu studio" onClick={() => setView('studio')}><img src="/mark.svg" alt="" /></button>
      <div className="rail-main">
        <NavButton active={view === 'studio'} onClick={() => setView('studio')} icon={<Clapperboard />} label="Studio" />
        <NavButton active={view === 'library'} onClick={() => setView('library')} icon={<FolderOpen />} label="Library" count={jobs.length || undefined} />
        <NavButton active={view === 'workflows'} onClick={() => setView('workflows')} icon={<GitBranch />} label="Workflows" />
      </div>
      <div className="rail-bottom">
        <a className="nav-button" href="https://github.com/StoicEnso/open-genjutsu" target="_blank" rel="noreferrer" aria-label="Source on GitHub"><Code2 /><span>Source</span></a>
        <NavButton onClick={() => { setSettingsDraft(settings); setSettingsOpen(true); }} icon={<Settings2 />} label="Engine" />
        <span className="version">v0.3</span>
      </div>
    </aside>

    <div className="app-main">
      <header className="topbar">
        <div className="wordmark">OPEN GENJUTSU <span className="alpha">EARLY BUILD</span></div>
        <div className="topbar-actions">
          {activeJobCount > 0 && <button className="queue-pill" onClick={() => setView('library')}><LoaderCircle className="spin" size={13} />{activeJobCount} in queue</button>}
          {renderEngine === 'cloud' ? <span className="engine-pill cloud-mode-pill"><Cloud size={13} />Cloud mode · BYOK</span> : <button className={`engine-pill ${backend?.ready ? 'online' : ''}`} onClick={() => { setSettingsDraft(settings); setSettingsOpen(true); }}>
            <span className="status-dot" />{!apiOnline ? 'App server offline' : backend?.ready ? 'Engine ready' : backend?.connected ? 'Setup required' : 'Connect engine'}<ChevronDown size={12} />
          </button>}
          <span className="local-tag">LOCAL WORKSPACE</span>
        </div>
      </header>

      {error && <div className="banner error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      {!apiOnline && <div className="banner error" role="status">The local app server is unavailable. Start it with <code>npm run dev</code> or reopen the Mac app.<button onClick={() => void refresh()}><RefreshCw size={14} />Retry</button></div>}

      {view === 'studio' && <div className="render-engine-choice" aria-label="Render location"><span>Render with</span><div><button type="button" aria-pressed={renderEngine === 'local'} onClick={() => setRenderEngine('local')}><Monitor size={14} /><strong>Local</strong><small>Your Comfy engine</small></button><button type="button" aria-pressed={renderEngine === 'cloud'} onClick={() => setRenderEngine('cloud')}><Cloud size={14} /><strong>Comfy Router</strong><small>Optional · uses Comfy credits</small></button></div></div>}
      {view === 'studio' && renderEngine === 'cloud' && <CloudStudio />}

      {view === 'studio' && renderEngine === 'local' && <div className="studio-layout">
        <main className="workspace">
          <div className="workspace-heading">
            <div><div className="eyebrow">MOTION IN. NEW POSSIBILITIES OUT.</div><h1>{selectedJob ? 'Your take, reimagined.' : 'Give your motion a new cast.'}</h1></div>
            <button className="quiet-button" onClick={() => { setSource(undefined); setCharacters([]); setSelectedJobId(undefined); setRestoredJobId(undefined); setRestoredManifest(undefined); setPrompt(defaultPrompt); setStartSeconds(0); setSourceCrop(undefined); setReferenceCrops({}); }}><Plus size={15} />New take</button>
          </div>

          {restoredJobId && <div className="saved-recipe"><GitBranch size={13} /><span>Using this take’s saved workflow and original engine.</span><span className="saved-engine">{restoredManifest?.settings.comfyUrl}</span></div>}

          <div className="mode-tabs" aria-label="Creation mode">
            <button className={mode === 'recast' ? 'selected' : ''} onClick={() => chooseMode('recast')}><ScanFace size={15} />Character recast</button>
            <button disabled={requiresCrops} title={requiresCrops ? 'Choose a VACE workflow for scene resynthesis' : undefined} className={mode === 'reshoot' ? 'selected' : ''} onClick={() => chooseMode('reshoot')}><Film size={15} />Scene reshoot</button>
            <button className={mode === 'batch' ? 'selected' : ''} onClick={() => chooseMode('batch')}><ImagePlus size={15} />Batch casting</button>
          </div>

          <section className={`stage ${source ? 'has-source' : ''}`} aria-label="Video workspace">
            {currentOutput && source ? <>
              <Comparison source={matchedSource?.url || source.url} sourcePoster={matchedSource?.thumbnailUrl} output={currentOutput.url} outputPoster={currentOutput.thumbnailUrl} initialDuration={currentOutput.duration} mode={compare} />
              <div className="compare-options"><button className={compare === 'split' ? 'selected' : ''} onClick={() => setCompare('split')}>Side by side</button><button className={compare === 'wipe' ? 'selected' : ''} onClick={() => setCompare('wipe')}>Wipe</button></div>
            </> : source ? <>
              <video ref={sourcePlayer} className="source-player" src={source.url} poster={source.thumbnailUrl} controls playsInline preload="metadata" onLoadedMetadata={event => { event.currentTarget.currentTime = startSeconds; }} />
              <span className="media-badge">SOURCE PERFORMANCE</span>
              {selectedJob && <div className={`render-overlay ${activeStatuses.has(selectedJob.status) ? 'render-active' : ''}`}>
                {activeStatuses.has(selectedJob.status) && <LoaderCircle className="spin" size={26} />}
                <strong>{statusLabel(selectedJob.status)}</strong><p>{selectedJob.error || selectedJob.message}</p>
                {activeStatuses.has(selectedJob.status) && <small>{formatDuration(Math.max(0, (Date.now() - Date.parse(selectedJob.createdAt)) / 1000))} since queued · This local engine may not report step progress.</small>}
                {selectedJob.progress > 0 && activeStatuses.has(selectedJob.status) && <progress value={selectedJob.progress} max={1} />}
                {selectedJob.status === 'interrupted' && selectedJob.promptId && <button className="quiet-button" onClick={async () => { try { await api(`/jobs/${selectedJob.id}/resume`, { method: 'POST', body: '{}' }); await refresh(); } catch (cause) { setError((cause as Error).message); } }}><RefreshCw size={14} />Reconnect to this job</button>}
                {activeStatuses.has(selectedJob.status) && <button className="quiet-button" onClick={async () => { try { await api(`/jobs/${selectedJob.id}/cancel`, { method: 'POST', body: '{}' }); await refresh(); } catch (cause) { setError((cause as Error).message); } }}>Cancel this job</button>}
              </div>}
            </> : <UploadStage onUpload={file => upload(file, 'video')} onError={setError} />}
          </section>

          <div className="stage-footer">
            <div className="stage-meta"><span className="frame-icon"><Film size={14} /></span><span>{source ? source.name : 'No source clip selected'}</span>{source && <><span className="meta-divider" /><span>{source.width} × {source.height}</span><span>{formatDuration(source.duration)}</span></>}</div>
            {selectedJob && <div className="export-actions"><a href={`/api/jobs/${selectedJob.id}/bundle`} download title="Portable workflow, inputs, and render receipt"><FolderOpen size={14} />Project</a><a href={selectedJob.workflowUrl} download title="Exact graph submitted through the Comfy SDK"><GitBranch size={14} />SDK graph</a><a href={selectedJob.manifestUrl} download title="Render settings and provenance"><Code2 size={14} />Receipt</a>{currentOutput && <a className="download-output" href={currentOutput.url} download={currentOutput.name}><ArrowDownToLine size={14} />Video</a>}</div>}
          </div>

          {currentOutput && selectedManifest?.preprocessing && <p className="comparison-note">{selectedManifest.preprocessing.fit === 'contain' ? 'Comparison uses the matched performance window:' : 'Legacy recipe: source and output framing may differ. Prepared window:'} {selectedManifest.preprocessing.startSeconds ?? 0}s in · {selectedManifest.preprocessing.fps} fps · {selectedManifest.preprocessing.preparedSource.width} × {selectedManifest.preprocessing.preparedSource.height}.</p>}

          <div className="workflow-strip"><GitBranch size={15} /><div><strong>Every take comes with its workflow.</strong><span>Your inputs, seed, settings, and Comfy graph stay together.</span></div><button aria-label="View workflows" onClick={() => setView('workflows')}><ArrowUpRight size={18} /></button></div>

          <div className="how-it-works">
            <MiniStep number="01" title="Bring the performance" description="Start with one person in a short clip." done={Boolean(source)} />
            <MiniStep number="02" title="Choose your character" description="A clear reference sets the new appearance." done={characters.length > 0} />
            <MiniStep number="03" title="Make it your own" description="Render, compare, and keep the whole recipe." done={Boolean(currentOutput)} />
          </div>
          <p className="honest-note">Experimental motion transfer. Backgrounds may change. Identity and motion quality depend on the model, inputs, and settings.</p>
        </main>

        <aside className="inspector" aria-label="Render settings">
          <div className="inspector-title"><SlidersHorizontal size={16} /><h2>Your take</h2><span>{mode === 'batch' ? `${characters.length}/5 CAST` : 'SETUP'}</span></div>
          <div className="inspector-scroll">
            <div className="input-heading"><label>Source video</label><span>01</span></div>
            <AssetInput kind="video" asset={source} onUpload={file => upload(file, 'video')} onError={setError} onRemove={() => { setSource(undefined); setSelectedJobId(undefined); }} />
            <button className="browse-assets" onClick={() => void browseAssets('video')}><FolderOpen size={11} />Choose a saved clip</button>
            {source && <button className="browse-assets crop-action" onClick={() => setCropEditor({ kind: 'source', asset: source })}><ScanFace size={11} />{sourceCrop ? 'Edit performance crop' : 'Set performance crop'}</button>}
            {source && <div className="clip-window">
              <div className="input-heading"><label htmlFor="clip-start">Performance window</label><span>{requestedDuration.toFixed(2)}s</span></div>
              <div className="clip-start-row"><input id="clip-start" aria-label="Clip start in seconds" type="number" min={0} max={Math.min(29, Math.max(0, (source.duration || 0) - requestedDuration))} step={0.1} value={startSeconds} onChange={event => setStartSeconds(Number(event.target.value))} /><span>seconds in</span><button className="quiet-button" disabled={!!currentOutput} onClick={() => setStartSeconds(Math.round(Math.min(sourcePlayer.current?.currentTime || 0, Math.max(0, (source.duration || 0) - requestedDuration)) * 100) / 100)}>Use playhead</button></div>
              <p className={`field-hint ${!clipFits ? 'invalid-window' : ''}`}>{clipFits ? `${startSeconds.toFixed(2)}–${(startSeconds + requestedDuration).toFixed(2)}s · ${frames} frames at ${effectiveFps} fps. ${sourceCrop ? 'Your crop' : 'The full frame'} is fitted with padding.` : 'The selected window extends beyond this clip. Move its start earlier or reduce frames.'}</p>
              {selectedWorkflow?.bindings.width && selectedWorkflow?.bindings.height && <button className="browse-assets" onClick={() => { const canvas = sourceCanvas(source.width, source.height, 480, source.sampleAspectRatio); setWidth(canvas.width); setHeight(canvas.height); }}><Film size={11} />Match source framing</button>}
            </div>}
            <div className="input-heading"><label>{mode === 'batch' ? 'Character references' : 'Character reference'}</label><span>02</span></div>
            {characters.map((character, index) => <div key={character.id}><AssetInput kind="image" asset={character} onUpload={file => upload(file, 'image')} onError={setError} onRemove={() => { setCharacters(previous => previous.filter((_, i) => i !== index)); setSelectedJobId(undefined); }} /><button className="browse-assets crop-action" onClick={() => setCropEditor({ kind: 'reference', asset: character })}><ScanFace size={11} />{referenceCrops[character.id] ? 'Edit reference crop' : 'Set reference crop'}</button></div>)}
            {(!characters.length || mode === 'batch' && characters.length < 5) && <AssetInput kind="image" onUpload={file => upload(file, 'image')} onError={setError} />}
            <button className="browse-assets" onClick={() => void browseAssets('image')}><FolderOpen size={11} />Choose a saved reference</button>
            <p className="field-hint">{mode === 'batch' ? 'One reference per render. Each cast member gets a separate saved job.' : 'Clear face, visible outfit. Use a reference you have permission to use.'}</p>

            {selectedWorkflow?.bindings.prompt && <><div className="input-heading"><label htmlFor="direction">Direction</label><span>03</span></div>
            <textarea id="direction" value={prompt} onChange={event => setPrompt(event.target.value)} rows={5} maxLength={4000} disabled={!selectedWorkflow?.bindings.prompt} placeholder="Describe the character, scene, lighting, and camera…" />
            <p className="field-hint">{mode === 'reshoot' ? 'Rebuild the scene around the performance. Camera control is model dependent.' : 'The video guides motion. Your reference guides appearance.'}</p></>}

            <div className="input-heading"><label htmlFor="workflow">Workflow</label><button onClick={() => setView('workflows')}><GitBranch size={12} />Inspect</button></div>
            <div className="select-wrap"><select id="workflow" value={workflowId} onChange={event => { setWorkflowId(event.target.value); setRestoredJobId(undefined); setRestoredManifest(undefined); setSelectedJobId(undefined); }}>{!workflows.length && <option value="">No workflow installed</option>}{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select><ChevronDown size={14} /></div>
            {selectedWorkflow && <p className="field-hint workflow-description">{selectedWorkflow.description}</p>}{requiresCrops && <p className="field-hint">256px input crops · 512px generated portrait. Motion is scaled by the amount below.</p>}

            <button className={`advanced-toggle ${advanced ? 'expanded' : ''}`} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><span><Settings2 size={14} />Render settings</span><ChevronDown size={14} /></button>
            {advanced && <div className="advanced-fields">
              <label>Width<input type="number" value={width} disabled={!selectedWorkflow?.bindings.width} min={128} max={480} step={16} onChange={event => setWidth(Number(event.target.value))} /></label>
              <label>Height<input type="number" value={height} disabled={!selectedWorkflow?.bindings.height} min={128} max={480} step={16} onChange={event => setHeight(Number(event.target.value))} /></label>
              <label>Frames<input type="number" value={frames} disabled={!selectedWorkflow?.bindings.frames} min={5} max={49} step={4} onChange={event => setFrames(Number(event.target.value))} /></label>
              <label>FPS<input type="number" value={effectiveFps} disabled={!selectedWorkflow?.bindings.fps} min={8} max={30} step={1} onChange={event => setFps(Number(event.target.value))} /></label>
              {selectedWorkflow?.bindings.motionStrength && <label className="motion-field">Motion amount<input aria-label="Motion amount" type="number" min={0} max={1} step={.05} value={motionStrength} onChange={event => setMotionStrength(Number(event.target.value))} /><span className="field-hint">{Math.round(motionStrength * 100)}% of relative motion. Higher values can distort large turns.</span></label>}
              <label>Seed<input type="number" value={seed} disabled={!selectedWorkflow?.bindings.seed} min={0} max={2147483647} onChange={event => setSeed(Number(event.target.value))} /></label>
              <p className="field-hint">Up to 49 frames and 480 pixels per edge. Source and reference crops fit the same canvas. Originals stay intact. Frame count must be 4n + 1. FPS comes from the workflow; originals stay saved.</p>
            </div>}
            {requiresCrops && <p className={`field-hint ${!cropsReady ? 'invalid-window' : ''}`}>Portrait animation needs a square crop around each face, including forehead and chin. Set both crops before rendering. Small, near-frontal movements work best.</p>}
            <div className={`readiness ${backend?.ready ? 'ready' : ''}`}><span className="status-dot" /><div><strong>{backend?.ready ? 'Ready on your engine' : 'Engine setup needed'}</strong><span>{backend?.ready ? 'Local Comfy SDK · no provider charges' : !backend?.connected ? 'Start ComfyUI, then connect the local proxy.' : backend.missingModels.length ? `${backend.missingModels.length} model files missing` : backend.missingNodes.length ? `${backend.missingNodes.length} nodes missing` : !backend.proxyConnected ? 'Start comfy-api-proxy on port 8189.' : backend.blockedNodes.length ? 'Workflow contains unaudited or API nodes.' : 'Check the selected workflow and engine.'}</span></div><button aria-label="Open engine setup" onClick={() => { setSettingsDraft(settings); setSettingsOpen(true); }}><ArrowUpRight size={16} /></button></div>
          </div>
          <div className="render-panel"><button className="render-button" disabled={!canRender} onClick={() => void render()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}<span>{mode === 'batch' ? `Render ${characters.length || ''} cast${characters.length === 1 ? '' : 's'}` : 'Recast this take'}</span><ArrowUpRight size={17} /></button><span className="render-caption">Your engine. Your files. Your workflow.</span></div>
        </aside>
      </div>}

      {view === 'library' && <main className="full-page">
        <div className="page-heading"><div><div className="eyebrow">SAVED IN THIS WORKSPACE</div><h1>Your local takes</h1><p>Reopen a local job with its original inputs, settings, and output. <button className="inline-link" onClick={() => { setRenderEngine('cloud'); setView('studio'); }}>View cloud takes<ArrowUpRight size={12} /></button></p></div><button className="primary-small" onClick={() => { setRenderEngine('local'); setView('studio'); }}><Plus size={15} />New local take</button></div>
        {!jobs.length ? <EmptyState icon={<FolderOpen size={30} />} title="Your first take starts here." description="Rendered and failed jobs both keep their recipes, so you can learn from each attempt." action={<button className="quiet-button" onClick={() => setView('studio')}>Open studio<ArrowUpRight size={15} /></button>} /> : <div className="job-grid">{jobs.map(job => <button className="job-card" data-job-id={job.id} key={job.id} onClick={() => void reopen(job)}><div className="job-thumbnail">{job.outputs[0]?.thumbnailUrl ? <img src={job.outputs[0].thumbnailUrl} alt="" /> : <Film size={32} />}<span className={`job-status ${job.status}`}>{activeStatuses.has(job.status) && <LoaderCircle size={12} className="spin" />}{statusLabel(job.status)}</span></div><div className="job-card-info"><strong>{job.workflowName}</strong><ArrowUpRight size={16} /><span>{new Date(job.createdAt).toLocaleString()}</span><span>{job.parameters.width && job.parameters.height ? `${job.parameters.width} × ${job.parameters.height} · ` : 'Saved canvas · '}{job.parameters.frames ?? 'Workflow'} frames{job.parameters.motionStrength !== undefined ? ` · Motion ${Math.round(job.parameters.motionStrength * 100)}%` : job.parameters.seed !== undefined ? ` · Seed ${job.parameters.seed}` : ''}</span></div></button>)}</div>}
      </main>}

      {view === 'workflows' && <main className="full-page">
        <div className="page-heading"><div><div className="eyebrow">OPEN BY DESIGN</div><h1>Nothing behind the curtain.</h1><p>Inspect the graph that runs your render. Import your own workflow pack.</p></div><button className="primary-small" onClick={() => importInput.current?.click()}><Upload size={15} />Import pack</button></div>
        <input type="file" ref={importInput} hidden accept=".json,application/json" onChange={event => void importWorkflow(event)} />
        <div className="workflow-list">{workflows.map(pack => <article className="workflow-card" key={pack.id}><div className="workflow-card-icon"><GitBranch size={25} /></div><div><div className="workflow-card-title"><h2>{pack.name}</h2><span className="outline-tag">{pack.license ? 'License included' : 'Check license'}</span></div><p>{pack.description}</p><div className="workflow-card-meta"><span>{Object.keys(pack.graph).length} nodes</span><span>{pack.outputNodeIds.length} output{pack.outputNodeIds.length === 1 ? '' : 's'}</span><span>Comfy SDK</span></div></div><div className="workflow-card-actions"><button className="quiet-button" onClick={() => setWorkflowInspect(pack)}><Code2 size={14} />Inspect</button><button className="primary-small" onClick={() => { setWorkflowId(pack.id); setRestoredJobId(undefined); setRestoredManifest(undefined); setSelectedJobId(undefined); setRenderEngine('local'); setView('studio'); }}>Use workflow<ArrowUpRight size={14} /></button></div></article>)}</div>
        <div className="import-help"><CircleHelp size={18} /><div><strong>Bring your own Comfy workflow</strong><p>A workflow pack contains an API-format graph, input bindings, output node IDs, and provenance. Unreviewed custom nodes and paid API nodes are blocked in this early build.</p><a href="https://github.com/StoicEnso/open-genjutsu#workflow-packs" target="_blank" rel="noreferrer">View the pack format<ArrowUpRight size={13} /></a></div></div>
      </main>}

      <footer className="app-footer"><span><span className="status-dot" />{apiOnline ? 'LOCAL FILE STORAGE' : 'CONNECTION LOST'}</span><span>Built with ComfyUI<span className="footer-separator">/</span>Inspectable workflows. Reopenable takes.</span><a href="https://github.com/StoicEnso/open-genjutsu" target="_blank" rel="noreferrer">MIT LICENSE<ArrowUpRight size={11} /></a></footer>
    </div>

    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}

    {cropEditor && <Modal title={cropEditor.kind === 'source' ? 'Crop the performance' : 'Crop the reference'} onClose={() => setCropEditor(undefined)} wide>
      <CropEditor asset={cropEditor.asset} startSeconds={startSeconds} initial={cropEditor.kind === 'source' ? sourceCrop : referenceCrops[cropEditor.asset.id]} square={requiresCrops} onSave={(crop, displayAspect) => { setCropAspects(previous => ({ ...previous, [cropEditor.asset.id]: displayAspect })); if (cropEditor.kind === 'source') setSourceCrop(crop); else setReferenceCrops(previous => ({ ...previous, [cropEditor.asset.id]: crop })); setCropEditor(undefined); setSelectedJobId(undefined); }} />
    </Modal>}
    {settingsOpen && <Modal title="Connect your engine" onClose={() => setSettingsOpen(false)}>
      <p className="modal-intro">Open Genjutsu runs workflows on your own ComfyUI installation through the official Comfy SDK.</p>
      <label className="modal-field">ComfyUI address<input value={settingsDraft.comfyUrl} onChange={event => setSettingsDraft(previous => ({ ...previous, comfyUrl: event.target.value }))} type="url" spellCheck={false} /></label>
      <label className="modal-field">Comfy API proxy address<input value={settingsDraft.proxyUrl} onChange={event => setSettingsDraft(previous => ({ ...previous, proxyUrl: event.target.value }))} type="url" spellCheck={false} /></label>
      <div className="setup-steps"><div><span>1</span><div><strong>Start your local ComfyUI</strong><code>python main.py --listen 127.0.0.1</code></div></div><div><span>2</span><div><strong>Start the SDK adapter</strong><code>comfy-api-proxy run --comfyui http://127.0.0.1:8188</code></div></div><div><span>3</span><div><strong>Install the workflow’s models</strong><p>Read the pack’s requirements before downloading. No automatic paid cloud fallback.</p></div></div></div>
      <div className="connection-details"><div><span>ComfyUI</span><StatusChip ready={Boolean(backend?.connected)} /></div><div><span>SDK proxy</span><StatusChip ready={Boolean(backend?.proxyConnected)} /></div>{backend?.missingNodes.length ? <p>Missing nodes: {backend.missingNodes.join(', ')}</p> : null}{backend?.missingModels.length ? <p>Missing models: {backend.missingModels.join(', ')}</p> : null}{backend?.blockedNodes.length ? <p>Blocked nodes: {backend.blockedNodes.join(', ')}</p> : null}{backend?.error && <p>{backend.error}</p>}</div>
      <p className="field-hint">These addresses connect to your local engine only. To use your Comfy API key, choose Comfy Router in the studio. Cloud rendering always needs a separate price review.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="quiet-button" onClick={() => void refresh()}><RefreshCw size={14} />Check again</button><button className="primary-small" disabled={busy} onClick={() => void saveSettings()}>{busy && <LoaderCircle size={14} className="spin" />}Save engine</button></div>
    </Modal>}
    {workflowInspect && <Modal title={workflowInspect.name} onClose={() => setWorkflowInspect(undefined)} wide>
      <p className="modal-intro">The exact graph and input mappings. Model weights have their own licenses and hardware requirements.</p>
      <pre className="graph-code">{JSON.stringify(workflowInspect, null, 2)}</pre>
      <div className="modal-actions"><span className="field-hint">{Object.keys(workflowInspect.graph).length} nodes · {workflowInspect.license || 'No license declared'}</span><button className="primary-small" onClick={() => downloadJson(workflowInspect, `${workflowInspect.id}.json`)}><ArrowDownToLine size={14} />Download pack</button></div>
    </Modal>}
    {assetPicker && <Modal title={assetPicker === 'video' ? 'Choose a saved clip' : 'Choose a saved reference'} onClose={() => setAssetPicker(undefined)} wide>
      <p className="modal-intro">Uploads stay in this workspace, even when you start a new take.</p>
      {!savedAssets.length ? <p className="field-hint">No {assetPicker === 'video' ? 'clips' : 'images'} saved yet. Upload one in the studio to get started.</p> : <div className="asset-picker-grid">{savedAssets.map(asset => <button key={asset.id} className="saved-asset" onClick={() => useSavedAsset(asset)}><div>{asset.thumbnailUrl || asset.kind === 'image' ? <img src={asset.thumbnailUrl || asset.url} alt="" /> : <Film size={25} />}</div><strong>{asset.name}</strong><span>{asset.width} × {asset.height} · {asset.kind === 'video' ? formatDuration(asset.duration) : formatBytes(asset.bytes)}</span></button>)}</div>}
    </Modal>}
  </div>;
}

function NavButton({ active, onClick, icon, label, count }: { active?: boolean; onClick: () => void; icon: ReactNode; label: string; count?: number }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>{icon}<span>{label}</span>{count && <i>{count}</i>}</button>;
}

function MiniStep({ number, title, description, done }: { number: string; title: string; description: string; done: boolean }) {
  return <div className={`mini-step ${done ? 'done' : ''}`}><span>{done ? <Check size={13} /> : number}</span><div><strong>{title}</strong><p>{description}</p></div></div>;
}

function UploadStage({ onUpload, onError }: { onUpload: (file: File) => Promise<Asset>; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  async function accept(file?: File) {
    if (!file) return;
    setUploading(true);
    try { await onUpload(file); } catch (cause) { onError((cause as Error).message); } finally { setUploading(false); }
  }
  const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); void accept(event.dataTransfer.files[0]); };
  return <div className={`upload-stage ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <div className="stage-cross top-left" /><div className="stage-cross top-right" /><div className="stage-cross bottom-left" /><div className="stage-cross bottom-right" />
    <div className="slate"><Clapperboard size={34} strokeWidth={1.3} /></div>
    <h2>Start with a performance.</h2><p>Drop a clip here. Give it a new character.</p>
    <button className="upload-cta" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{uploading ? 'Preparing your clip…' : 'Choose a video'}</button>
    <input ref={input} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={event => { void accept(event.target.files?.[0]); event.target.value = ''; }} />
    <span className="upload-formats">MP4, MOV, WEBM<span>·</span>UP TO 200 MB</span>
    <div className="stage-bottom-label"><span>01 / SOURCE FOOTAGE</span><span>DROP TO BEGIN<ArrowDownToLine size={11} /></span></div>
  </div>;
}

function Comparison({ source, sourcePoster, output, outputPoster, initialDuration = 0, mode }: { source: string; sourcePoster?: string; output: string; outputPoster?: string; initialDuration?: number; mode: 'split' | 'wipe' }) {
  const original = useRef<HTMLVideoElement>(null);
  const result = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const [mediaError, setMediaError] = useState(false);
  const [position, setPosition] = useState(50);
  useEffect(() => { original.current?.pause(); result.current?.pause(); setPlaying(false); setTime(0); setDuration(initialDuration); setMediaError(false); }, [source, output, initialDuration]);
  function sync() {
    const a = original.current, b = result.current;
    if (!a || !b) return;
    setTime(b.currentTime);
    if (Math.abs(a.currentTime - b.currentTime) > 0.06) a.currentTime = b.currentTime;
  }
  async function toggle() {
    const a = original.current, b = result.current;
    if (!a || !b) return;
    if (playing) { a.pause(); b.pause(); setPlaying(false); }
    else { if (b.ended) { a.currentTime = 0; b.currentTime = 0; } try { await Promise.all([a.play(), b.play()]); setPlaying(true); } catch { a.pause(); b.pause(); setPlaying(false); } }
  }
  function seek(value: number) { if (original.current && result.current) { original.current.currentTime = value; result.current.currentTime = value; setTime(value); } }
  return <div className={`comparison ${mode}`}>
    <div className="comparison-videos">
      <div className="original-video"><video ref={original} src={source} poster={sourcePoster} muted playsInline preload="auto" onError={() => setMediaError(true)} /><span className="media-badge">ORIGINAL</span></div>
      <div className="result-video" style={mode === 'wipe' ? { clipPath: `inset(0 0 0 ${position}%)` } : undefined}><video ref={result} src={output} poster={outputPoster} muted playsInline preload="auto" onError={() => setMediaError(true)} onTimeUpdate={sync} onLoadedMetadata={event => setDuration(event.currentTarget.duration)} onEnded={() => { original.current?.pause(); setPlaying(false); }} /><span className="media-badge">RECAST</span></div>
      {mode === 'wipe' && <><div className="wipe-line" style={{ left: `${position}%` }}><span>↔</span></div><input className="wipe-input" aria-label="Original and recast comparison divider" type="range" min={0} max={100} value={position} onChange={event => setPosition(Number(event.target.value))} /></>}
    </div>
    {mediaError && <div className="media-error" role="alert">A preview could not load. Reopen this take or use the video download.</div>}
    <div className="player-controls"><button onClick={() => void toggle()} aria-label={playing ? 'Pause comparison' : 'Play synchronized comparison'}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><span>{formatDuration(time)}</span><input type="range" aria-label="Comparison playback position" min={0} max={Number.isFinite(duration) ? duration : 0} step={0.01} value={time} onChange={event => seek(Number(event.target.value))} /><span>{formatDuration(duration)}</span><span className="sync-label">SYNCED</span></div>
  </div>;
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><h2>{title}</h2><p>{description}</p>{action}</div>;
}

function StatusChip({ ready }: { ready: boolean }) { return <span className={`status-chip ${ready ? 'ready' : ''}`}><span className="status-dot" />{ready ? 'Connected' : 'Offline'}</span>; }

function statusLabel(status: Job['status']) {
  return ({ queued: 'Queued', uploading: 'Preparing inputs', running: 'Rendering', succeeded: 'Complete', failed: 'Render failed', cancelled: 'Cancelled', interrupted: 'Interrupted' })[status];
}

function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
