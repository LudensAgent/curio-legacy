import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge, setReliableSkills } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { SKILLS } from '../src/skills/index.ts';
import { SkillLibrary } from '../src/skills/library.ts';
import { ok, runSkill, type Skill, type SkillCtx, type SkillResult } from '../src/skills/types.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, stubSenses } from './survival-helpers.ts';

const partialOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, '取消必须抛出 Error');
    assert.equal(error.name, 'AbortedError');
    return (error as Error & { partial?: Record<string, unknown> }).partial;
  }
  assert.fail('本应因取消而拒绝');
};

test('代码技能取消时把原始 SkillResult.data 保留为 AbortedError.partial', async (t) => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const ctx = makeCtx(adapter, { memory });
  const data = {
    position: { x: 12.5, y: 64, z: -3.25 },
    time: 1_720_000_000_000,
    oxygen: 7,
    nav: { target: { x: 40, y: 64, z: 8 }, remaining: 3.5 },
  };
  const cancelProbe: Skill = {
    name: 'cancel_probe', description: '', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(): Promise<SkillResult> { return { status: 'cancelled', summary: '已取消', data }; },
  };
  const thrownPartial = { position: { x: 1.25, y: 70, z: 2.5 }, oxygen: 3 };
  const thrown = Object.assign(new Error('original abort'), { name: 'AbortedError', partial: thrownPartial });
  const throwProbe: Skill = {
    name: 'throw_probe', description: '', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(): Promise<SkillResult> { throw thrown; },
  };
  SKILLS[cancelProbe.name] = cancelProbe;
  SKILLS[throwProbe.name] = throwProbe;
  t.after(() => {
    delete SKILLS[cancelProbe.name];
    delete SKILLS[throwProbe.name];
    setBehaviorRegistry(null);
    setReliableSkills(null);
    memory.close();
  });

  // api.act 分支
  assert.deepEqual(await partialOf(makeBridge(ctx)('act', [cancelProbe.name, {}])), data);

  // api.useSkill 分支：包裹层会在 data 上补 version，但嵌套的观测事实必须原样保留。
  const behavior = { name: 'cancel_through_use', description: '测试取消', steps: [{ skill: cancelProbe.name }] };
  setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [behavior] });
  setReliableSkills(() => null);
  const nested = await partialOf(makeBridge(ctx)('useSkill', [behavior.name]));
  assert.deepEqual(nested?.position, data.position);
  assert.equal(nested?.time, data.time);
  assert.equal(nested?.oxygen, data.oxygen);
  assert.deepEqual(nested?.nav, data.nav);

  // 已经抛出的原始 AbortedError（含 partial）不得被替换或丢掉。
  const error = await (async () => {
    try { await makeBridge(ctx)('act', [throwProbe.name, {}]); } catch (e) { return e; }
    assert.fail('本应抛出原始 AbortedError');
  })();
  assert.equal(error, thrown);
  assert.deepEqual((error as Error & { partial?: Record<string, unknown> }).partial, thrownPartial);
});

test('代码技能中失败的 stepTo/step 后，相对 at 的 dig/place 不得按原计划执行', async (t) => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const originalStep = SKILLS.step;
  // 模拟一次“身体没有换到新站位”的失败步骤；不改真实 step 的校验/执行实现。
  SKILLS.step = {
    name: 'step', description: '测试失败步骤', argsDoc: '{}', timeoutMs: 1000, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(): Promise<SkillResult> {
      return { status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: '没有换到新站位', data: { position: { x: 0.5, y: 64, z: 0.5 } } };
    },
  };
  t.after(() => {
    SKILLS.step = originalStep;
    memory.close();
  });
  const bridge = makeBridge(makeCtx(adapter, { memory }));

  // 绝对 api.stepTo 失败后，相对 at 的挖掘/放置仍按当前（未换）站位解析，必须拒绝。
  const stepped = await bridge('stepTo', [1, 64, 0]) as { ok: boolean };
  assert.equal(stepped.ok, false);
  await assert.rejects(bridge('act', ['dig_at', { at: [1, -1, 0], facing: 'N' }]), /没到新站位/);
  await assert.rejects(bridge('act', ['place_at', { at: [1, -1, 0], item: 'dirt', facing: 'N' }]), /没到新站位/);

  // 通过 api.act 调用相对/绝对 step 同样记录未到达缺口。
  const viaAct = await bridge('act', ['step', { to: [1, 0, 0], facing: 'N' }]) as { ok: boolean };
  assert.equal(viaAct.ok, false);
  await assert.rejects(bridge('act', ['dig_at', { at: [1, -1, 0], facing: 'N' }]), /没到新站位/);
  assert.equal(adapter.actions.length, 0, '被拒绝的相对动作不能在身体上执行');
});

