import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { homeOf } from '../src/mind/home.ts';
import { sleepSkill } from '../src/skills/build.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const W = '127.0.0.1:25565';

test('睡一觉只记“我的床”，不再新建基地', async () => {
  const w = new TestWorld();
  w.inv.set('white_bed', 1);
  (w as any).sleepInBed = async () => ({ ok: true, bedPos: { x: 5, y: 64, z: 5 } });
  const base0 = w.state.bind(w);
  (w as any).state = () => ({ ...base0(), timeOfDay: 14000, isDay: false });
  const ctx = makeCtx(w);
  try {
    const r = await sleepSkill.run(ctx, { place: true } as any);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(ctx.memory.bases().length, 0);
    assert.ok(ctx.memory.landmarks().some((l) => l.label === '我的床'));
  } finally { ctx.memory.close(); }
});

test('家在哪：有首选基地就是它，不再挑离得最近的那个', () => {
  const m = new WorldMemory(null);
  m.setWorld(W);
  m.setBase('overworld', { x: 300, y: 64, z: 0 }, '高地白桦小舍');
  m.addLandmark('discovery', '小屋', 'overworld', { x: 5, y: 64, z: 0 });
  assert.equal(homeOf(m, { worldId: W, dim: 'overworld', pos: { x: 0, y: 64, z: 0 } })?.label, '高地白桦小舍');
  m.close();
});
