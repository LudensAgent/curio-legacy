import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('llm_invalid 事件保留被拒的原始输出，便于定位参数写法', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const planner = new Planner(config, { name: 'invalid-capture', complete: async () => { throw new Error('unexpected'); } }, adapter, memory, bus, null);
  const events: AgentEvent[] = [];
  bus.on('event', (e: AgentEvent) => { if (e.type === 'llm_invalid') events.push(e); });

  planner.noteInvalid('test', 'bad args', '{"activity":{"steps":[{"skill":"move_step","args":{"xyz":[1,64,2]}}]}}');
  assert.equal(events.length, 1);
  assert.match(String(events[0].data?.output), /move_step/);

  planner.noteInvalid('test', 'no output');
  assert.equal(events[1].data, undefined, '不传输出时不伪造 data');
});
