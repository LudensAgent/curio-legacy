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
  const dig = SKILLS.mine_cell;
  const v = dig.validate({ xyz: [0, 62, 0], facing: 'N' }, w);
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepEqual((v as any).args.xyz, { x: 0, y: 62, z: 0 }, '绝对坐标保留世界格');
  const ctx = makeCtx(w);
  ctx.senses.observeBlocks = (positions) => positions.flatMap((pos) => {
    const name = w.blockAt(pos);
    return name === null ? [] : [{ pos, name, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
      dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const }];
  });
  t.after(() => ctx.memory.close());
  const r = await dig.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 62, z: 0 }), 'air');
  const far = dig.validate({ xyz: '10,60,0' }, w);
  assert.ok(!far.ok && /不在身边/.test((far as any).error), JSON.stringify(far));
  // 人挪了一格：同一个 xyz 指的还是那一格
  w.pos = { x: 0.5, y: 60, z: 1.5 };
  const r2 = await dig.run(ctx, { ...(v as any).args });
  assert.ok(r2.status === 'succeeded', r2.summary);
  assert.match(SKILLS.place_cell.argsDoc, /xyz/);
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

test('look 朝方向或坐标转头', async (t) => {
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
  // 计划规范化会把 [x,y,z] 写成 {x,y,z}：两种写法都要接受，规范化输出再校验不变。
  const fromArray = SKILLS.look.validate({ xyz: [3, 64, 0] }, w);
  const fromObject = SKILLS.look.validate({ xyz: { x: 3, y: 64, z: 0 } }, w);
  assert.ok(fromArray.ok && fromObject.ok);
  assert.deepEqual(fromObject, fromArray);
  assert.deepEqual(SKILLS.look.validate((fromObject as { args: unknown }).args, w), fromObject);
  assert.ok(!SKILLS.look.validate({ xyz: { x: 3, y: 'up', z: 0 } }, w).ok);
  const { dive: diveSkill } = await import('../src/skills/actions.ts');
  const dive = diveSkill.validate({ xyz: [3, 60, 0] }, w);
  assert.ok(dive.ok);
  assert.deepEqual(diveSkill.validate((dive as { args: unknown }).args, w), dive, 'dive 规范化输出再校验不变');
});

test('心智看到的动作表：隐藏的填充动作不列给心智', async () => {
  const { movesCatalog } = await import('../src/mind/prompt.ts');
  const { LLM_HIDDEN } = await import('../src/skills/index.ts');
  assert.ok(LLM_HIDDEN.has('unstuck'));
  assert.ok(!/\bwander\b/.test(movesCatalog(28)));
  assert.match(movesCatalog(28), /^- look .*"dir".*"xyz"/m, 'look 提供完整参数');
});
