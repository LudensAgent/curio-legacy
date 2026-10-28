import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on('event', (e: AgentEvent) => events.push(e));
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, new WorldMemory(null), bus, vision);
  const reflex = new Reflex(adapter, arbiter, bus, vision);
  return { adapter, bus, events, vision, arbiter, reflex };
};

test('水下氧气不足时身体不自动抢占任务执行 surface', () => {
  const { adapter, events, arbiter, reflex } = setup();
  const task = arbiter.start({ skill: 'explore', args: { distance: 64 } }, 'llm');
  assert.ok(!('error' in task));
  try {
    adapter.inWater = true;
    for (const oxygen of [14, 8, 0]) {
      adapter.oxygen = oxygen;
      reflex.tick();
      assert.equal(arbiter.info()?.id, task.id);
    }
    assert.ok(!events.some((e) => e.type === 'task_start' && e.data?.skill === 'surface'));
    assert.ok(!events.some((e) => e.type === 'reflex' && e.msg.includes('溺水')));
  } finally { arbiter.cancel('end'); }
});

test('进入岩浆时身体不自动抢占任务执行 flee', () => {
  const { adapter, events, arbiter, reflex } = setup();
  const task = arbiter.start({ skill: 'explore', args: { distance: 64 } }, 'llm');
  assert.ok(!('error' in task));
  try {
    adapter.inLava = true;
    reflex.tick();
    assert.equal(arbiter.info()?.id, task.id);
    assert.ok(!events.some((e) => e.type === 'task_start' && e.data?.skill === 'flee'));
  } finally { arbiter.cancel('end'); }
});

test('卡死判定：原地连续挖掘（进度在涨）不算卡死；位置和进度都不变才算', async () => {
  const { adapter, events, arbiter, reflex } = setup();
  SKILLS.test_dig_in_place = {
    name: 'test_dig_in_place', description: '', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      for (let i = 1; i <= 50; i++) {
        await sleep(450, ctx.signal);
        ctx.progress(i / 50);
      }
      return { status: 'succeeded', summary: 'ok' };
    },
  };
  SKILLS.test_frozen = {
    name: 'test_frozen', description: '', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await sleep(60000, ctx.signal);
      return { status: 'succeeded', summary: 'ok' };
    },
  };
  try {
    reflex.start(100);
    let done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_dig_in_place' }, 'llm');
    const o = await done;
    assert.equal(o.result.status, 'succeeded', '进度在推进时不应被判卡死');
    assert.ok(!events.some((e) => e.type === 'stuck'));

    done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_frozen' }, 'llm');
    const o2 = await done;
    assert.equal(o2.result.failureCode, 'STUCK');
  } finally {
    reflex.stop();
    arbiter.cancel('end');
    delete SKILLS.test_dig_in_place;
    delete SKILLS.test_frozen;
  }
});

test('gather 不去挖水下的方块（看得见也不去）', async () => {
  const { adapter, vision, arbiter } = setup();
  // 一个浅水池：x 5..11 的地表换成水，池底有铁矿
  for (let x = 5; x <= 11; x++) for (let z = -2; z <= 2; z++) adapter.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  adapter.blocks.push({ name: 'iron_ore', pos: { x: 8, y: 62, z: 0 } });
  vision.scan();
  assert.equal(vision.knownBlocks(['iron_ore'], 64).length, 1, '透过浅水看得见铁矿');
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'gather', args: { block: 'iron_ore', count: 1 } }, 'llm');
  const o = await done;
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.equal(adapter.inv.get('iron_ore') ?? 0, 0);
});

test('自动插火把：地下暗处顺手插火把，被打断的计划步骤继续且不消耗重试次数', async () => {
  const { adapter, events, arbiter, reflex } = setup();
  adapter.pos = { x: 0, y: 55, z: 0 };
  for (let x = -20; x <= 20; x++) for (const y of [55, 56]) adapter.removed.add(`${x},${y},0`);
  adapter.inv.set('torch', 5);
  adapter.speed = 2;
  const outcomes: TaskOutcome[] = [];
  arbiter.on('done', (o: TaskOutcome) => outcomes.push(o));
  arbiter.start({ skill: 'explore', args: { direction: 'E', distance: 40 } }, 'llm');
  reflex.start(100);
  await sleep(1500);
  reflex.stop();
  arbiter.cancel('end');
  await sleep(100);
  assert.ok(events.some((e) => e.type === 'reflex' && e.msg.includes('火把')), '应顺手插火把');
  assert.ok(adapter.blocks.some((b) => b.name === 'torch'));
  const interrupted = outcomes.find((o) => o.task.skill === 'explore' && o.preemptedBy === 'reflex');
  assert.equal(interrupted?.gentle, true, '插火把属于轻量打断');
});
