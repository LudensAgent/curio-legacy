import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passageRoute } from '../src/memory/passages.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { goTo } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

// 一条 L 形矿道：从 (0,40,0) 往东到 (12,40,0)，再往南到 (12,40,12)；另一条从 (12,40,6) 往东岔出去
const main = { path: [{ x: 0, y: 40, z: 0 }, { x: 3, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 9, y: 40, z: 0 }, { x: 12, y: 40, z: 0 }, { x: 12, y: 40, z: 3 }, { x: 12, y: 40, z: 6 }, { x: 12, y: 40, z: 9 }, { x: 12, y: 40, z: 12 }] };
const branch = { path: [{ x: 14, y: 40, z: 6 }, { x: 17, y: 40, z: 6 }, { x: 20, y: 40, z: 6 }] };

test('沿记下的脚下点找路：同一条里前后相邻、不同条挨得近的点连起来', () => {
  const r = passageRoute([main, branch], { x: 0.5, y: 40, z: 0.5 }, { x: 20, y: 40, z: 6 })!;
  assert.deepEqual(r.map((p) => `${p.x},${p.z}`), ['0,0', '3,0', '6,0', '9,0', '12,0', '12,3', '12,6', '14,6', '17,6', '20,6']);
  assert.equal(passageRoute([main], { x: 0, y: 40, z: 0 }, { x: 50, y: 40, z: 50 }), null, '目标离通道太远');
  assert.equal(passageRoute([main], { x: 0, y: 80, z: 0 }, { x: 12, y: 40, z: 12 }), null, '自己离通道太远');
});

test('goto 两头都在通道附近：先沿通道一段段走，结果里说出来', async () => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.savePassage({ id: 'p1', dim: w.state().dim, entrances: [], deepestY: 40, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, ...main } as any);
  const ctx = makeCtx(w, { memory });
  try {
    const r = await goTo.run(ctx, { target: '12,40,12' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /沿自己挖过的通道走了 \d+ 段/);
    assert.ok(w.actions.filter((a) => a === 'moveTo:near').length >= 3);
  } finally { memory.close(); }
});
