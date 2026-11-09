import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { VISION_FEED_MAX_CELLS, VISION_FEED_REFRESH_MS, Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

function sink() {
  const batches: BlockObservation[][] = [];
  const begins: unknown[] = [];
  return {
    batches, begins,
    observationAdmitted: false, closing: false,
    beginSession(scope: unknown) { begins.push(scope); this.observationAdmitted = true; },
    interrupt() { this.observationAdmitted = false; },
    observe(observations: readonly BlockObservation[]) { batches.push([...observations]); },
  };
}

test('扫描把视线看到的命中面与其上方透明格写进共享空间记忆，墙后与视锥外不写', () => {
  const adapter = new FakeAdapter();
  for (let y = 63; y <= 70; y++) for (let z = -6; z <= 6; z++) adapter.blocks.push({ name: 'stone', pos: { x: 5, y, z } });
  const spatial = sink();
  const vision = new Vision(adapter, undefined, spatial);
  vision.scan();
  assert.equal(spatial.begins.length, 1);
  assert.equal(spatial.batches.length, 1);
  const cells = spatial.batches[0];
  assert.ok(cells.length > 0 && cells.length <= VISION_FEED_MAX_CELLS);
  assert.ok(cells.every((c) => c.source === 'vision' && c.worldId === 'fake-world' && c.dimension === 'overworld'));
  assert.ok(cells.some((c) => c.name === 'stone' && c.pos.x === 5), '看见的墙面要写入');
  assert.ok(cells.some((c) => c.name === 'air'), '命中前的透明格要写入');
  assert.ok(cells.every((c) => c.pos.x <= 5 || Math.abs(c.pos.z) > 6 || c.pos.y > 70), '墙正后方的格没被看见，不写');
  assert.ok(cells.every((c) => c.pos.x >= -1), '背后视锥外的格不写');
});

test('同一画面不重复写，名字变了立即写，超过刷新时间再写一次', () => {
  const adapter = new FakeAdapter();
  const spatial = sink();
  const vision = new Vision(adapter, undefined, spatial);
  vision.scan();
  const first = spatial.batches.length;
  vision.scan();
  assert.equal(spatial.batches.length, first, '没变化不重写');

  adapter.blocks.push({ name: 'cobblestone', pos: { x: 3, y: 63, z: 0 } });
  vision.scan();
  const changed = spatial.batches.at(-1)!;
  assert.ok(changed.some((c) => c.name === 'cobblestone'), '变化的格要写');
  assert.ok(changed.length < spatial.batches[0].length, '只写变化的格');

  const real = Date.now;
  Date.now = () => real() + VISION_FEED_REFRESH_MS + 10;
  try { vision.scan(); } finally { Date.now = real; }
  assert.ok(spatial.batches.at(-1)!.length >= spatial.batches[0].length - 4, '到刷新时间重写');
});

test('未就绪时不写并中断已准入的证据；关停中的共享记忆不写', () => {
  const adapter = new FakeAdapter();
  const spatial = sink();
  const vision = new Vision(adapter, undefined, spatial);
  vision.scan();
  adapter.observationReady = false;
  const n = spatial.batches.length;
  vision.scan();
  vision.observeBlocks([{ x: 1, y: 63, z: 0 }]);
  assert.equal(spatial.batches.length, n);
  assert.equal(spatial.observationAdmitted, false);

  const closing = { ...sink(), closing: true };
  new Vision(new FakeAdapter(), undefined, closing).scan();
  assert.equal(closing.batches.length, 0);
});
