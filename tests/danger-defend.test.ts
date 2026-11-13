import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalPredicate, validatePredicate } from '../src/mind/predicate.ts';
import { defend } from '../src/skills/combat.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('技能触发条件 in_wall：头那一格是实心方块', () => {
  const p = validatePredicate({ in_wall: true, hurt_within: 3 }) as any;
  assert.ok(!p.error);
  const sense = (head: string) => ({ state: { hp: 9, inventory: [] } as any, hostiles: [], lightLevel: null, facing: 'N' as const, doing: null, hurtAgoMs: 1000, cover: 'open' as const,
    cell: () => 'air', head });
  assert.equal(evalPredicate(p, sense('gravel')), true);
  assert.equal(evalPredicate(p, sense('air')), false);
  assert.equal(evalPredicate(p, sense('torch')), false, '火把这类不算埋住');
});

test('defend 在低血量时执行已选择的目标；旧 stay 参数仍可用', async () => {
  const w = new TestWorld();
  (w as any).hp = 5;
  const base = w.state.bind(w);
  (w as any).state = () => ({ ...base(), hp: 5 });
  const zombie = { id: 7, name: 'zombie', kind: 'hostile', dist: 1, pos: { x: 1, y: 64, z: 0 } };
  let hits = 0;
  (w as any).attack = async () => { hits++; return true; };
  const ctx = makeCtx(w, { senses: { perceivedEntities: () => (hits >= 2 ? [] : [zombie]) as any }, deadlineMs: 5000 });
  const r = await defend.run(ctx, { target: 'zombie' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(hits, 2, '低血量不应阻止 Agent 已选择的攻击');
  hits = 0;
  const r2 = await defend.run(ctx, { target: 'zombie', stay: true });
  assert.equal(r2.status, 'succeeded', r2.summary);
  assert.equal(hits, 2);
  assert.deepEqual(defend.validate({ stay: true }, w as any), { ok: true, args: { stay: true } });
});

test('defend 把 entityId 0/负数当占位，回退到按 target 名字匹配', () => {
  const w = new TestWorld();
  // 模型不知道真实实体 id 时常写 0：若保留 0，pick() 按 e.id===0 找、贴身也报 NOT_FOUND
  assert.deepEqual(defend.validate({ entityId: 0, target: 'hoglin' }, w as any), { ok: true, args: { target: 'hoglin' } });
  assert.deepEqual(defend.validate({ entityId: -1, target: 'hoglin' }, w as any), { ok: true, args: { target: 'hoglin' } });
  assert.deepEqual(defend.validate({ entityId: 0 }, w as any), { ok: true, args: {} });
  // 正整数才是真实实体 ID，予以保留
  assert.deepEqual(defend.validate({ entityId: 7, target: 'hoglin' }, w as any), { ok: true, args: { entityId: 7, target: 'hoglin' } });
});

test('in_wall 按头格触觉判断：视觉记忆里那格是实心、身体实际头格是空气时不触发', () => {
  const p = validatePredicate({ in_wall: true }) as any;
  const sense = { state: { hp: 20, inventory: [] } as any, hostiles: [], lightLevel: null, facing: 'N' as const, doing: null, hurtAgoMs: Infinity, cover: 'open' as const,
    cell: () => 'netherrack', head: 'air' };
  assert.equal(evalPredicate(p, sense), false, '移动中的旧视觉记忆不能让“埋头”误触发');
  assert.equal(evalPredicate(p, { ...sense, cell: () => 'air', head: 'netherrack' }), true, '头格真被实心方块占住才触发');
});
