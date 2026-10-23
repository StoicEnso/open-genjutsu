import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { workflowDefaults, sourceCanvas, squareCrop } from '../src/workflow-controls.js';
import type { WorkflowPack } from '../shared/types.js';

test('workflow UI preserves actual graph defaults across legacy and human presets', async () => {
  for (const [file, expected] of [['wan-vace-1.3b.json', [256,256,17,24]], ['wan-vace-human-quality.json',[256,448,33,16]], ['wan-animate-2.json',[480,480,49,24]]] as const) {
    const pack = JSON.parse(await readFile(new URL(`../workflows/${file}`, import.meta.url), 'utf8')) as WorkflowPack;
    const values = workflowDefaults(pack);
    assert.deepEqual([values.width,values.height,values.frames,values.fps], expected);
    const binding = pack.bindings.prompt!;
    assert.equal(values.prompt, pack.graph[binding.nodeId]!.inputs[binding.input]);
  }
});

test('portrait controls require true square displayed crops, including legacy geometry correction', () => {
  const rotated = { width: 128, height: 96 } as import('../shared/types.js').Asset;
  const crop = { x: 0, y: .125, width: 1, height: .75 };
  assert.equal(squareCrop(crop, rotated), false);
  assert.equal(squareCrop(crop, rotated, 96 / 128), true);
  assert.equal(squareCrop({ ...crop, width: 1.000001 }, rotated, .75), false);
  assert.equal(squareCrop(undefined, rotated), false);
});

test('portrait pack exposes actual motion gain and fixed square prep, without unused prompt/seed', async () => {
  const pack = JSON.parse(await readFile(new URL('../workflows/liveportrait-portrait.json', import.meta.url), 'utf8')) as WorkflowPack;
  assert.equal(workflowDefaults(pack).motionStrength, .35);
  assert.equal(workflowDefaults(pack).fps, 16);
  assert.equal(pack.bindings.prompt, undefined);
  assert.equal(pack.bindings.seed, undefined);
});

test('source framing uses full portrait/landscape display aspect and valid canvas increments', () => {
  assert.deepEqual(sourceCanvas(720,1280), {width:272,height:480});
  assert.deepEqual(sourceCanvas(1920,1080), {width:480,height:272});
  assert.deepEqual(sourceCanvas(320,320,480,'2:1'), {width:480,height:240});
  assert.deepEqual(sourceCanvas(720,1280,480,'0:1'), {width:272,height:480});
});
