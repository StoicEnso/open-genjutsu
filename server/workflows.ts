import { z } from 'zod';
import type { Asset, CropRegion, JobParameters, WorkflowGraph, WorkflowImport, WorkflowPack } from '../shared/types.js';
import { HttpError } from './errors.js';

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
const binding = z.object({ nodeId: idSchema, input: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/) }).strict();
const graphSchema = z.record(idSchema, z.object({ class_type: z.string().min(1).max(150), inputs: z.record(z.string(), z.unknown()), _meta: z.record(z.string(), z.unknown()).optional() }).strict());
export const importSchema = z.object({
  id: idSchema.optional(), name: z.string().trim().min(1).max(120), description: z.string().max(10000).default(''), graph: graphSchema,
  bindings: z.object({ sourceVideo: binding, referenceImage: binding, prompt: binding.optional(), seed: binding.optional(), width: binding.optional(), height: binding.optional(), frames: binding.optional(), fps: binding.optional(), motionStrength: binding.optional() }).strict(),
  outputNodeIds: z.array(idSchema).min(1).max(30), license: z.string().max(1000).optional(), provenance: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional(), requires: z.object({ nodes: z.array(z.string()).max(500).optional(), models: z.array(z.string()).max(500).optional() }).optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
}).strict();
export const cropSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.05).max(1), height: z.number().min(0.05).max(1) }).strict().refine(region => region.x + region.width <= 1 && region.y + region.height <= 1, 'The entire crop rectangle must be inside the original displayed frame.');
export const jobSchema = z.object({ workflowId: idSchema, sourceVideoId: idSchema, referenceImageId: idSchema, prompt: z.string().max(16000).optional(), seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), width: z.number().int().min(64).max(480).multipleOf(16).optional(), height: z.number().int().min(64).max(480).multipleOf(16).optional(), frames: z.number().int().min(1).max(49).refine(value => value % 4 === 1, 'Frame count must be 4n + 1 (for example 17, 33 or 49).').optional(), startSeconds: z.number().min(0).max(29).optional(), fps: z.number().int().min(8).max(30).optional(), motionStrength: z.number().min(0).max(1).optional(), sourceCrop: cropSchema.optional(), referenceCrop: cropSchema.optional() }).strict();
export const jobParametersSchema = jobSchema.omit({ workflowId: true, sourceVideoId: true, referenceImageId: true }).strict();
export const rerunSchema = jobParametersSchema.extend({ sourceVideoId: idSchema.optional(), referenceImageId: idSchema.optional() }).strict();
function jsonSafe(value: unknown, depth = 0): void {
  if (depth > 32) throw new HttpError(400, 'graph_too_deep', 'Workflow JSON is too deeply nested.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string' && value.length <= 64000) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const entry of value) jsonSafe(entry, depth + 1); return; }
  if (typeof value === 'object' && value) { for (const [key, entry] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new HttpError(400, 'unsafe_json_key', 'Reserved JSON keys are not supported.'); jsonSafe(entry, depth + 1); } return; }
  throw new HttpError(400, 'invalid_graph_value', 'Workflow values must be bounded JSON values.');
}
export function parseWorkflow(body: unknown): WorkflowImport {
  const data = importSchema.parse(body);
  jsonSafe(data);
  const ids = Object.keys(data.graph);
  if (!ids.length || ids.length > 500) throw new HttpError(400, 'invalid_graph_size', 'Import between 1 and 500 API-format nodes.');
  const used = new Set<string>();
  for (const [purpose, target] of Object.entries(data.bindings)) {
    if (!target) continue;
    const node = data.graph[target.nodeId];
    if (!node || !Object.hasOwn(node.inputs, target.input)) throw new HttpError(400, 'invalid_binding', `${purpose} must name an existing graph input.`, target);
    const current = node.inputs[target.input];
    if (!['string', 'number'].includes(typeof current)) throw new HttpError(400, 'invalid_binding_type', `${purpose} must bind a scalar widget, not a link or socket.`, target);
    if (['sourceVideo', 'referenceImage', 'prompt'].includes(purpose) && typeof current !== 'string') throw new HttpError(400, 'invalid_binding_type', `${purpose} must bind a filename/text widget.`);
    if (!['sourceVideo', 'referenceImage', 'prompt'].includes(purpose) && typeof current !== 'number') throw new HttpError(400, 'invalid_binding_type', `${purpose} must bind a numeric widget.`);
    const key = `${target.nodeId}:${target.input}`;
    if (used.has(key)) throw new HttpError(400, 'duplicate_binding', 'Two controls cannot overwrite the same input.');
    used.add(key);
  }
  for (const output of data.outputNodeIds) if (!data.graph[output]) throw new HttpError(400, 'missing_output_node', `Output node ${output} is missing.`);
  for (const node of Object.values(data.graph)) for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
      if (!data.graph[value[0]] || !Number.isInteger(value[1]) || value[1] < 0) throw new HttpError(400, 'invalid_graph_link', 'A workflow link references a missing node or invalid output slot.');
    }
  }
  for (const node of Object.values(data.graph)) for (const [input, value] of Object.entries(node.inputs)) {
    if (typeof value === 'string' && /^(?:file|image|filename|filename_prefix)$|(?:_name\d*|_path|_file)$/.test(input)) {
      if (/^[\\/]|^[A-Za-z]:|:\/\//.test(value) || value.split(/[\\/]/).includes('..')) throw new HttpError(400, 'unsafe_graph_path', 'File widgets and output prefixes must use relative Comfy filenames, without parent traversal or remote URLs.');
    }
  }
  return data as WorkflowImport;
}
export function bindParameters(pack: WorkflowPack, parameters: JobParameters): WorkflowGraph {
  const graph = structuredClone(pack.graph);
  for (const [purpose, value] of Object.entries(parameters)) {
    if (value === undefined || ['startSeconds','sourceCrop','referenceCrop'].includes(purpose)) continue;
    const target = pack.bindings[purpose as keyof WorkflowPack['bindings']];
    if (!target) throw new HttpError(400, 'unsupported_control', `This workflow does not expose ${purpose}.`);
    graph[target.nodeId]!.inputs[target.input] = value;
  }
  return graph;
}

