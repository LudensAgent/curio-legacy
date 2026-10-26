import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EffectWatch } from '../src/brain/effects.ts';
import { EventBus } from '../src/events.ts';
import { Attention } from '../src/mind/attention.ts';
import { tossItem } from '../src/skills/hands.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('持续效果：扔掉的东西被自己捡回来，说清楚之后做过什么、捡回来时在做什么；指名捡回不算', async () => {
  const bus = new EventBus();
  const seen: { msg: string; data: any }[] = [];
  bus.on('event', (ev: any) => { if (ev.type === 'effect_broken') seen.push(ev); });
  const fx = new EffectWatch(bus);
  bus.publish('task_end', 'P2', 'toss', { taskId: 't1', status: 'succeeded', skill: 'toss_item', expect: { discarded: ['dirt'], forMs: 180_000, what: '扔掉了 dirt×32' } });
  bus.publish('task_start', 'P2', 'dig', { taskId: 't2', skill: 'dig_at', args: { at: [1, 0, 0] } });
  fx.recollected('dirt', 32);
  assert.equal(seen.length, 1);
  assert.match(seen[0].msg, /toss_item「扔掉了 dirt×32」，又捡回来了 dirt×32：之后做过 dig_at，捡回来时正在 dig_at/);
  // 走到掉落物上（没在做动作）：说清楚是自动捡起
  bus.publish('task_end', 'P2', 'dig', { taskId: 't2', status: 'succeeded', skill: 'dig_at' });
  bus.publish('task_end', 'P2', 'toss', { taskId: 't3', status: 'succeeded', skill: 'toss_item', expect: { discarded: ['gravel'], what: '扔掉了 gravel×8' } });
  fx.recollected('gravel', 8);
  assert.match(seen[1].msg, /没在做动作.*自动捡起/);
  // 指名捡回来：改主意了，不算
  bus.publish('task_end', 'P2', 'toss', { taskId: 't4', status: 'succeeded', skill: 'toss_item', expect: { discarded: ['andesite'], what: '扔掉了 andesite×20' } });
  bus.publish('task_start', 'P2', 'pick', { taskId: 't5', skill: 'pickup_items', args: { item: 'andesite' } });
  fx.recollected('andesite', 20);
  assert.equal(seen.length, 2);
  // 心智会注意到
  const n = new Attention().fromEvent({ type: 'effect_broken', ts: Date.now(), severity: 'P2', msg: seen[0].msg, data: seen[0].data } as any);
  assert.match(n!.what, /刚做完的事又被打破了/);
});

test('toss_item：往哪扔由它自己选（toward），结果里声明扔掉的东西；扔给别人的不算扔掉', () => {
  const adapter = new FakeAdapter();
  assert.deepEqual((tossItem.validate({ item: 'dirt', toward: 'back' }, adapter) as any).args.toward, 'back');
  assert.deepEqual((tossItem.validate({ item: 'dirt', toward: [1, 64, 3] }, adapter) as any).args.toward, { x: 1, y: 64, z: 3 });
  assert.equal((tossItem.validate({ item: 'dirt', toward: 'ne' }, adapter) as any).args.toward, 'NE');
  assert.ok(!tossItem.validate({ item: 'dirt', toward: 'left' }, adapter).ok);
  assert.ok(!tossItem.validate({ item: 'dirt', toward: 'back', to: 'piglin' }, adapter).ok);
});
