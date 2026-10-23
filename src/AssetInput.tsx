import { useRef, useState } from 'react';
import { Film, ImagePlus, LoaderCircle, Plus, X } from 'lucide-react';
import type { Asset } from '../shared/types';
import { formatBytes, formatDuration } from './api';

export function AssetInput({ kind, asset, onUpload, onRemove, onError, accept: acceptTypes }: { kind: 'video' | 'image'; asset?: Asset; onUpload: (file: File) => Promise<Asset>; onRemove?: () => void; onError: (message: string) => void; accept?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function accept(file?: File) {
    if (!file) return;
    setBusy(true);
    try { await onUpload(file); } catch (cause) { onError((cause as Error).message); } finally { setBusy(false); }
  }
  return <div className={`asset-input ${asset ? 'filled' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void accept(event.dataTransfer.files[0]); }}>
    <button type="button" className="asset-upload" disabled={busy} onClick={() => input.current?.click()}>
      {asset ? <><div className="asset-thumb">{(asset.thumbnailUrl || kind === 'image') ? <img src={asset.thumbnailUrl || asset.url} alt="" /> : <Film size={20} />}</div><span><strong>{asset.name}</strong><small>{asset.width} × {asset.height} · {kind === 'video' ? formatDuration(asset.duration) : formatBytes(asset.bytes)}</small></span></> : <><span className="asset-empty-icon">{busy ? <LoaderCircle className="spin" size={19} /> : kind === 'video' ? <Film size={19} /> : <ImagePlus size={19} />}</span><span><strong>{busy ? 'Preparing file…' : kind === 'video' ? 'Add driving video' : 'Add character image'}</strong><small>{kind === 'video' ? 'Drop a clip or browse' : 'PNG, JPG, WEBP'}</small></span><Plus size={16} /></>}
    </button>
    {asset && <button type="button" className="remove-asset" aria-label={`Remove ${asset.name}`} onClick={onRemove}><X size={13} /></button>}
    <input ref={input} hidden type="file" accept={acceptTypes || (kind === 'video' ? 'video/mp4,video/quicktime,video/webm' : 'image/png,image/jpeg,image/webp')} onChange={event => { void accept(event.target.files?.[0]); event.target.value = ''; }} />
  </div>;
}
