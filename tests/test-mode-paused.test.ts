import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

function fixture(t: TestContext) {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const bus = new EventBus();
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const planner = new Planner(
    { ...config, llm: { ...config.llm, provider: 'mock' as 'mock' } },
    { name: 'mock', complete: () => new Promise<never>(() => {}) },
    adapter, memory, bus, null);
  const self = new SelfModel(null, ['好奇']);
  const mind = new Mind({
    adapter, arbiter, perception, memory, bus, self, persona: '你叫 Curio。',
    thinker: new Thinker(planner, adapter, memory, bus, null),
  });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); });
  return { adapter, arbiter, mind };
}

test('test 默认暂停：心智 tick 不发起自动任务，恢复后回到可执行状态', async (t) => {
  const w = fixture(t);
  // main.ts 在 test 模式启动时执行 executive.pause()，这里等价复现该契约。
  w.mind.pause();
  assert.equal(w.arbiter.paused, true);
  for (let i = 0; i < 5; i++) { w.mind.tick(); await flush(); }
  assert.equal(w.arbiter.info(), null, '暂停期间不应出现 glance/explore 等自动任务');
  assert.deepEqual(w.arbiter.start({ skill: 'glance', args: { seconds: 1 } }, 'filler'), { error: 'Agent 已暂停' });
  w.mind.resume();
  assert.equal(w.arbiter.paused, false);
});
