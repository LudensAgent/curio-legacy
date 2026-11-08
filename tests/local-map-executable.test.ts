import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { localMap } from '../src/perception/local.ts';
import { after } from '../src/skills/movement/coordinates.ts';
import { moveStep } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const flat = () => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
};

test('对角可站位保留为候选并标注需要多步，不进入可执行单步', () => {
  const w = flat();
  const map = localMap(w, w.pos, 'N', observeAllBlocks(w));
  const diagonal = map.spots.stand.filter((spot) => /^\[-?1,\d,-?1\]/.test(spot));
  assert.equal(diagonal.length, 4, `四个对角候选：${map.spots.stand}`);
  assert.ok(diagonal.every((spot) => spot.includes('对角，需多步')), '对角必须标明需要多步');
  assert.equal(map.spots.executable.length, 4, `只列四个正交单步：${JSON.stringify(map.spots.executable)}`);
  assert.ok(map.spots.executable.every((item) => Math.abs(item.at[0]) + Math.abs(item.at[2]) === 1));
});

test('executable 的落点与 move_step 单步预检一致', () => {
  const w = flat();
  const map = localMap(w, w.pos, 'N', observeAllBlocks(w));
  for (const item of map.spots.executable) {
    const v = moveStep.validate({ xyz: item.xyz, facing: item.facing }, w);
    assert.equal(v.ok, true, `${JSON.stringify(item)}：${v.ok ? '' : v.error}`);
  }
});

test('半砖的分数脚高只作为上一级可执行落点，不伪装成同层', () => {
  const w = flat();
  w.blocks.push({ name: 'oak_slab', pos: { x: 0, y: 64, z: -1 } });
  w.blockProperties.set('0,64,-1', { type: 'bottom' });
  const map = localMap(w, w.pos, 'N', observeAllBlocks(w));
  const up = map.spots.executable.find((item) => item.at[0] === 1 && item.at[2] === 0);
  assert.deepEqual(up?.at, [1, 1, 0], '半砖应作为上一级 [1,1,0] 的一步');
  assert.equal(up?.foot, 64.5);
  assert.deepEqual(up?.xyz, [0, 64.5, -1]);
  assert.ok(!map.spots.executable.some((item) => item.at[1] === 0 && item.at[0] === 1 && item.at[2] === 0), '不能同时列成同层');
});

test('after 把身体压着的门格作为触觉事实传入局部图', () => {
  const w = flat();
  w.blocks.push({ name: 'nether_portal', pos: { x: 0, y: 64, z: 0 } }, { name: 'nether_portal', pos: { x: 0, y: 65, z: 0 } });
  const ctx = makeCtx(w);
  const facts = after(ctx, 'N') as { local: { body: { feet: string | null; head: string | null } }; around: string };
  assert.equal(facts.local.body.feet, 'nether_portal');
  assert.equal(facts.local.body.head, 'nether_portal');
  assert.match(facts.around, /身体所在格 nether_portal/);
  ctx.memory.close();
});
