import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

function pocket() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  (w as any).removed.add('0,60,0'); (w as any).removed.add('0,61,0');
  return w;
}

test('原子动作认绝对坐标 xyz：开工时按当时的位置和朝向换算，太远就说先走近', async (t) => {
  const w = pocket();
  const dig = SKILLS.dig_at;
  const v = dig.validate({ xyz: [0, 62, 0], facing: 'N' }, w);
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepEqual((v as any).args.at, [0, 2, 0], '头顶上方那格');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await dig.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 62, z: 0 }), 'air');
  const far = dig.validate({ xyz: '10,60,0' }, w);
  assert.ok(!far.ok && /先走近/.test((far as any).error), JSON.stringify(far));
  // 人挪了一格：同一个 xyz 指的还是那一格
  w.pos = { x: 0.5, y: 60, z: 1.5 };
  const r2 = await dig.run(ctx, { ...(v as any).args });
  assert.ok(r2.status === 'succeeded', r2.summary);
  assert.match(SKILLS.place_at.argsDoc, /xyz/);
});

test('eat 可以指定吃哪样；不能吃的东西当场说', async (t) => {
  const w = new FakeAdapter();
  w.food = 10;
  w.inv.set('bread', 3); w.inv.set('cooked_beef', 2);
  const eat = SKILLS.eat;
  assert.ok(!eat.validate({ item: 'cobblestone' }, w).ok);
  const v = eat.validate({ item: 'cooked_beef' }, w);
  assert.ok(v.ok, JSON.stringify(v));
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await eat.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.inv.get('bread'), 3, '面包没动');
  assert.ok((w.inv.get('cooked_beef') ?? 0) < 2);
});

test('look 朝方向或坐标转头；dive 只在水里用，气不够就停下回报', async (t) => {
  const w = new FakeAdapter();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  let v = SKILLS.look.validate({ dir: 'S' }, w);
  assert.ok(v.ok);
  await SKILLS.look.run(ctx, (v as any).args);
  assert.ok(Math.abs(Math.abs(w.yaw) - Math.PI) < 0.01, `朝南 yaw=${w.yaw}`);
  v = SKILLS.look.validate({ dir: 'down' }, w);
  await SKILLS.look.run(ctx, (v as any).args);
  assert.ok(w.pitch < -1.4);
  assert.ok(!SKILLS.look.validate({ dir: 'sideways' }, w).ok);
  const d = SKILLS.dive.validate({ xyz: [0, 55, 3] }, w);
  assert.ok(d.ok);
  (w as any).diveTo = async () => ({ ok: false, reason: 'LOW_OXYGEN', reached: false, oxygen: 8 });
  const dry = await SKILLS.dive.run(ctx, (d as any).args);
  assert.match(dry.summary, /不在水里/);
  (w as any).inWater = true;
  const low = await SKILLS.dive.run(ctx, (d as any).args);
  assert.equal(low.status, 'failed');
  assert.match(low.summary, /气快不够了.*surface/);
});
