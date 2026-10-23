import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { SKILLS } from '../src/skills/index.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const memory = new WorldMemory(null);
  const arbiter = new Arbiter(adapter, memory, bus);
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

test('参数不合法的步骤被拒绝，不会启动', () => {
  const { arbiter } = setup();
  const r = arbiter.start({ skill: 'explore', args: { direction: 'UP' } }, 'llm');
  assert.ok('error' in r);
  assert.equal(arbiter.current, null);
  const r2 = arbiter.start({ skill: 'teleport' }, 'llm');
  assert.ok('error' in r2);
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
