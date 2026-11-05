import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const memory = new WorldMemory(null);
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  const next = () => new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  return { adapter, bus, memory, arbiter, next };
};

test('取消任务：立即释放控制，任务以 cancelled 结束', async () => {
  const { adapter, arbiter, next } = setup();
  adapter.speed = 1; // 很慢，保证任务还在进行
  arbiter.start({ skill: 'explore', args: { distance: 64 } }, 'llm');
  await sleep(100);
  const done = next();
  arbiter.cancel('测试取消');
  const o = await done;
  assert.equal(o.result.status, 'cancelled');
  assert.ok(adapter.stopAllCount >= 1);
  assert.equal(arbiter.current, null);
});

test('beginShutdown 停止新任务与控制，但不把共享会话标记为暂停', async () => {
  const adapter = new FakeAdapter();
  adapter.speed = 1;
  const bus = new EventBus();
  const memory = new WorldMemory(null);
  const spatialCalls: boolean[] = [];
  const spatial = {
    setPaused: (paused: boolean) => { spatialCalls.push(paused); },
    interrupt: () => {},
  } as unknown as SharedSpatialSession;
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter), spatial);
  try {
    arbiter.start({ skill: 'explore', args: { distance: 64 } }, 'llm');
    await sleep(100);
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    arbiter.beginShutdown();
    const outcome = await done;
    assert.equal(outcome.result.status, 'cancelled');
    assert.equal(arbiter.paused, true, '关停后不得再接受新任务');
    assert.deepEqual(spatialCalls, [], '关停不得调用空间会话 setPaused（会丢弃 pending）');
    assert.ok(adapter.stopAllCount >= 1);
  } finally {
    arbiter.dispose();
  }
});

test('旧任务被取消后再发动作会被拦截（planVersion 守卫）', async () => {
  const { adapter, arbiter, next } = setup();
  SKILLS.test_rogue = {
    name: 'test_rogue', description: '', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await sleep(150); // 故意不传 signal：模拟写得不好的技能
      ctx.adapter.chat('我还想继续动');
      return { status: 'succeeded', summary: 'should not reach' };
    },
  };
  try {
    arbiter.start({ skill: 'test_rogue' }, 'llm');
    const done = next();
    await sleep(20);
    arbiter.cancel('抢占');
    const o = await done;
    assert.equal(o.result.status, 'cancelled');
    assert.equal(arbiter.blockedActions, 1);
    assert.ok(!adapter.actions.some((a) => a.startsWith('chat:')), '被取消的任务不应发出任何动作');
  } finally {
    delete SKILLS.test_rogue;
  }
});

test('抢占：新任务启动时旧任务记录 preemptedBy，planVersion 递增', async () => {
  const { adapter, arbiter, next } = setup();
  adapter.speed = 1;
  const a = arbiter.start({ skill: 'explore', args: { distance: 64 } }, 'llm');
  const done = next();
  const b = arbiter.start({ skill: 'look_around', args: { seconds: 2 } }, 'reflex');
  const o = await done;
  assert.equal(o.preemptedBy, 'reflex');
  assert.ok('planVersion' in a && 'planVersion' in b && b.planVersion === a.planVersion + 1);
  assert.equal(arbiter.info()?.skill, 'look_around');
  arbiter.cancel('cleanup');
});

test('取消后的旧任务不能用独立信号下船', async () => {
  const { adapter, arbiter, next } = setup();
  adapter.riding = 'boat';
  SKILLS.test_stale_dismount = {
    name: 'test_stale_dismount', description: '', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await sleep(30);
      await ctx.adapter.dismount?.(new AbortController().signal);
      return { status: 'succeeded', summary: 'should not reach' };
    },
  };
  try {
    const completed = next();
    arbiter.start({ skill: 'test_stale_dismount' }, 'llm');
    arbiter.cancel('replan');
    assert.equal((await completed).result.status, 'cancelled');
    assert.equal(arbiter.blockedActions, 1);
    assert.equal(adapter.riding, 'boat');
  } finally { delete SKILLS.test_stale_dismount; }
});

test('参数不合法的步骤被拒绝，不会启动', () => {
  const { arbiter } = setup();
  const r = arbiter.start({ skill: 'explore', args: { direction: 'UP' } }, 'llm');
  assert.ok('error' in r);
  assert.equal(arbiter.current, null);
  const r2 = arbiter.start({ skill: 'teleport' }, 'llm');
  assert.ok('error' in r2);
});

