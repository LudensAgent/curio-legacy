import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionChat } from '../src/observer/action-chat.ts';
import { EventBus } from '../src/events.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('chat broadcasts activated thoughts with rate limiting, without action narration', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const captions: string[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const chat = new ActionChat(adapter, bus, { enabled: true, minIntervalMs: 1800 });
  chat.start(); t.after(() => chat.stop());
  bus.publish('plan', 'P2', '[llm] 观察树冠 —— 我有点好奇树冠的形状。', { thought: '我有点好奇树冠的形状。', source: 'llm' });
  bus.publish('task_start', 'P2', '[llm] gather', { skill: 'gather', args: { block: 'oak_log', count: 8 }, source: 'llm' });
  bus.publish('task_end', 'P2', '[llm] gather', { skill: 'gather', status: 'succeeded', summary: '采集了 4/8', source: 'llm' });
  bus.publish('plan', 'P2', '[llm] 比较石材', { thought: '这些石头的纹理让我想起了河边。', source: 'llm' });
  assert.deepEqual(captions, ['[想法] 我有点好奇树冠的形状。']);
  now += 1800; chat.flush();
  assert.equal(captions[1], '[想法] 这些石头的纹理让我想起了河边。');
  now += 1800;
  bus.publish('task_end', 'P1', '[llm] craft', { status: 'failed', summary: '缺少工作台', source: 'llm' });
  assert.equal(captions.length, 2, 'failed tasks must not generate an automatic chat message');
});

test('filler, paused and disconnected captions cannot leak later; disabling stops all chat', (t) => {
  let now = 10000, allowed = true;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus(), captions: string[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const chat = new ActionChat(adapter, bus, { enabled: true, canSend: () => allowed });
  chat.start(); t.after(() => chat.stop());
  bus.publish('plan', 'P3', '[filler] wander', { thought: '填充行为', source: 'filler' });
  bus.publish('plan', 'P2', '[rule] gather', { thought: '先采木头，再做工作台。', source: 'rule' });
  assert.equal(captions.length, 0);
  bus.publish('plan', 'P2', '[llm] craft', { thought: '我喜欢木头的质感。', source: 'llm' });
  bus.publish('plan', 'P2', '[llm] gather', { thought: '这片树林真安静。', source: 'llm' });
  allowed = false; bus.publish('paused', 'P1', 'pause'); now += 2000; chat.flush();
  allowed = true; now += 2000; chat.flush();
  assert.equal(captions.length, 1);
  adapter.connected = false;
  bus.publish('plan', 'P2', '[llm] build', { thought: '这个地方让我安心。', source: 'llm' });
  adapter.connected = true; now += 2000; chat.flush();
  assert.equal(captions.length, 1);
  chat.stop();
  const disabled = new ActionChat(adapter, bus, { enabled: false }); disabled.start();
  bus.publish('plan', 'P2', '[llm] build', { thought: '这个地方让我安心。', source: 'llm' });
  assert.equal(captions.length, 1); disabled.stop();
});

test('only a nonempty structured thought is shown, with formatting removed and bounded length', (t) => {
  const adapter = new FakeAdapter(), bus = new EventBus(), captions: string[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const chat = new ActionChat(adapter, bus, { enabled: true });
  chat.start(); t.after(() => chat.stop());
  for (const thought of [undefined, null, 123, '', ' \n\t§a ']) {
    bus.publish('plan', 'P2', '[llm] 不要从这里提取行动计划 —— 也不要提取这段', {
      thought, source: 'llm', goal: '采集木头', steps: [{ skill: 'gather' }],
    });
  }
  bus.publish('goal', 'P2', '当前尝试：采集木头', { thought: '错误事件也不能播报' });
  assert.equal(captions.length, 0);
  bus.publish('plan', 'P2', '[llm] 不展示的目标', { thought: `§a我有点好奇。\n\t${'这片树林真安静。'.repeat(30)}`, source: 'llm' });
  assert.equal(captions.length, 1);
  assert.ok(captions[0].startsWith('[想法] 我有点好奇。 '));
  assert.equal(captions[0].length, 180);
  assert.doesNotMatch(captions[0], /§|[\r\n\t]|不展示的目标/);
});

test('repeated and stale thoughts are suppressed and interruptions clear pending thoughts', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus(), captions: string[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const chat = new ActionChat(adapter, bus, { enabled: true });
  chat.start(); t.after(() => chat.stop());
  const thought = (text: string) => bus.publish('plan', 'P2', 'not displayed', { thought: text, source: 'llm' });
  thought('我很喜欢这里。'); thought('我很喜欢这里。');
  thought('这阵风有点冷。'); thought('这阵风有点冷。');
  now += 1800; chat.flush();
  now += 1800; chat.flush();
  assert.deepEqual(captions, ['[想法] 我很喜欢这里。', '[想法] 这阵风有点冷。']);
  thought('让我想一想。'); thought('已经过时的想法。');
  now += 10001; chat.flush();
  assert.equal(captions.at(-1), '[想法] 让我想一想。');
  for (const type of ['death', 'disconnected']) {
    thought(`当前想法 ${type}`); thought(`待发想法 ${type}`);
    bus.publish(type, 'P1', type);
    now += 2000; chat.flush();
    assert.equal(captions.at(-1), `[想法] 当前想法 ${type}`);
  }
});
