import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge, setReliableSkills } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { failureFor } from '../src/mind/mind.ts';
import { Vision } from '../src/perception/vision.ts';
import { constrainRecoveryAction, recoveryContext } from '../src/skills/recovery.ts';
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
  await assert.rejects(bridge('digAt', [0, 63, 0, { fall: true }]), /fall:true/);
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

function scopeCtx(recovery: SkillCtx['recovery']) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const ctx: SkillCtx = { adapter, memory, senses: new Vision(adapter), bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'scope-test', progress() {}, recovery };
  return { adapter, memory, ctx };
}

test('恢复不能由普通动作引入组合施工，组合施工只沿用原剩余额度', (t) => {
  const { memory, ctx } = scopeCtx({ skill: 'step', args: { to: [1, 0, 0] } });
  t.after(() => memory.close());
  assert.throws(() => constrainRecoveryAction(ctx, 'excavate_path', { entry: 'current', mode: 'stairs', direction: 'east', steps: 2 }), /显式授权/);
  assert.throws(() => constrainRecoveryAction(ctx, 'climb_up', { height: 1, untilSky: false }), /显式授权/);
  assert.throws(() => constrainRecoveryAction(ctx, 'dig', { dir: 'down', blocks: 1 }), /没有授权挖掘/);

  ctx.recovery = { skill: 'climb_up', args: { height: 5, untilSky: false }, climb: { height: 5, spent: 3, startY: 64 } };
  assert.equal((constrainRecoveryAction(ctx, 'climb_up', { height: 5, untilSky: false }) as { height: number }).height, 2, '只补剩余高度');
  assert.equal((constrainRecoveryAction(ctx, 'climb_up', { height: 1, untilSky: false }) as { height: number }).height, 1);
  assert.throws(() => constrainRecoveryAction(ctx, 'climb_up', { height: 2, untilSky: true }), /停止条件/);

  ctx.recovery = { skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } };
  assert.equal((constrainRecoveryAction(ctx, 'excavate_path', { entry: 'current', mode: 'stairs', direction: 'east', steps: 2 }) as { steps: number }).steps, 2);
  assert.throws(() => constrainRecoveryAction(ctx, 'excavate_path', { entry: 'current', mode: 'stairs', direction: 'east', steps: 4 }), /额度/);
  assert.throws(() => constrainRecoveryAction(ctx, 'excavate_path', { entry: 'other', mode: 'stairs', direction: 'east', steps: 1 }), /原入口/);
  assert.throws(() => constrainRecoveryAction(ctx, 'excavate_path', { entry: 'current', mode: 'stairs', direction: 'west', steps: 1 }), /方向与模式/);
});

