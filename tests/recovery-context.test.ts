import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge, setReliableSkills } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { failureFor } from '../src/mind/mind.ts';
import { Vision } from '../src/perception/vision.ts';
import { recoveryContext } from '../src/skills/recovery.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('失败交接保留精确世界目标和限制，不把当前位置或相对坐标猜成目标', () => {
  const input = { target: 'NE 20', make: false, dig: false, avoid: ['lava'] };
  const target = { x: 10.12345, y: 64, z: -8.76543 };
  const failure = failureFor({ skill: 'goto', args: input }, { summary: '未到达', data: { targetCell: target, pos: { x: 2, y: 64, z: 3 } } }, { x: 1.12345, y: 64, z: 2 });
  assert.deepEqual(failure.target, target);
  assert.equal(failure.args, input);
  assert.deepEqual(failure.position, { x: 1.12345, y: 64, z: 2 });
  const missing = failureFor({ skill: 'step', args: { to: [1, 0, 0] } }, { summary: '失败', data: { target: { x: null, y: 64, z: 0 }, pos: { x: 2, y: 64, z: 3 } } }, { x: 1, y: 64, z: 2 });
  assert.equal(missing.target, undefined);
  assert.ok('error' in recoveryContext({ skill: 'step', args: {}, target: [1, 0, 0] }));
});

test('恢复的动作、直接 moveTo 和嵌套技能共用原目标及手段限制', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const ctx: SkillCtx = { adapter, memory, senses: new Vision(adapter), bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'recovery-test', progress() {}, recovery: { skill: 'goto', args: { dig: false, make: false, avoid: ['lava'] }, target: { x: 2, y: 64, z: 0 } } };
  t.after(() => { memory.close(); setBehaviorRegistry(null); setReliableSkills(null); });
  const bridge = makeBridge(ctx);
  await assert.rejects(bridge('act', ['goto', { target: '2,64,0', dig: true }]), /没有授权/);
  const other = await bridge('moveTo', [3, 64, 0, 0]) as { ok: boolean; error?: string };
  assert.equal(other.ok, false);
  assert.match(other.error!, /原绝对目标/);
  setReliableSkills(() => null);
  const child = { name: 'wrong-cell', description: '测试错误目标', steps: [{ skill: 'step', args: { to: [0, 0, 1], facing: 'N' } }], version: 1 };
  // A step recovery has to keep its resolved cell, even through a reliable child.
  ctx.recovery = { skill: 'step', args: { to: [0, 0, 1], facing: 'N' }, target: { x: 2, y: 64, z: 0 } };
  setBehaviorRegistry({ get: () => child, list: () => [child] });
  const nested = await makeBridge(ctx)('useSkill', ['wrong-cell']) as { ok: boolean; summary: string };
  assert.equal(nested.ok, false);
  assert.match(nested.summary, /原动作的目标格/);
  assert.equal(adapter.actions.length, 0, '错误委托在身体动作之前被拒绝');
});

test('恢复挖掘不能打开原未允许的液体风险、换目标格或隐式花方块', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const ctx: SkillCtx = { adapter, memory, senses: new Vision(adapter), bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'dig-recovery', progress() {}, recovery: { skill: 'dig_at', args: { at: [0, -1, 0], facing: 'N', make: false }, target: { x: 0, y: 63, z: 0 } } };
  t.after(() => memory.close());
  const bridge = makeBridge(ctx);
  await assert.rejects(bridge('digAt', [0, 63, 0, { wet: true }]), /wet:true/);
  await assert.rejects(bridge('digAt', [1, 63, 0]), /原动作的目标格/);
  await assert.rejects(bridge('placeAt', [1, 63, 0, 'cobblestone']), /没有授权支出方块/);
  assert.equal(adapter.actions.length, 0);
});

test('原实体 ID 与种类对细动作同样有效，不能绕过 act 改打另一只', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const senses = { refresh() {}, knownBlocks() { return []; }, markSweep() {}, perceivedEntities() {
    return [{ id: 7, name: 'skeleton', kind: 'hostile' as const, dist: 2, pos: { x: 2, y: 64, z: 0 }, perception: 'seen' as const },
      { id: 8, name: 'zombie', kind: 'hostile' as const, dist: 2, pos: { x: 2, y: 64, z: 0 }, perception: 'seen' as const }];
  } };
  const ctx: SkillCtx = { adapter, memory, senses, bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'entity-recovery', progress() {}, recovery: { skill: 'defend', args: { target: 'skeleton' }, entityId: 7 } };
  t.after(() => memory.close());
  const bridge = makeBridge(ctx);
  await assert.rejects(bridge('attack', [8]), /原实体 ID/);
  await assert.rejects(bridge('shoot', [8]), /原实体 ID/);
  await assert.rejects(bridge('move', [{ forward: true }, 100, { face: 8 }]), /原实体 ID/);
  ctx.recovery = { skill: 'defend', args: { target: 'skeleton' } };
  await assert.rejects(makeBridge(ctx)('attack', [8]), /原种类/);
  assert.equal(adapter.actions.length, 0);
});

test('嵌套技能的取消向自己的版本记一次调用，并继续向父层传递取消', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  adapter.moveTo = async () => { throw Object.assign(new Error('取消'), { name: 'AbortedError' }); };
  const child = { name: 'cancelled-child', description: '测试取消', steps: [{ skill: 'step', args: { to: [1, 0, 0], facing: 'E' } }], version: 9 };
  const records: SkillResult[] = [];
  setBehaviorRegistry({ get: () => child, list: () => [child], recordInvocation: (_name, result) => records.push(result) });
  t.after(() => { setBehaviorRegistry(null); memory.close(); });
  const ctx = { adapter, memory, senses: new Vision(adapter), bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'nested-cancel', progress() {}, skillDepth: 1 };
  await assert.rejects(useSkill.run(ctx, { name: child.name }), { name: 'AbortedError' });
  assert.deepEqual(records.map((result) => [result.status, result.data?.version]), [['cancelled', 9]]);
});