test('moveTo 合并调用方子信号：子信号取消中止动作，任务信号仍存活', async () => {
  const { adapter, arbiter, next } = setup();
  adapter.speed = 0.2; // 50 格需要 250 秒：只有真实取消才能让这次移动结束
  const segment = new AbortController();
  const taskSignals: AbortSignal[] = [];
  SKILLS.test_segment_cancel = {
    name: 'test_segment_cancel', description: '', argsDoc: '{}', timeoutMs: 2500, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      taskSignals.push(ctx.signal);
      try {
        await ctx.adapter.moveTo({ kind: 'xyz', x: 50, y: 64, z: 0 }, { signal: segment.signal, timeoutMs: 2000 });
        return { status: 'succeeded', summary: '不应走到' };
      } catch (e) {
        return { status: 'cancelled', summary: (e as Error).message };
      }
    },
  };
  try {
    const done = next();
    arbiter.start({ skill: 'test_segment_cancel' }, 'llm');
    const beganAt = Date.now();
    while (!adapter.actions.some((a) => a.startsWith('moveTo:'))) {
      if (Date.now() - beganAt > 2000) assert.fail('moveTo 未开始');
      await sleep(10);
    }
    segment.abort('segment cancelled');
    const o = await done;
    assert.equal(o.result.status, 'cancelled');
    assert.match(o.result.summary, /segment cancelled/, '调用方子信号的中止原因必须传给 moveTo');
    assert.equal(taskSignals.length, 1);
    assert.equal(taskSignals[0]?.aborted, false, '子信号取消不得改写任务信号');
  } finally {
    delete SKILLS.test_segment_cancel;
  }
});

test('moveTo 合并任务信号：任务取消仍中止调用方的动作', async () => {
  const { adapter, arbiter, next } = setup();
  adapter.speed = 0.2;
  const segment = new AbortController();
  SKILLS.test_task_cancel = {
    name: 'test_task_cancel', description: '', argsDoc: '{}', timeoutMs: 2500, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      try {
        await ctx.adapter.moveTo({ kind: 'xyz', x: 50, y: 64, z: 0 }, { signal: segment.signal, timeoutMs: 60_000 });
        return { status: 'succeeded', summary: '不应走到' };
      } catch (e) {
        return { status: 'cancelled', summary: (e as Error).message };
      }
    },
  };
  try {
    const done = next();
    arbiter.start({ skill: 'test_task_cancel' }, 'llm');
    const beganAt = Date.now();
    while (!adapter.actions.some((a) => a.startsWith('moveTo:'))) {
      if (Date.now() - beganAt > 2000) assert.fail('moveTo 未开始');
      await sleep(10);
    }
    arbiter.cancel('replan');
    const o = await done;
    assert.equal(o.result.status, 'cancelled');
    assert.match(o.result.summary, /replan/, '任务取消的原因必须经合并信号传给 moveTo');
    assert.equal(segment.signal.aborted, false, '任务取消不得中止调用方自己的子信号');
  } finally {
    delete SKILLS.test_task_cancel;
  }
});

test('moveTo 合并信号在动作落定后移除调用方监听', async () => {
  const { arbiter, next } = setup();
  const listeners = new Set<() => void>();
  let added = 0;
  const caller = {
    aborted: false,
    reason: undefined,
    addEventListener: (_type: string, fn: () => void) => { added++; listeners.add(fn); },
    removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
  } as unknown as AbortSignal;
  SKILLS.test_segment_cleanup = {
    name: 'test_segment_cleanup', description: '', argsDoc: '{}', timeoutMs: 2000, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await ctx.adapter.moveTo({ kind: 'xyz', x: 0, y: 64, z: 0 }, { signal: caller, timeoutMs: 500 });
      return { status: 'succeeded', summary: '到了' };
    },
  };
  try {
    const done = next();
    arbiter.start({ skill: 'test_segment_cleanup' }, 'llm');
    const o = await done;
    assert.equal(o.result.status, 'succeeded');
    assert.equal(added, 1, '调用方信号应被合并监听一次');
    assert.equal(listeners.size, 0, '动作落定后必须移除调用方信号上的监听');
  } finally {
    delete SKILLS.test_segment_cleanup;
  }
});

test('技能完成后记录统计与结果', async () => {
  const { adapter, arbiter, memory, next } = setup();
  adapter.blocks = [{ name: 'oak_log', pos: { x: 3, y: 64, z: 0 } }, { name: 'oak_log', pos: { x: 4, y: 65, z: 1 } }];
  arbiter.start({ skill: 'gather', args: { block: 'log', count: 2 } }, 'llm');
  const o = await next();
  assert.equal(o.result.status, 'succeeded');
  assert.equal(adapter.inv.get('oak_log'), 2);
  assert.equal(memory.skillStats().gather.ok, 1);
});
