import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalPredicate, validatePredicate } from '../src/mind/predicate.ts';
import { defend } from '../src/skills/combat.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('技能触发条件 in_wall：头那一格是实心方块', () => {
  const p = validatePredicate({ in_wall: true, hurt_within: 3 }) as any;
  assert.ok(!p.error);
  const sense = (head: string) => ({ state: { hp: 9, inventory: [] } as any, hostiles: [], lightLevel: null, facing: 'N' as const, doing: null, hurtAgoMs: 1000, cover: 'open' as const,
    cell: (rel: [number, number, number]) => rel[1] === 1 ? head : 'air' });
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
