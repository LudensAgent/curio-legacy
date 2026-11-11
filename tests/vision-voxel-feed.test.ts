import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { VISION_FEED_MAX_CELLS, VISION_FEED_REFRESH_MS, Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 每帧有上限：反复扫到不再有新批次，把这一画面的积压写完。 */
function drain(vision: Vision, spatial: { batches: BlockObservation[][] }) {
  for (let i = 0; i < 64; i++) { const n = spatial.batches.length; vision.scan(); if (spatial.batches.length === n) return; }
  throw new Error('积压没有写完');
}

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
  assert.ok(spatial.batches[0].length > 0 && spatial.batches[0].length <= VISION_FEED_MAX_CELLS, '每帧不超过上限');
  drain(vision, spatial);
  assert.ok(spatial.batches.every((b) => b.length <= VISION_FEED_MAX_CELLS));
  const cells = spatial.batches.flat();
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
  drain(vision, spatial);
  const total = spatial.batches.flat().length;
  const first = spatial.batches.length;
  vision.scan();
  assert.equal(spatial.batches.length, first, '积压写完后没变化不重写');

  adapter.blocks.push({ name: 'cobblestone', pos: { x: 3, y: 63, z: 0 } });
  vision.scan();
  const changed = spatial.batches.at(-1)!;
  assert.ok(changed.some((c) => c.name === 'cobblestone'), '变化的格要写');
  assert.ok(changed.length < 10, '只写变化的格');

  const real = Date.now;
  Date.now = () => real() + VISION_FEED_REFRESH_MS + 10;
  try { vision.scan(); } finally { Date.now = real; }
  assert.equal(spatial.batches.at(-1)!.length, Math.min(VISION_FEED_MAX_CELLS, total), '到刷新时间重写（仍受每帧上限）');
});

test('记忆整体标过期后（死亡、中断、暂停恢复），身边已写过的格立即重写，不等刷新时间', () => {
  const adapter = new FakeAdapter();
  const spatial = { ...sink(), staleEpoch: 0 };
  const vision = new Vision(adapter, undefined, spatial);
  drain(vision, spatial);
  const first = spatial.batches.length;
  vision.scan();
  assert.equal(spatial.batches.length, first, '无变化不重写');
  spatial.staleEpoch++;
  vision.scan();
  assert.equal(spatial.batches.length, first + 1, '标过期后立即重写');
  assert.ok(spatial.batches.at(-1)!.some((c) => c.name === 'air'));
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

test('近处视线穿过的透明格整段写入：平地前方的脚部与头部空气都有证据，空区段也不跳过', () => {
  // 地面 y=63 正好在区段边界下方，脚/头空气所在的 64..79 区段整段为空。
  const adapter = new FakeAdapter();
  const spatial = sink();
  const vision = new Vision(adapter, undefined, spatial);
  const started = performance.now();
  vision.scan();
  const firstScanMs = performance.now() - started;
  drain(vision, spatial);
  const cells = spatial.batches.flat();
  const air = new Set(cells.filter((c) => c.name === 'air').map((c) => `${c.pos.x},${c.pos.y},${c.pos.z}`));
  for (let x = 1; x <= 8; x++) {
    assert.ok(air.has(`${x},64,0`), `前方 ${x} 格的脚部空气要有证据`);
    assert.ok(air.has(`${x},65,0`), `前方 ${x} 格的头部空气要有证据`);
  }
  assert.ok(spatial.batches.length <= 6, `一个画面应在几帧内写完，实际 ${spatial.batches.length} 帧、${cells.length} 格`);
  assert.ok(firstScanMs < 250, `单次扫描耗时 ${firstScanMs.toFixed(1)}ms`);
});

test('周边扫描：身后与脚下的地形也写入，16 格内贴地空气与表面方块都有证据', () => {
  const adapter = new FakeAdapter();
  const spatial = sink();
  const vision = new Vision(adapter, undefined, spatial);
  for (let i = 0; i < 8; i++) { vision.scanSurroundings(); Reflect.set(vision, 'lastSurround', null); }
  const cells = new Map(spatial.batches.flat().map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`, c.name]));
  for (const x of [-12, -6, 0, 6, 12]) {
    assert.equal(cells.get(`${x},63,0`), 'grass_block', `x=${x} 的地面（含身后）`);
    assert.equal(cells.get(`${x},64,0`), 'air', `x=${x} 的脚部空气`);
    assert.equal(cells.get(`${x},65,0`), 'air', `x=${x} 的头部空气`);
  }
  assert.equal(cells.get('0,62,0'), undefined, '地面下方被遮住的方块不写');
  assert.equal(cells.get('0,68,0'), undefined, '半空空气不写');
  assert.ok(![...cells.keys()].some((key) => Math.hypot(Number(key.split(',')[0]), Number(key.split(',')[2])) > 16.01), '不超过半径');
});

test('周边扫描不穿墙：被实心方块围住的空腔不写入', () => {
  const adapter = new FakeAdapter();
  // 地下 y=60 处一个与地面不连通的空腔。
  adapter.blocks.push({ name: 'air', pos: { x: 3, y: 60, z: 0 } }, { name: 'iron_ore', pos: { x: 4, y: 60, z: 0 } });
  const spatial = sink();
  const vision = new Vision(adapter, undefined, spatial);
  for (let i = 0; i < 8; i++) { vision.scanSurroundings(); Reflect.set(vision, 'lastSurround', null); }
  const cells = new Map(spatial.batches.flat().map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`, c.name]));
  assert.equal(cells.get('3,60,0'), undefined);
  assert.equal(cells.get('4,60,0'), undefined, '封闭空腔旁的矿石不写');
});