test('恢复沿用水面/载具入口与预算，不能改用原始按键或其他移动方式', (t) => {
  const { memory, ctx } = scopeCtx({ skill: 'surface', args: { timeoutMs: 5000 } });
  t.after(() => memory.close());
  assert.equal(constrainRecoveryAction(ctx, 'surface', { timeoutMs: 5000 }).timeoutMs, 5000);
  assert.throws(() => constrainRecoveryAction(ctx, 'surface', { timeoutMs: 6000 }), /时间预算/);
  assert.throws(() => constrainRecoveryAction(ctx, 'swim_to', { xyz: { x: 1, y: 64, z: 1 } }), /不能改用/);

  ctx.recovery = { skill: 'travel', args: { to: 'E 100', noBoat: true } };
  assert.equal(constrainRecoveryAction(ctx, 'travel', { to: 'E 100', noBoat: true }).noBoat, true);
  assert.throws(() => constrainRecoveryAction(ctx, 'travel', { to: 'E 100' }), /没有授权使用船/);
  assert.throws(() => constrainRecoveryAction(ctx, 'travel', { to: 'E 100', noBoat: true, place: true }), /垫方块/);

  ctx.recovery = { skill: 'swim_to', args: { xyz: { x: 1, y: 64, z: 2 } } };
  assert.deepEqual(constrainRecoveryAction(ctx, 'swim_to', { xyz: { x: 1, y: 64, z: 2 } }).xyz, { x: 1, y: 64, z: 2 });
  assert.throws(() => constrainRecoveryAction(ctx, 'swim_to', { xyz: { x: 1, y: 64, z: 3 } }), /原目标坐标/);

  ctx.recovery = { skill: 'step', args: { to: [1, 0, 0] } };
  assert.throws(() => constrainRecoveryAction(ctx, 'press_keys', { keys: { forward: true }, ms: 100 }), /原始按键/);
  ctx.recovery = { skill: 'press_keys', args: { keys: { forward: true }, ms: 100 } };
  assert.equal(constrainRecoveryAction(ctx, 'press_keys', { keys: { forward: true }, ms: 50 }).ms, 50);
  assert.throws(() => constrainRecoveryAction(ctx, 'press_keys', { keys: { forward: true, jump: true }, ms: 100 }), /新增/);
  assert.throws(() => constrainRecoveryAction(ctx, 'press_keys', { keys: { forward: true }, ms: 200 }), /按压时长/);
  assert.throws(() => constrainRecoveryAction(ctx, 'goto', { target: '1,64,1' }), /升级/);

  ctx.recovery = { skill: 'step', args: {}, deadlineMs: Date.now() - 1 };
  assert.throws(() => constrainRecoveryAction(ctx, 'step', { to: [0, 0, 1] }), /期限已过/);
});

test('恢复不能开启未授权的 make、不能换 dig 目标，也不能自选实体', (t) => {
  const { memory, ctx } = scopeCtx({ skill: 'step', args: { to: [1, 0, 0] } });
  t.after(() => memory.close());
  assert.throws(() => constrainRecoveryAction(ctx, 'gather', { make: true }), /自动准备/);
  ctx.recovery = { skill: 'step', args: { to: [1, 0, 0], make: false } };
  assert.equal(constrainRecoveryAction(ctx, 'gather', {}).make, false, '原动作禁止准备时嵌套动作保持 make:false');

  ctx.recovery = { skill: 'dig', args: { target: { x: 1, y: 63, z: 0 }, block: 'stone' } };
  assert.deepEqual(constrainRecoveryAction(ctx, 'dig', { target: { x: 1, y: 63, z: 0 }, block: 'stone' }).target, { x: 1, y: 63, z: 0 });
  assert.throws(() => constrainRecoveryAction(ctx, 'dig', { target: { x: 2, y: 63, z: 0 }, block: 'stone' }), /原目标/);
  assert.throws(() => constrainRecoveryAction(ctx, 'dig', { target: { x: 1, y: 63, z: 0 }, block: 'dirt' }), /方块约束/);
  assert.throws(() => constrainRecoveryAction(ctx, 'dig', { target: { x: 1, y: 63, z: 0 }, block: 'stone', wet: true }), /wet:true/);

  ctx.recovery = { skill: 'dig', args: { dir: 'down', blocks: 2 } };
  assert.equal(constrainRecoveryAction(ctx, 'dig', { dir: 'down', blocks: 2 }).blocks, 2);
  assert.throws(() => constrainRecoveryAction(ctx, 'dig', { dir: 'down', blocks: 3 }), /格数额度/);

  ctx.recovery = { skill: 'step', args: { to: [1, 0, 0] } };
  assert.throws(() => constrainRecoveryAction(ctx, 'hit_entity', { entity: 7 }), /没有指定实体/);
  ctx.recovery = { skill: 'hit_entity', args: { entity: 7 } };
  assert.throws(() => constrainRecoveryAction(ctx, 'hit_entity', { entity: 8 }), /原实体/);
});

