import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionChat } from '../src/observer/action-chat.ts';
import { EventBus } from '../src/events.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('replay captions report actual short actions and partial results, with rate limiting', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const captions: string[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const chat = new ActionChat(adapter, bus, { enabled: true, minIntervalMs: 1800 });
  chat.start(); t.after(() => chat.stop());
  bus.publish('task_start', 'P2', '[llm] gather', { skill: 'gather', args: { block: 'oak_log', count: 8 }, source: 'llm' });
  bus.publish('task_end', 'P2', '[llm] gather', { skill: 'gather', status: 'succeeded', summary: '采集了 4/8', source: 'llm' });
  assert.deepEqual(captions, ['[行动] 开始采集：oak_log ×8']);
  now += 1800; chat.flush();
  assert.equal(captions[1], '[行动] 结束：采集了 4/8');
  assert.ok(captions.every((text) => !text.includes('目标完成')));
  now += 1800;
  bus.publish('task_end', 'P1', '[llm] craft', { status: 'failed', summary: '缺少工作台', source: 'llm' });
  assert.equal(captions.at(-1), '[行动] 失败：缺少工作台');
});

test('filler, paused and disconnected captions cannot leak later; disabling stops all chat', (t) => {
  let now = 10000, allowed = true;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus(), captions: string[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const chat = new ActionChat(adapter, bus, { enabled: true, canSend: () => allowed });
  chat.start(); t.after(() => chat.stop());
  bus.publish('task_start', 'P3', '[filler] wander', { skill: 'wander', source: 'filler' });
  assert.equal(captions.length, 0);
  bus.publish('task_start', 'P2', '[llm] craft', { skill: 'craft', args: { item: 'wooden_pickaxe' }, source: 'llm' });
  bus.publish('task_start', 'P2', '[llm] gather', { skill: 'gather', source: 'llm' });
  allowed = false; bus.publish('paused', 'P1', 'pause'); now += 2000; chat.flush();
  allowed = true; now += 2000; chat.flush();
  assert.equal(captions.length, 1);
  adapter.connected = false;
  bus.publish('task_start', 'P2', '[llm] build', { skill: 'build', source: 'llm' });
  adapter.connected = true; now += 2000; chat.flush();
  assert.equal(captions.length, 1);
  chat.stop();
  const disabled = new ActionChat(adapter, bus, { enabled: false }); disabled.start();
  bus.publish('task_start', 'P2', '[llm] build', { skill: 'build', source: 'llm' });
  assert.equal(captions.length, 1); disabled.stop();
});
