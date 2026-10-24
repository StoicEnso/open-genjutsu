/** The browser, desktop shell and local API share this contract. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface WorkflowNode { class_type: string; inputs: Record<string, JsonValue>; _meta?: Record<string, JsonValue> }
export type WorkflowGraph = Record<string, WorkflowNode>;
export interface WorkflowBinding { nodeId: string; input: string }
export interface WorkflowBindings {
  sourceVideo: WorkflowBinding;
  referenceImage: WorkflowBinding;
  prompt?: WorkflowBinding;
  seed?: WorkflowBinding;
  width?: WorkflowBinding;
  height?: WorkflowBinding;
  frames?: WorkflowBinding;
  fps?: WorkflowBinding;
  motionStrength?: WorkflowBinding;
}
export interface WorkflowPack {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  bindings: WorkflowBindings;
  outputNodeIds: string[];
  license?: string;
  provenance?: JsonValue;
  metadata?: Record<string, JsonValue>;
  requires?: { nodes?: string[]; models?: string[] };
  createdAt: string;
  updatedAt: string;
}
export type WorkflowImport = Omit<WorkflowPack, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export interface Settings { comfyUrl: string; proxyUrl: string }
/** Fractions of the original displayed/autorotated frame, not the padded canvas. */
export interface CropRegion { x: number; y: number; width: number; height: number }
export interface Asset {
  id: string;
  name: string;
  kind: 'video' | 'image';
  url: string;
  thumbnailUrl?: string;
  width: number;
  height: number;
  duration?: number;
  fps?: number;
  frameCount?: number;
  sampleAspectRatio?: string;
  codedWidth?: number;
  codedHeight?: number;
  rotationDegrees?: number;
  bytes: number;
  mimeType: string;
  createdAt: string;
}
export interface BackendStatus {
  connected: boolean;
  proxyConnected: boolean;
  nodes: string[];
  models: Record<string, string[]>;
  missingNodes: string[];
  missingModels: string[];
  blockedNodes: string[];
  ready: boolean;
  warnings?: string[];
  media?: { available: boolean; ffmpeg: { available: boolean; path?: string; version?: string; error?: string }; ffprobe: { available: boolean; path?: string; version?: string; error?: string } };
  error?: string;
}
export interface JobParameters { prompt?: string; seed?: number; width?: number; height?: number; frames?: number; startSeconds?: number; fps?: number; motionStrength?: number; sourceCrop?: CropRegion; referenceCrop?: CropRegion }
export interface JobRequest extends JobParameters { workflowId: string; sourceVideoId: string; referenceImageId: string }
export interface JobRerunRequest extends JobParameters { sourceVideoId?: string; referenceImageId?: string }
export type JobStatus = 'queued' | 'uploading' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface Job {
  id: string;
  workflowId: string;
  workflowName: string;
  sourceVideoId: string;
  referenceImageId: string;
  parameters: JobParameters;
  status: JobStatus;
  /** Fraction in [0,1]. Zero can also mean the backend has no progress snapshot. */
  progress: number;
  message: string;
  error?: string;
  promptId?: string;
  outputs: Asset[];
  createdAt: string;
  updatedAt: string;
  manifestUrl: string;
  workflowUrl: string;
}
export interface JobManifest {
  version: 1;
  app: 'Open Genjutsu';
  job: Job;
  workflow: WorkflowPack;
  settings: Settings;
  source: Asset;
  reference: Asset;
  sourceSha256: string;
  referenceSha256: string;
  workflowSha256: string;
  integration: '@comfyorg/sdk@0.5.0 / self-hosted comfy-api-proxy';
  preprocessing?: {
    preparedSource: Asset;
    sha256: string;
    fps: number;
    maxFrames: number;
    maxDimension: 480;
    aspect: 'preserved';
    audio: 'removed from conditioning preview';
    /** Added 2026-10-23; absent on legacy receipts. */
    startSeconds?: number;
    width?: number;
    height?: number;
    frames?: number;
    fit?: 'contain';
    upscaling?: false;
    preparedReference?: Asset;
    preparedReferenceSha256?: string;
    sourceCrop?: CropRegion;
    referenceCrop?: CropRegion;
  };
  assetBindings?: {
    sourceVideo: { proxyAssetId: string; localAssetId: string; sha256: string; filePath?: string };
    referenceImage: { proxyAssetId: string; localAssetId: string; sha256: string; filePath?: string };
  };
  notice: string;
}
export interface ApiError { error: { code: string; message: string; details?: unknown } }

/** Optional hosted mode; credentials and signed media URLs never enter this contract. */
export interface CloudInput {
  sourceVideoId: string;
  referenceImageId: string;
  prompt: string;
  duration: number;
  resolution: '480p' | '720p';
  ratio: '1:1' | '16:9' | '9:16';
}
export interface CloudStatus {
  provider: 'comfy-router';
  keyConfigured: boolean;
  storage: 'session' | 'encrypted';
  canRemember: boolean;
  modelId: string;
  modelName: string;
  warnings: string[];
}
export interface CloudQuote {
  id: string;
  provider: 'comfy-router';
  modelId: string;
  modelName: string;
  input: CloudInput;
  source: Asset;
  reference: Asset;
  amount: string;
  currency: 'USD';
  expiresAt: string;
  requestHash: string;
  warnings: string[];
}
export interface CloudJob {
  id: string;
  modelId: string;
  input: CloudInput;
  quotedAmount: string;
  currency: 'USD';
  status: JobStatus;
  message: string;
  requestId?: string;
  outputs: Asset[];
  createdAt: string;
  updatedAt: string;
  manifestUrl: string;
  error?: string;
}
export interface CloudManifest {
  version: 1;
  app: 'Open Genjutsu';
  provider: 'comfy-router';
  modelId: string;
  job: CloudJob;
  source: Asset;
  reference: Asset;
  sourceSha256: string;
  referenceSha256: string;
  requestHash: string;
  quote: { amount: string; currency: 'USD'; approvedAt: string };
  notice: string;
}
