import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SkillCurator, type CuratorOptions } from '../src/codeskills/curator.ts';
import { ObservedGameClock } from '../src/codeskills/game-clock.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine, emergencyKind } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const day = 24_000;
const definition = { name: 'rescue', description: '按处境做应急动作并核对真实结果', body: '只执行指定动作，返回观测结果。',
  code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' };

function setup(t: TestContext, options: Partial<CuratorOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-emergency-dedup-'));
  const book = new SkillBook(null, directory), adapter = new FakeAdapter(), bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{"ok":true}', latencyMs: 0 }; } };
  const curator = new SkillCurator(planner, engine, book, bus, { ...options }, new ObservedGameClock(path.join(directory, 'clock.json')), path.join(directory, 'lifetimes.json'));
  curator.dim = () => adapter.dim;
  t.after(() => { curator.stop(); engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  let worldAgeTicks = 0;
  const observe = (ticks = 0) => {
    worldAgeTicks += ticks;
    curator.observe({ ...adapter.state(), worldAgeTicks }, false);
  };
  return { engine, curator, observe };
}

test('emergencyKind 按威胁谓词 key 粗分，只看键不看阈值', () => {
  assert.equal(emergencyKind({ when: { hostile: { within: 8 } } }), 'combat');
  assert.equal(emergencyKind({ when: { hurt_within: 3 } }), 'combat');
  assert.equal(emergencyKind({ when: { hp_below: 8 } }), 'combat');
  assert.equal(emergencyKind({ when: { in_lava: true } }), 'lava');
  assert.equal(emergencyKind({ when: { oxygen_below: 10 } }), 'drown');
  assert.equal(emergencyKind({ when: { in_wall: true } }), 'suffocate');
  // 嵌套 any 也按优先级取最危险的 key
  assert.equal(emergencyKind({ when: { any: [{ in_lava: true }, { hostile: { within: 5 } }] } }), 'lava');
  // 覆盖不同本能算不同簇
  assert.equal(emergencyKind({ overrides: ['dodge_creeper'] }), 'override:dodge_creeper');
  assert.equal(emergencyKind({ overrides: ['surface', 'dodge_creeper'] }), 'override:dodge_creeper+surface');
});

test('应急去重：同一处境留已验证的，未验证的重复候选收起', (t) => {
  const w = setup(t);
  const combat = { ...definition, when: { hostile: { within: 8 } } };
  assert.ok(w.engine.write({ ...combat, name: 'shield-validated' }).ok);
  w.engine.recordInvocation('shield-validated', { status: 'succeeded', summary: '举盾后撤离开危险', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ ...combat, name: 'shield-dupe-a' }, { by: 'mind' }).ok);
  assert.ok(w.engine.write({ ...combat, name: 'shield-dupe-b' }, { by: 'mind' }).ok);
  w.observe();
  w.observe(day);
  assert.deepEqual(new Set(w.curator.retireRedundantEmergency()), new Set(['shield-dupe-a', 'shield-dupe-b']));
  assert.equal(w.engine.executionError('shield-validated'), null, '已验证的应急代表保留');
  assert.ok(w.engine.candidateRetirement('shield-dupe-a'), '收起的是候选，完整契约留在历史');
  assert.ok(w.engine.candidateRetirement('shield-dupe-b'));
});

test('应急去重：一簇全未验证时留一个最新候选当种子，其余收起', (t) => {
  const w = setup(t);
  const drown = { ...definition, when: { oxygen_below: 10 } };
  for (const name of ['swim-a', 'swim-b', 'swim-c']) assert.ok(w.engine.write({ ...drown, name }, { by: 'mind' }).ok);
  w.observe();
  w.observe(day);
  assert.equal(w.curator.retireRedundantEmergency().length, 2, '收起两份，留一份种子');
  const live = w.engine.list(true).filter((b) => b.source === 'self' && !w.engine.candidateRetirement(b.name)).map((b) => b.name);
  assert.equal(live.length, 1, '这一处境仍有一份候选兜底');
  assert.ok(['swim-a', 'swim-b', 'swim-c'].includes(live[0]));
});

test('应急去重：唯一代表不在这步收起，不同处境互不合并', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, name: 'only-combat', when: { hostile: { within: 8 } } }, { by: 'mind' }).ok);
  assert.ok(w.engine.write({ ...definition, name: 'only-drown', when: { oxygen_below: 10 } }, { by: 'mind' }).ok);
  w.observe();
  w.observe(day);
  assert.deepEqual(w.curator.retireRedundantEmergency(), [], '两个不同处境的唯一代表都不收');
  assert.equal(w.engine.candidateRetirement('only-combat'), undefined);
  assert.equal(w.engine.candidateRetirement('only-drown'), undefined);
});
