import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

function harness(t: { after(fn: () => void): void }) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision), self = new SelfModel(null);
  const planner = new Planner(config, { name: 'gap-lifecycle', complete: async () => { throw new Error('unexpected model call'); } }, adapter, memory, bus, null);
  const mind = new Mind({ adapter, memory, bus, arbiter, perception, self, persona: '', thinker: new Thinker(planner, adapter, memory, bus, null) });
  t.after(() => { mind.stop(); memory.close(); self.close(); });
  const act = () => (Reflect.get(mind, 'act') as () => void).call(mind);
  return { adapter, mind, act };
}

test('参数被拒绝的步骤不能消费尚未处理的站位缺口', (t) => {
  const { adapter, mind, act } = harness(t);
  const activity = createActivity({ what: '移动后挖', why: '', kind: 'other', repeat: 1, steps: [
    { skill: 'dig_at', args: { at: [9, 0, 0] }, optional: true },  // 无效（超出范围）
    { skill: 'dig_at', args: { at: [0, 0, 1] } },  // 合法相对
  ] }, '', 'llm', adapter.state());
  mind.activity = activity;
  activity.stanceGap = { skill: 'step', pos: { x: 0.5, y: 64, z: 0.5 } };
  act();
  assert.ok(activity.stanceGap, '校验失败的 optional 步骤被跳过，不能清掉站位缺口');
});

test('合法相对挖掘在站位缺口下不能执行，返回依赖缺口', (t) => {
  const { adapter, mind, act } = harness(t);
  const activity = createActivity({ what: '移动后挖', why: '', kind: 'other', repeat: 1, steps: [
    { skill: 'dig_at', args: { at: [0, 0, 1] } },
  ] }, '', 'llm', adapter.state());
  mind.activity = activity;
  activity.stanceGap = { skill: 'step', pos: { x: 0.5, y: 64, z: 0.5 } };
  act();
  assert.equal(mind.activity, null, '相对挖掘应因站位缺口被中止');
});
