import type { Asset, CropRegion, WorkflowPack } from '../shared/types';

export function squareCrop(crop: CropRegion | undefined, asset: Asset | undefined, displayAspect?: number) {
  if (!crop || !asset || !Object.values(crop).every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width < .05 || crop.height < .05 || crop.x + crop.width > 1 || crop.y + crop.height > 1) return false;
  const [n, d] = (asset.sampleAspectRatio || '1:1').split(':').map(Number);
  const sar = Number.isFinite(n! / d!) && n! / d! > 0 ? n! / d! : 1;
  const aspect = displayAspect && Number.isFinite(displayAspect) ? displayAspect : asset.width * sar / asset.height;
  return Math.abs(crop.width * aspect / crop.height - 1) < .025;
}

/** Read the actual graph: switching packs must not overwrite their tuned defaults. */
export function workflowDefaults(pack?: WorkflowPack) {
  const scalar = (key: 'prompt' | 'seed' | 'width' | 'height' | 'frames' | 'fps' | 'motionStrength') => {
    const binding = pack?.bindings[key];
    return binding ? pack?.graph[binding.nodeId]?.inputs[binding.input] : undefined;
  };
  const number = (key: 'seed' | 'width' | 'height' | 'frames', fallback: number) => {
    const value = scalar(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const video = Object.values(pack?.graph || {}).find(node => node.class_type === 'CreateVideo');
  const fpsValue = scalar('fps') ?? video?.inputs.fps;
  return {
    prompt: typeof scalar('prompt') === 'string' ? String(scalar('prompt')) : undefined,
    seed: number('seed', 42), width: number('width', 256), height: number('height', 256), frames: number('frames', 17),
    motionStrength: typeof scalar('motionStrength') === 'number' ? Number(scalar('motionStrength')) : .35,
    fps: typeof fpsValue === 'number' && Number.isFinite(fpsValue) ? fpsValue : 24,
  };
}

/** Fit the source's full field of view to a multiple-of-16 preview canvas. */
export function sourceCanvas(width: number, height: number, edge = 480, sampleAspectRatio = '1:1') {
  const [numerator, denominator] = sampleAspectRatio.split(':').map(Number);
  const ratio = numerator! / denominator!;
  if (Number.isFinite(ratio) && ratio > 0) width *= ratio;
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(128, Math.min(480, Math.round(width * scale / 16) * 16)), height: Math.max(128, Math.min(480, Math.round(height * scale / 16) * 16)) };
}
