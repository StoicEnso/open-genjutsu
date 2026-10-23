import type { Response } from 'express';
import { ZipFile } from 'yazl';
import type { Readable } from 'node:stream';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Store, StoredAsset, StoredJob } from './storage.js';
import { sha256, MAX_FILE_BYTES } from './media.js';
import { HttpError } from './errors.js';

const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' };
const archiveJson = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
/** SDK graph is a receipt; portable graph binds ordinary filenames, not expiring proxy asset IDs. */
export async function streamBundle(store: Store, record: StoredJob, res: Response): Promise<void> {
  const snapshot = store.snapshot();
  const source = snapshot.assets[record.job.sourceVideoId]; const reference = snapshot.assets[record.job.referenceImageId];
  const prepared = record.manifest.preprocessing ? snapshot.assets[record.manifest.preprocessing.preparedSource.id] : undefined;
  const preparedReferenceId = record.manifest.preprocessing?.preparedReference?.id;
  const boundReference = preparedReferenceId ? snapshot.assets[preparedReferenceId] : reference;
  if (!source || !reference || !prepared || !boundReference) throw new HttpError(409, 'bundle_not_ready', 'The source and reference previews must be present before this project can be exported.');
  const folder = `open-genjutsu-${record.job.id}`;
  const sourceName = `${folder}/source-preview.mp4`;
  const referenceName = `${folder}/reference${extensions[boundReference.asset.mimeType] || '.png'}`;
  const files: { name: string; asset: StoredAsset }[] = [
    { name: `inputs/${sourceName}`, asset: prepared },
    { name: `inputs/${referenceName}`, asset: boundReference },
    { name: `originals/source${extensions[source.asset.mimeType] || '.mp4'}`, asset: source },
    { name: `originals/reference${extensions[reference.asset.mimeType] || '.png'}`, asset: reference },
  ];
  for (const [index, output] of record.job.outputs.entries()) {
    const stored = snapshot.assets[output.id];
    if (!stored) throw new HttpError(409, 'bundle_asset_missing', 'A job output is no longer present locally.');
    files.push({ name: `outputs/output-${index+1}${extensions[output.mimeType] || '.bin'}`, asset: stored });
  }
  const root = await realpath(store.assetDir);
  let total = 0;
  for (const item of files) {
    const resolved = await realpath(item.asset.filename);
    if (!resolved.startsWith(root + path.sep)) throw new HttpError(500, 'invalid_asset_record', 'An asset points outside the local media directory.');
    const info = await stat(resolved);
    if (!info.isFile() || info.size > MAX_FILE_BYTES || (total += info.size) > MAX_FILE_BYTES * 4) throw new HttpError(413, 'bundle_size', 'The project bundle exceeds the bounded media size.');
    if (info.size !== item.asset.asset.bytes || await sha256(resolved) !== item.asset.sha256) throw new HttpError(409, 'bundle_asset_changed', 'A local media file changed after import. Restore it before exporting.');
  }
  const portable = structuredClone(record.graph);
  const sourceBinding = record.workflow.bindings.sourceVideo; const referenceBinding = record.workflow.bindings.referenceImage;
  portable[sourceBinding.nodeId]!.inputs[sourceBinding.input] = sourceName;
  portable[referenceBinding.nodeId]!.inputs[referenceBinding.input] = referenceName;
  const portablePack = { ...record.workflow, graph: portable };
  const readme = `Open Genjutsu project bundle\n\nThis is an execution project, not a model-quality certificate.\n\n1. Install ComfyUI, the workflow's local models and audited custom nodes. See workflow-pack.json provenance and requires. No model weights are redistributed here.\n2. Copy the CONTENTS of inputs/ into your ComfyUI input/ directory, preserving its ${folder}/ subdirectory.\n3. portable-workflow-api.json is an API-format graph with ordinary relative input filenames and the original bound parameters. Run it through ComfyUI's prompt API or import workflow-pack.json into Open Genjutsu. API-format JSON is not the frontend canvas/save format.\n4. sdk-workflow-receipt.json preserves the actual submitted SDK graph with core/ASSET IDs. Those IDs belong to the original proxy registry; use the portable graph on another machine.\n5. manifest.json preserves the original job recipe, engine addresses, input hashes and exact preview normalization. Original source and reference bytes are under originals/. The exact prepared short source and prepared reference used by this execution are under inputs/; legacy receipts may have used the original reference directly. Outputs, if complete, are under outputs/.\n6. New preparation receipts record startSeconds, width, height, frames, fps, contain fit and prepared-reference hash. The prepared source starts at timeline zero and already contains the selected source window: do not trim it again when replaying the portable graph.\n7. Model-file integrity, runtime and output quality must be checked on the destination machine. Audio was removed from the conditioning preview; it was not promised in the output.\n\nMedia and workflow licenses remain those recorded by their owners in the manifest and pack. Open Genjutsu code is MIT.\n`;
  const buffers = [
    ['manifest.json', archiveJson(record.manifest)],
    ['sdk-workflow-receipt.json', archiveJson(record.graph)],
    ['portable-workflow-api.json', archiveJson(portable)],
    ['workflow-pack.json', archiveJson(portablePack)],
    ['README.txt', Buffer.from(readme)],
  ] as const;
  if (buffers.reduce((sum, [, value]) => sum + value.length, 0) > 8 * 1024 * 1024) throw new HttpError(413, 'bundle_metadata_size', 'The project metadata is too large.');
  res.type('application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="open-genjutsu-${record.job.id}.zip"`);
  const zip = new ZipFile();
  zip.on('error', error => res.destroy(error instanceof Error ? error : new Error(String(error))));
  zip.outputStream.on('error', error => res.destroy(error));
  res.on('close', () => (zip.outputStream as Readable).destroy());
  zip.outputStream.pipe(res);
  for (const [name, buffer] of buffers) zip.addBuffer(buffer, name);
  for (const file of files) zip.addFile(file.asset.filename, file.name);
  zip.end();
}
