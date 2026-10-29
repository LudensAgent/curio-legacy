import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

for (const tier of ['deliberate', 'glance'] as const) {
  for (const terrain of ['pit', 'underground', 'surface', 'unclassified', 'unknown-exits'] as const) {
    test(`${tier}: ${terrain} describes terrain without choosing a retreat or forbidding excavation`, (t) => {
      const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
      t.after(() => memory.close());
      adapter.pos = { x: 0.5, y: terrain === 'surface' ? 64 : 60, z: 0.5 };
      adapter.removed = new Set((terrain === 'pit' ? [60, 61, 62, 63] : [60, 61]).map((y) => `0,${y},0`));
      if (terrain === 'surface') adapter.blocks.push({ name: 'oak_leaves', pos: { x: 0, y: 67, z: 0 } });
      const perception = new Perception(adapter, memory, bus, new Vision(adapter));
      const percept = perception.update(), state = adapter.state(), self = new SelfModel(null);
      if (terrain === 'unclassified' || terrain === 'unknown-exits') {
        delete percept.self.where;
        if (terrain === 'unknown-exits') {
          delete percept.self.overhead;
          percept.light = null;
          percept.self.exits = Object.fromEntries(['N', 'E', 'S', 'W'].map((direction) => [direction, { walk: null, step_down: null, step_up: null }]));
        }
      } else assert.equal(percept.self.where?.kind, terrain);

      // No mining keywords are needed to preserve the Agent's chosen direction.
      const activity = createActivity({ what: '继续完成当前试验', why: '观察高度变化', kind: 'explore', repeat: 12,
        steps: [{ skill: 'dig', args: { dir: 'down', blocks: 1 } }], doneWhen: { type: 'position_y', max: 45 } }, '', 'llm', state);
      const failure = { skill: 'dig', args: { dir: 'down', blocks: 1 }, failure_code: 'BAD_ARGS',
        summary: '脚下再往下是 water，往下挖会掉下去', position: state.pos, observed_at: '2026-10-29T02:15:21.000Z' };
      const [system, user] = buildMindMessages({ tier, reason: '查看动作反馈', percept, state, self, memory, activity,
        recentActionFailures: [failure], suspended: [], lastRecord: null, noticed: [], changes: [],
        userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
      const section = (name: string) => JSON.parse(user.content.split('\n').find((line) => line.startsWith(`【${name}】`))!.slice(name.length + 2));

      assert.equal(section('手上的活').current_activity.what, activity.what);
      assert.deepEqual(section('身边').local, percept.self.local);
      assert.deepEqual(section('身边').exits, percept.self.exits);
      if (percept.self.where) assert.equal(section('身体').where, percept.self.where.text);
      assert.deepEqual(section('此刻').recent_action_failures.entries, [failure], '真实水患反馈仍然可见');
      assert.match(system.content, /按当前目标和实际反馈选择动作/);
      assert.doesNotMatch(system.content, /地表(?:就)?走路|坑里或地下[^\n]*才挖/);
      assert.doesNotMatch(user.content, /怎么上去自己定|一格一格自己出去|怎么出去自己定|直接走路，不用挖/);
    });
  }
}