test('walk_route 恢复保留原路线点列与末点，不能换入口或重选路线', () => {
  const parsed = recoveryContext({ skill: 'walk_route', args: { points: [[0, 64, 0], [1, 64, 0]] } });
  assert.ok(!('error' in parsed));
  if ('error' in parsed) return;
  assert.deepEqual(parsed.target, { x: 1, y: 64, z: 0 });
  assert.deepEqual(parsed.args.points, [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]);

  const mismatch = recoveryContext({ skill: 'walk_route', args: { points: [[0, 64, 0], [1, 64, 0]] }, target: { x: 2, y: 64, z: 0 } });
  assert.ok('error' in mismatch, 'failure.target 不能替换 walk_route 的路线末点');

  const { memory, ctx } = scopeCtx({ skill: 'walk_route', args: { points: [[0, 64, 0], [1, 64, 0]] }, target: { x: 1, y: 64, z: 0 } });
  try {
    const same = constrainRecoveryAction(ctx, 'walk_route', { points: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }] });
    assert.deepEqual(same.points, [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]);
    assert.throws(() => constrainRecoveryAction(ctx, 'walk_route', { points: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }] }), /原路线点列/);
    assert.throws(() => constrainRecoveryAction(ctx, 'walk_route', { points: [{ x: 0, y: 64, z: 0 }] }), /原路线点列/);
    assert.throws(() => constrainRecoveryAction(ctx, 'walk_to', { to: { x: 1, y: 64, z: 0 }, arrival: { kind: 'exact' } }), /不能改用/);
    assert.throws(() => constrainRecoveryAction(ctx, 'goto', { target: '1,64,0' }), /绕过/);
  } finally {
    memory.close();
  }
});

test('Agent 新的显式委托不受恢复上下文约束', () => {
  const adapter = new FakeAdapter();
  const values = { to: { x: 9, y: 64, z: 9 }, arrival: { kind: 'exact' } };
  const out = constrainRecoveryAction({ adapter } as unknown as SkillCtx, 'walk_to', values);
  assert.deepEqual(out, values, '没有 recovery 时原样放行');
});

test('失败交接会校验高度账本并忽略伪造的 allowPlace/allowDig', () => {
  assert.ok('error' in recoveryContext({ skill: 'climb_up', args: { height: 3 }, climb: { height: 0, spent: 0, startY: 64 } }));
  assert.ok('error' in recoveryContext({ skill: 'climb_up', args: { height: 3 }, climb: { height: 3, spent: -1, startY: 64 } }));
  const forged = recoveryContext({ skill: 'step', args: {}, allowPlace: 'yes', allowDig: 1 });
  assert.ok(!('error' in forged));
  if ('error' in forged) return;
  assert.equal(forged.allowPlace, undefined);
  assert.equal(forged.allowDig, undefined);
});

test('api.move 时长按自身 50–1000 上限校验，恢复不能超过原按键时长', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const ctx: SkillCtx = { adapter, memory, senses: new Vision(adapter), bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'move-duration', progress() {} };
  t.after(() => memory.close());
  const bridge = makeBridge(ctx);
  for (const ms of [1001, 49, 100.5]) {
    await assert.rejects(bridge('move', [{ forward: true }, ms]), /50 到 1000 的整数毫秒/, `api.move 应拒绝 ${ms}`);
  }
  assert.equal(adapter.actions.length, 0, '非法时长不能在身体上执行');
  const withinOwnLimit = await bridge('move', [{ forward: true }, 150]) as { ok: boolean };
  assert.equal(withinOwnLimit.ok, true);

  // 恢复用 api.move 做身体纠偏时，仍受原 press_keys 时长的上限约束。
  ctx.recovery = { skill: 'press_keys', args: { keys: { forward: true }, ms: 200 } };
  await assert.rejects(makeBridge(ctx)('move', [{ forward: true }, 300]), /按压时长/);
  const shortened = await makeBridge(ctx)('move', [{ forward: true }, 150]) as { ok: boolean };
  assert.equal(shortened.ok, true);
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
