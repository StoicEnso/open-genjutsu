import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Asset, CropRegion } from '../shared/types';

const fullFrame: CropRegion = { x: 0, y: 0, width: 1, height: 1 };
const round = (value: number) => Math.round(value * 1000000) / 1000000;
function boundedRectangle(x: number, y: number, width: number, height: number): CropRegion {
  x = round(x); y = round(y);
  return { x, y, width: Math.min(round(width), 1 - x), height: Math.min(round(height), 1 - y) };
}

/** Coordinates always refer to the original displayed frame, before padding. */
export function CropEditor({ asset, initial, startSeconds, square, onSave }: { asset: Asset; initial?: CropRegion; startSeconds: number; square?: boolean; onSave: (crop: CropRegion, displayAspect: number) => void }) {
  const [crop, setCrop] = useState<CropRegion>(initial || fullFrame);
  const [ratio, setRatio] = useState(asset.width / asset.height * sar(asset.sampleAspectRatio));
  const area = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; y: number } | undefined>(undefined);
  const valid = Object.values(crop).every(Number.isFinite) && crop.x >= 0 && crop.y >= 0 && crop.width >= .05 && crop.height >= .05 && crop.width <= 1 && crop.height <= 1 && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
  const squareEnough = Math.abs(crop.width * ratio / crop.height - 1) < .025;
  const point = (event: PointerEvent) => {
    const bounds = area.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  function move(event: PointerEvent) {
    if (!anchor.current) return;
    const next = point(event), first = anchor.current;
    let width = Math.abs(next.x - first.x), height = Math.abs(next.y - first.y);
    if (square) { width = Math.min(width, height / ratio); height = width * ratio; }
    setCrop(boundedRectangle(next.x < first.x ? first.x - width : first.x, next.y < first.y ? first.y - height : first.y, width, height));
  }
  function centeredSquare() {
    const width = Math.min(1, 1 / ratio), height = Math.min(1, ratio);
    setCrop(boundedRectangle((1 - width) / 2, (1 - height) / 2, width, height));
  }
  return <div className="crop-editor">
    <p className="modal-intro">Drag a rectangle or enter percentages. {asset.kind === 'video' ? 'This fixed crop applies to every frame in your selected window.' : 'Include the full face, forehead and chin.'} Originals stay saved.</p>
    <div className="crop-preview-wrap"><div ref={area} className="crop-preview" style={{ aspectRatio: ratio, width: `min(100%, 440px, ${42 * ratio}dvh)` }} onPointerDown={event => { if (event.button !== 0) return; anchor.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={move} onPointerUp={event => { move(event); anchor.current = undefined; }} onPointerCancel={() => { anchor.current = undefined; }}>
      {asset.kind === 'video' ? <video src={asset.url} poster={asset.thumbnailUrl} muted playsInline preload="auto" onLoadedMetadata={event => { const video = event.currentTarget; if (video.videoHeight) setRatio(video.videoWidth / video.videoHeight); video.currentTime = startSeconds; }} /> : <img src={asset.url} alt="Reference to crop" onLoad={event => { const image = event.currentTarget; if (image.naturalHeight) setRatio(image.naturalWidth / image.naturalHeight); }} />}
      {valid && <div className="crop-region" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}><span>CROP</span></div>}
    </div></div>
    <div className="crop-fields">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['Left %', 'Top %', 'Width %', 'Height %'][index]}<input aria-label={`Crop ${['left', 'top', 'width', 'height'][index]} percent`} type="number" step={.1} min={key === 'width' || key === 'height' ? 5 : 0} max={100} value={Math.round(crop[key] * 100000) / 1000} onChange={event => setCrop(previous => ({ ...previous, [key]: round(Number(event.target.value) / 100) }))} /></label>)}</div>
    <p className={`field-hint ${!valid || square && !squareEnough ? 'invalid-window' : ''}`}>{!valid ? 'Keep the rectangle inside the frame, at least 5% on each edge.' : square && !squareEnough ? 'Use a square face crop for this portrait workflow.' : 'The crop is fitted to the render canvas without stretching or enlarging source pixels.'}</p>
    <div className="modal-actions"><div className="crop-presets"><button className="quiet-button" onClick={() => setCrop(fullFrame)}>Full frame</button><button className="quiet-button" onClick={centeredSquare}>Centered square</button></div><button className="primary-small" disabled={!valid || Boolean(square && !squareEnough)} onClick={() => onSave(crop, ratio)}>Use crop</button></div>
  </div>;
}

function sar(value?: string) { const [n, d] = (value || '1:1').split(':').map(Number); return Number.isFinite(n! / d!) && n! > 0 && d! > 0 ? n! / d! : 1; }
