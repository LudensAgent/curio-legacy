import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';
import { validateSkill } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('mine_cell：xyz 同时接受 [x,y,z] 和 {x,y,z}', () => {
  const adapter = new FakeAdapter();
  assert.equal(validateSkill(SKILLS.mine_cell!, { xyz: [-1, 64, 0] }, adapter).ok, true);
  assert.equal(validateSkill(SKILLS.mine_cell!, { xyz: { x: -1, y: 64, z: 0 } }, adapter).ok, true);
});

test('mine_cell：运行时收到数组 xyz 也能挖，不会 {...array} 变成 reading x', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  w.removed.add('0,60,0');
  w.removed.add('0,61,0');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  // 消费点边界：线上活动步骤曾带着数组 xyz 直接进 run（日志里的 reading 'x'）
  const r = await SKILLS.mine_cell!.run(ctx, { at: [1, 2, 0], facing: 'N', xyz: [0, 62, 0] } as never);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 62, z: 0 }), 'air', 'xyz 优先于 at');
  assert.notEqual(w.blockAt({ x: 1, y: 62, z: 0 }), 'air');
});
