import type { Asset, CloudInput, CloudQuote } from '../shared/types';

/** Quotes authorize one exact request. Changes always require a new quote. */
export function sameCloudInput(a: CloudInput, b: CloudInput): boolean {
  return a.sourceVideoId === b.sourceVideoId && a.referenceImageId === b.referenceImageId && a.prompt === b.prompt &&
    a.duration === b.duration && a.resolution === b.resolution && a.ratio === b.ratio;
}

export function cloudInputIssue(input: CloudInput, source?: Asset, reference?: Asset): string | undefined {
  if (!source || source.kind !== 'video' || source.id !== input.sourceVideoId) return 'Choose a driving video.';
  if (!['video/mp4', 'video/quicktime'].includes(source.mimeType) || source.bytes > 20 * 1024 * 1024) return 'Use an MP4 or MOV source up to 20 MB.';
  if (!Number.isFinite(source.duration) || !source.duration || source.duration > 15) return 'Choose a source video no longer than 15 seconds. The whole uploaded clip is sent.';
  if (!reference || reference.kind !== 'image' || reference.id !== input.referenceImageId) return 'Choose one character reference image.';
  if (!['image/png', 'image/jpeg'].includes(reference.mimeType) || reference.bytes > 10 * 1024 * 1024) return 'Use a PNG or JPEG reference up to 10 MB.';
  if (!input.prompt.trim() || input.prompt.length > 1800) return 'Add a direction of 1–1,800 characters.';
  if (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15) return 'Choose an output duration from 4 to 15 seconds.';
  if (!['480p', '720p'].includes(input.resolution) || !['1:1', '16:9', '9:16'].includes(input.ratio)) return 'Choose a supported resolution and aspect ratio.';
  return undefined;
}

export function quoteCanBeApproved(quote: CloudQuote | undefined, input: CloudInput, now: number): boolean {
  return Boolean(quote && quote.id && quote.requestHash && quote.modelId && quote.modelName && quote.provider === 'comfy-router' && quote.currency === 'USD' &&
    /^\d+(?:\.\d+)?$/.test(quote.amount) && Number.isFinite(Number(quote.amount)) && Number(quote.amount) >= 0 &&
    Date.parse(quote.expiresAt) > now && sameCloudInput(quote.input, input) &&
    quote.source.id === input.sourceVideoId && quote.reference.id === input.referenceImageId);
}

export function quotePrice(quote: Pick<CloudQuote, 'amount' | 'currency'>): string {
  return `${quote.amount} ${quote.currency}`;
}