export interface VideoPreparation { width: number; height: number; frames: number; fps: number; startSeconds: number; fit: 'contain'; upscaling: false; sourceCrop?: CropRegion; referenceCrop?: CropRegion }
/** Resolve the real bound recipe once. Legacy graphs retain their actual output FPS. */
export function videoPreparation(pack: WorkflowPack, graph: WorkflowGraph, source: Asset, parameters: JobParameters): VideoPreparation {
  const metadata = pack.metadata?.video;
  const video = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const bound = (purpose: 'width' | 'height' | 'frames' | 'fps'): unknown => { const binding = pack.bindings[purpose]; return binding ? graph[binding.nodeId]?.inputs[binding.input] : undefined; };
  const conditioning = Object.values(graph).find(node => /^Wan(?:Vace|Animate2?|Image|Video).*ToVideo$/.test(node.class_type));
  const rates = [...new Set(Object.values(graph).filter(node => node.class_type === 'CreateVideo').map(node => node.inputs.fps))];
  if (rates.length > 1 || rates.some(rate => typeof rate !== 'number')) throw new HttpError(400, 'ambiguous_fps', 'The workflow must declare one numeric output frame rate.');
  const fps = Number(bound('fps') ?? rates[0] ?? video.fps ?? 24);
  if (!Number.isInteger(fps) || fps < 8 || fps > 30 || rates.length && rates[0] !== fps) throw new HttpError(400, 'fps_mismatch', 'The source and output frame rate must match and be between 8 and 30 fps.');
  if (!pack.bindings.fps && typeof video.fps === 'number' && video.fps !== fps) throw new HttpError(400, 'fps_mismatch', 'Workflow metadata FPS disagrees with its fixed CreateVideo frame rate. Update the pack before rendering.');
  const startSeconds = parameters.startSeconds ?? 0;
  const available = Math.max(0, (source.duration ?? 0) - startSeconds);
  const fallbackFrames = Math.max(1, Math.floor((Math.min(49, Math.floor(available * fps + 0.0001)) - 1) / 4) * 4 + 1);
  const frames = Number(bound('frames') ?? conditioning?.inputs.length ?? fallbackFrames);
  const width = Number(bound('width') ?? conditioning?.inputs.width ?? video.width ?? Math.max(64, Math.floor(Math.min(480, source.width) / 16) * 16));
  const height = Number(bound('height') ?? conditioning?.inputs.height ?? video.height ?? Math.max(64, Math.floor(Math.min(480, source.height) / 16) * 16));
  if (![width,height].every(value => Number.isInteger(value) && value >= 64 && value <= 480 && value % 16 === 0)) throw new HttpError(400, 'preview_dimensions', 'Render dimensions must be multiples of 16 between 64 and 480 pixels.');
  if (!Number.isInteger(frames) || frames < 1 || frames > 49 || frames % 4 !== 1) throw new HttpError(400, 'preview_frames', 'Workflow frame count must be 4n + 1, from 1 to 49.');
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 29) throw new HttpError(400, 'source_start', 'Choose a source start between 0 and 29 seconds.');
  if (available + 0.001 < frames / fps) throw new HttpError(400, 'source_too_short', `This selection needs ${(frames / fps).toFixed(3)} seconds after ${startSeconds.toFixed(3)}s; only ${available.toFixed(3)} seconds remain. Move the start earlier or reduce the frame count. No frames will be padded or invented.`);
  return { width, height, frames, fps, startSeconds, fit: 'contain', upscaling: false, ...(parameters.sourceCrop ? { sourceCrop: cropSchema.parse(parameters.sourceCrop) } : {}), ...(parameters.referenceCrop ? { referenceCrop: cropSchema.parse(parameters.referenceCrop) } : {}) };
}