test('组合技能的子动作经过共享校验与恢复约束，不能绕过原目标或地形授权', async (t) => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const created: string[] = [];
  const restore = new Map<string, Skill | undefined>();
  const install = (skill: Skill) => {
    if (!restore.has(skill.name)) restore.set(skill.name, SKILLS[skill.name]);
    SKILLS[skill.name] = skill;
  };
  const observed: { signal: AbortSignal; taskId: string; recovery: unknown; make: boolean | undefined; deadline: number }[] = [];
  const probe: Skill = {
    name: 'boundary_probe', description: '', argsDoc: '{}', timeoutMs: 600_000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(runCtx): Promise<SkillResult> {
      observed.push({ signal: runCtx.signal, taskId: runCtx.taskId, recovery: runCtx.recovery, make: runCtx.make, deadline: runCtx.deadline });
      return ok('probe');
    },
  };
  install(probe);
  const lib = new SkillLibrary(null, adapter, memory, new EventBus());
  const learn = (name: string, steps: { skill: string; args?: unknown }[]) => {
    const learned = lib.learn({ name, description: name, steps });
    assert.ok(learned.ok, learned.ok ? '' : learned.error);
    created.push(learned.name);
    return learned.name;
  };
  t.after(() => {
    for (const name of created) delete SKILLS[name];
    for (const [name, skill] of restore) {
      if (skill) SKILLS[name] = skill;
      else delete SKILLS[name];
    }
    memory.close();
  });

  const otherMacro = learn('goto_other', [
    { skill: 'goto', args: { target: '3,64,0' } },
    { skill: 'goto', args: { target: '3,64,0' } },
  ]);
  const digMacro = learn('goto_dig', [
    { skill: 'goto', args: { target: '2,64,0', dig: true } },
    { skill: 'goto', args: { target: '2,64,0', dig: true } },
  ]);
  const sameMacro = learn('goto_same', [
    { skill: 'goto', args: { target: '2,64,0' } },
    { skill: 'goto', args: { target: '2,64,0' } },
  ]);
  const probeMacro = learn('probe_ctx', [
    { skill: probe.name },
    { skill: probe.name },
  ]);

  const ctx: SkillCtx = {
    ...makeCtx(adapter, { memory }),
    senses: stubSenses(adapter), taskId: 'macro-parent', make: true,
    recovery: { skill: 'goto', args: { dig: false }, target: { x: 2, y: 64, z: 0 } },
  };
  const bridge = makeBridge(ctx);

  // 宏里的 goto 想换成另一个世界坐标：必须在身体动作之前拒绝。
  const other = await bridge('act', [otherMacro, {}]) as { ok: boolean; summary: string };
  assert.equal(other.ok, false);
  assert.match(other.summary, /原绝对目标/);
  assert.equal(adapter.actions.length, 0, '换目标的宏不能在身体上执行任何动作');

  // 宏里的 goto 想打开原委托没有的 dig 权限：同样必须在动作前拒绝。
  const dig = await bridge('act', [digMacro, {}]) as { ok: boolean; summary: string };
  assert.equal(dig.ok, false);
  assert.match(dig.summary, /没有授权挖穿/);
  assert.equal(adapter.actions.length, 0, '越权地形的宏不能在身体上执行任何动作');

  // 同一个原目标、未越权：放行且确实执行了身体动作。
  adapter.actions.length = 0;
  const same = await bridge('act', [sameMacro, {}]) as { ok: boolean; summary: string };
  assert.equal(same.ok, true, same.summary);
  assert.ok(adapter.actions.some((action) => action.startsWith('moveTo')), '允许的宏应真的走起来');
  assert.deepEqual({ x: Math.floor(adapter.pos.x), y: Math.floor(adapter.pos.y), z: Math.floor(adapter.pos.z) }, { x: 2, y: 64, z: 0 });

  // 子步骤收到的父上下文与截止时间不变（取父 deadline 与子静态超时的较小者，不重置预算）。
  observed.length = 0;
  const result = await runSkill(ctx, SKILLS[probeMacro]!, {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(observed.length, 2, '两步都应执行');
  for (const step of observed) {
    assert.equal(step.signal, ctx.signal);
    assert.equal(step.taskId, ctx.taskId);
    assert.equal(step.recovery, ctx.recovery);
    assert.equal(step.make, true);
    assert.equal(step.deadline, ctx.deadline);
  }
});
