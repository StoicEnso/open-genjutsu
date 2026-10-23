import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset, CloudInput, CloudQuote } from '../shared/types.js';
import { cloudInputIssue, quoteCanBeApproved, sameCloudInput } from '../src/cloud-controls.js';

const source: Asset = { id: 'source', name: 'owned.mp4', kind: 'video', mimeType: 'video/mp4', bytes: 1024, width: 256, height: 256, duration: 6, url: '/source', createdAt: '2026-10-23T00:00:00Z' };
const reference: Asset = { ...source, id: 'reference', name: 'owned.png', kind: 'image', mimeType: 'image/png', duration: undefined };
const input: CloudInput = { sourceVideoId: source.id, referenceImageId: reference.id, prompt: 'A specific user direction.', duration: 5, resolution: '480p', ratio: '16:9' };
const now = Date.parse('2026-10-23T12:00:00Z');
const quote: CloudQuote = { id: 'quote', input, provider: 'comfy-router', modelId: 'byteplus/dreamina-seedance-2-0-260128', modelName: 'Seedance 2.0', expiresAt: '2026-10-23T12:05:00Z', amount: '0.125', currency: 'USD', requestHash: 'owned-fixture-hash', source, reference, warnings: [] };

test('cloud UI only accepts a fresh quote for the exact files and settings', () => {
  assert.equal(quoteCanBeApproved(quote, input, now), true);
  assert.equal(quoteCanBeApproved(quote, { ...input, prompt: 'Changed direction' }, now), false);
  for (const change of [{ duration: 6 }, { resolution: '720p' }, { ratio: '1:1' }, { sourceVideoId: 'other-source' }, { referenceImageId: 'other-reference' }] as const) {
    assert.equal(sameCloudInput(input, { ...input, ...change }), false);
    assert.equal(quoteCanBeApproved(quote, { ...input, ...change }, now), false);
  }
  assert.equal(quoteCanBeApproved(quote, input, Date.parse(quote.expiresAt)), false);
  assert.equal(quoteCanBeApproved({ ...quote, amount: '-1' }, input, now), false);
  assert.equal(quoteCanBeApproved({ ...quote, amount: 'NaN' }, input, now), false);
  assert.equal(quoteCanBeApproved({ ...quote, source: { ...source, id: 'wrong-file' } }, input, now), false);
  assert.equal(quoteCanBeApproved({ ...quote, amount: '0' }, input, now), true);
});

test('cloud UI blocks unsupported whole originals before remote quote upload', () => {
  assert.equal(cloudInputIssue(input, source, reference), undefined);
  assert.match(cloudInputIssue(input, { ...source, duration: 16 }, reference)!, /15 seconds/);
  assert.match(cloudInputIssue(input, { ...source, bytes: 20 * 1024 * 1024 + 1 }, reference)!, /20 MB/);
  assert.match(cloudInputIssue(input, { ...source, mimeType: 'video/webm' }, reference)!, /MP4/);
  assert.match(cloudInputIssue(input, source, { ...reference, mimeType: 'image/webp' })!, /PNG or JPEG/);
  assert.match(cloudInputIssue(input, source, { ...reference, bytes: 10 * 1024 * 1024 + 1 })!, /10 MB/);
  assert.match(cloudInputIssue({ ...input, prompt: 'x'.repeat(1801) }, source, reference)!, /1,800/);
  assert.match(cloudInputIssue({ ...input, duration: 4.5 }, source, reference)!, /4 to 15/);
});
