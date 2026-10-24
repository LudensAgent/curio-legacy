import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionChat } from '../src/observer/action-chat.ts';
import { EventBus } from '../src/events.ts';
import type { ExpressionContext } from '../src/observer/expression.ts';

test('chat sends only a current started action; cancelled rate-limited thoughts cannot leak and disabled chat keeps the caption projection', (t) => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const captions: string[] = [], bus = new EventBus();
  const context: ExpressionContext = { state: { connected: true, alive: true, observationReady: true, worldId: 'world', sessionId: 'session', dim: 'overworld' },
    intent: { id: 'intent', text: '比较眼前的材料' }, plan: null, task: null };
  const adapter = { state: () => context.state as any, chat: (text: string) => { captions.push(text); } };
  const chat = new ActionChat(adapter, bus, { enabled: true, minIntervalMs: 1800, context: () => context });
  chat.start(); t.after(() => chat.stop());
  const plan = (id: string, thought: string) => {
    context.plan = { id, goal: '一次小尝试', binding: { intentId: 'intent' } };
    bus.publish('plan', 'P2', '', { planId: id, source: 'llm', thought, steps: [{ skill: id }] });
  };
  const begin = (id: string) => {
    context.task = { id: `task-${id}`, planId: id, source: 'llm' };
    bus.publish('task_start', 'P2', '', { taskId: context.task.id, source: 'llm' });
  };
  plan('one', '§a我想看看这块石头。\n'); assert.equal(captions.length, 0);
  begin('one'); assert.deepEqual(captions, ['[想法] 我想看看这块石头。']);
  plan('two', '试一下另一侧。'); begin('two');
  context.task = null;
  bus.publish('task_end', 'P2', '', { taskId: 'task-two', status: 'cancelled' });
  now += 2000; chat.flush();
  assert.equal(captions.length, 1, 'a cancelled pending thought is discarded, never delayed into the next action');
  assert.equal(chat.snapshot().thought, '');
  chat.stop();

  const silent = new ActionChat(adapter, bus, { enabled: false, context: () => context });
  silent.start(); t.after(() => silent.stop());
  plan('three', '这里的纹理确实不同。'); begin('three');
  assert.equal(captions.length, 1);
  assert.equal(silent.snapshot().thought, '这里的纹理确实不同。');
  context.state.sessionId = 'new-session'; silent.flush();
  assert.equal(silent.snapshot().thought, '', 'the mod and OBS must also discard the old session');
});