export interface NodeInfo { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; python_module?: string; api_node?: boolean; is_api_node?: boolean; output_node?: boolean; [key: string]: unknown }
export type ObjectInfo = Record<string, NodeInfo>;
const AUDITED_CORE = new Set(['LoadImage','LoadVideo','SaveImage','SaveVideo','CreateVideo','GetVideoComponents','PreviewImage','CLIPLoader','DualCLIPLoader','TripleCLIPLoader','CLIPVisionLoader','CLIPVisionEncode','CLIPTextEncode','UNETLoader','VAELoader','VAEDecode','VAEEncode','VAEEncodeForInpaint','CheckpointLoaderSimple','LoraLoader','LoraLoaderModelOnly','KSampler','KSamplerAdvanced','KSamplerSelect','BasicScheduler','SamplerCustom','TrimVideoLatent','ModelSamplingSD3','ModelSamplingFlux','ModelSamplingAuraFlow','ModelSamplingDiscrete','ModelSamplingContinuousEDM','EmptyLatentImage','EmptyHunyuanLatentVideo','WanAnimateToVideo','WanAnimate2ToVideo','WanVaceToVideo','Canny','WanImageToVideo','WanFirstLastFrameToVideo','WanVideoToVideo','WanFunControlToVideo','ImageScale','ImageScaleBy','ImageBatch','ImageFromBatch','ImageCrop','ImagePadForOutpaint','ImageCompositeMasked','ImageToMask','MaskToImage','InvertMask','GrowMask','FeatherMask','SolidMask','LoadImageMask','SetLatentNoiseMask','ConditioningCombine','ConditioningConcat','ConditioningSetArea','ConditioningSetMask','ConditioningZeroOut']);
const REMOTE = /(?:api|higgsfield|openai|gemini|runway|replicate|router|cloud|download|http|load.*url)/i;
function combo(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (Array.isArray(value[0]) && value[0].every(v => typeof v === 'string')) return value[0] as string[];
  if (value[0] === 'COMBO' && typeof value[1] === 'object' && value[1] && Array.isArray((value[1] as { options?: unknown }).options)) return (value[1] as { options: string[] }).options;
  return undefined;
}
export function auditWorkflow(pack: WorkflowPack | undefined, info: ObjectInfo): { missingNodes: string[]; missingModels: string[]; blockedNodes: string[]; models: Record<string, string[]> } {
  const models: Record<string, string[]> = {};
  for (const [type, definition] of Object.entries(info)) {
    for (const [input, schema] of Object.entries({ ...definition.input?.required, ...definition.input?.optional })) {
      const options = combo(schema);
      if (options && /(?:ckpt|vae|clip|lora|unet|model|control_net|diffusion|text_encoder|gguf)/i.test(input) && !/(?:^|_)(?:type|dtype)$/.test(input)) models[`${type}.${input}`] = options;
    }
  }
  if (!pack) return { missingNodes: [], missingModels: [], blockedNodes: [], models };
  const missingNodes = new Set<string>(); const missingModels = new Set<string>(); const blockedNodes = new Set<string>();
  for (const required of pack.requires?.nodes || []) if (!info[required]) missingNodes.add(required);
  for (const node of Object.values(pack.graph)) {
    const definition = info[node.class_type];
    if (!definition) { missingNodes.add(node.class_type); continue; }
    const module = definition.python_module || '';
    const paid = definition.api_node === true || definition.is_api_node === true || module.startsWith('comfy_api_nodes') || REMOTE.test(node.class_type);
    // Audited source: city96/ComfyUI-GGUF 6ea2651e7df66d7585f6ffee804b20e92fb38b8a,
    // nodes.py CLIPLoaderGGUF only: local folder_paths + GGUF reader, Apache-2.0.
    // Our source-controlled adapter verifies the five pinned MIT core weights,
    // takes only in-memory crops and never loads detection models or remote APIs.
    const portrait = node.class_type === 'OpenGenjutsuPortrait' && module === 'custom_nodes.open_genjutsu_portrait';
    const audited = AUDITED_CORE.has(node.class_type) && (!module || module === 'nodes' || module.startsWith('comfy_extras.')) || node.class_type === 'CLIPLoaderGGUF' && module === 'custom_nodes.ComfyUI-GGUF' || portrait;
    if (paid || !audited) blockedNodes.add(`${node.class_type}: ${paid ? 'provider/network node blocked' : 'not in the audited local node set'}`);
    for (const [input, value] of Object.entries(node.inputs)) {
      const choices = models[`${node.class_type}.${input}`];
      if (choices && typeof value === 'string' && !choices.includes(value)) missingModels.add(`${node.class_type}.${input}: ${value}`);
    }
  }
  for (const model of pack.requires?.models || []) if (!Object.values(models).some(values => values.includes(model)) && ![...missingModels].some(detail => detail.endsWith(`: ${model}`))) missingModels.add(model);
  return { missingNodes: [...missingNodes], missingModels: [...missingModels], blockedNodes: [...blockedNodes], models };
}
