import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, constants } from 'node:fs';
import { stat, rename, unlink, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Asset } from '../shared/types.js';
import { Store, type StoredAsset } from './storage.js';
import { HttpError } from './errors.js';

const exec = promisify(execFile);
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_PREVIEW_FRAMES = 49;
export interface MediaTool { available: boolean; path?: string; version?: string; error?: string }
export interface MediaTools { available: boolean; ffmpeg: MediaTool; ffprobe: MediaTool }
/** Resolve executable files only; never invoke a shell or search the working directory. */
export async function discoverMediaBinaries(explicit: { ffmpeg?: string; ffprobe?: string } = {}): Promise<MediaTools> {
  const find = async (name: 'ffmpeg' | 'ffprobe'): Promise<MediaTool> => {
    const override = explicit[name] || process.env[name === 'ffmpeg' ? 'OPEN_GENJUTSU_FFMPEG' : 'OPEN_GENJUTSU_FFPROBE'];
    const directories = [...new Set((process.env.PATH || '').split(path.delimiter).filter(entry => path.isAbsolute(entry) && entry !== path.parse(entry).root).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']))];
    const candidates = override ? [override] : directories.map(directory => path.join(directory, process.platform === 'win32' ? `${name}.exe` : name));
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue;
      try {
        await access(candidate, constants.X_OK);
        const file = await stat(candidate); if (!file.isFile()) continue;
        const result = await exec(candidate, ['-version'], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
        const version = result.stdout.split('\n')[0]?.trim();
        if (!version?.startsWith(`${name} version`)) continue;
        return { available: true, path: candidate, version };
      } catch { /* Try the next fixed executable path, never an arbitrary shell command. */ }
    }
    return { available: false, error: `${name} is missing or not executable. Install free FFmpeg (macOS: brew install ffmpeg), or set an absolute OPEN_GENJUTSU_${name.toUpperCase()} path and restart.` };
  };
  const [ffmpeg, ffprobe] = await Promise.all([find('ffmpeg'), find('ffprobe')]);
  return { available: ffmpeg.available && ffprobe.available, ffmpeg, ffprobe };
}
export async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export interface MediaInfo { kind: 'image' | 'video'; width: number; height: number; duration?: number; mimeType: string; extension: string }
export class Media {
  private tools?: { value: Promise<MediaTools>; expires: number };
  constructor(private store: Store, private binaries?: { ffmpeg?: string; ffprobe?: string }) {}
  async status(): Promise<MediaTools> {
    if (!this.tools || this.tools.expires < Date.now()) this.tools = { value: discoverMediaBinaries(this.binaries), expires: Date.now() + 5000 };
    return this.tools.value;
  }
  private async binary(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
    const tools = await this.status(); const tool = tools[name];
    if (!tool.available || !tool.path) throw new HttpError(503, `${name}_missing`, tool.error || `Install ${name} before using media.`);
    return tool.path;
  }
  async probe(filename: string, expected?: 'image' | 'video'): Promise<MediaInfo> {
    let raw: string;
    const ffprobe = await this.binary('ffprobe');
    try {
      const result = await exec(ffprobe, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,codec_name:format=duration,format_name','-of','json',filename], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
      raw = result.stdout;
    } catch { throw new HttpError(400, 'invalid_media', 'Could not decode this media file. Use a valid MP4/WebM video or PNG/JPEG/WebP image.'); }
    const data = JSON.parse(raw) as { streams?: { width?: number; height?: number; codec_name?: string }[]; format?: { duration?: string; format_name?: string } };
    const stream = data.streams?.[0];
    const width = stream?.width || 0; const height = stream?.height || 0;
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 40_000_000) throw new HttpError(400, 'media_dimensions', 'Media must have valid dimensions up to 8192px and 40 megapixels.');
    const images: Record<string, { mimeType: string; extension: string }> = { png: { mimeType: 'image/png', extension: '.png' }, mjpeg: { mimeType: 'image/jpeg', extension: '.jpg' }, webp: { mimeType: 'image/webp', extension: '.webp' } };
    const image = images[stream?.codec_name || ''];
    const duration = Number(data.format?.duration);
    const isImage = !!image && (!Number.isFinite(duration) || duration <= 0);
    const kind = isImage ? 'image' : 'video';
    if (expected && kind !== expected) throw new HttpError(400, 'wrong_media_kind', `This input must be a ${expected}.`);
    if (kind === 'image') return { kind, width, height, ...image! };
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30.1 || width * height > 16_777_216) throw new HttpError(400, 'video_limits', 'Videos must be 30 seconds or shorter and no larger than 4096×4096 equivalent pixels.');
    const webm = data.format?.format_name?.includes('webm');
    return { kind, width, height, duration, mimeType: webm ? 'video/webm' : 'video/mp4', extension: webm ? '.webm' : '.mp4' };
  }
  async adopt(filename: string, name: string, expected?: 'image' | 'video'): Promise<StoredAsset> {
    try {
      const file = await stat(filename);
      if (file.size === 0 || file.size > MAX_FILE_BYTES) throw new HttpError(413, 'file_size', 'Each media file must be between 1 byte and 200MB.');
      const info = await this.probe(filename, expected);
      const id = randomUUID();
      const destination = path.join(this.store.assetDir, id + info.extension);
      await rename(filename, destination);
      const thumbnail = path.join(this.store.assetDir, `${id}.thumb.jpg`);
      let thumbnailUrl: string | undefined;
      try {
        await exec(await this.binary('ffmpeg'), ['-nostdin','-y','-v','error','-i',destination,'-frames:v','1','-vf','scale=320:320:force_original_aspect_ratio=decrease','-q:v','3',thumbnail], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
        thumbnailUrl = `/api/assets/${id}/thumbnail`;
      } catch { /* A valid asset is usable even if optional thumbnail encoding fails. */ }
      const asset: Asset = { id, name: path.basename(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || `asset${info.extension}`, kind: info.kind, width: info.width, height: info.height, duration: info.duration, bytes: file.size, mimeType: info.mimeType, createdAt: new Date().toISOString(), url: `/api/assets/${id}/file`, thumbnailUrl };
      const record: StoredAsset = { asset, filename: destination, thumbnail: thumbnailUrl ? thumbnail : undefined, sha256: await sha256(destination) };
      await this.store.update(state => { state.assets[id] = record; });
      return record;
    } catch (error) { await unlink(filename).catch(() => undefined); throw error; }
  }
  async prepareVideo(source: StoredAsset, frames: number, signal?: AbortSignal): Promise<StoredAsset> {
    const temporary = path.join(this.store.tempDir, `${randomUUID()}.part`);
    const count = Math.max(1, Math.min(frames, MAX_PREVIEW_FRAMES));
    try {
      // Preserve aspect; no stretching/cropping. Decoding into Comfy is now bounded.
      await exec(await this.binary('ffmpeg'), ['-nostdin','-y','-v','error','-i',source.filename,'-an','-vf',"fps=24,scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-frames:v',String(count),'-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast','-crf','18','-movflags','+faststart','-f','mp4',temporary], { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
      return await this.adopt(temporary, `preview-${source.asset.name}.mp4`, 'video');
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}
