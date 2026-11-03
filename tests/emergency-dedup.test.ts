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

test('未验证的应急候选不再按「处境 × 动作签名」自动去重，留给整理模型判断', (t) => {
  const w = setup(t);
  const combat = { ...definition, when: { hostile: { within: 8 } } };
  assert.ok(w.engine.write({ ...combat, name: 'shield-validated' }).ok);
  w.engine.recordInvocation('shield-validated', { status: 'succeeded', summary: '举盾后撤离开危险', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ ...combat, name: 'shield-dupe-a' }, { by: 'mind' }).ok);
  assert.ok(w.engine.write({ ...combat, name: 'shield-dupe-b' }, { by: 'mind' }).ok);
  w.observe();
  w.observe(day);
  // 不再有非模型的应急去重：未验证候选是否重复由整理模型按代码/证据判断，不因同属 combat、代码同源就自动收起。
  assert.equal(w.engine.candidateRetirement('shield-dupe-a'), undefined, '不自动收起未验证候选');
  assert.equal(w.engine.candidateRetirement('shield-dupe-b'), undefined);
  assert.equal(w.engine.inactive('shield-validated'), false, '已验证的应急版保持启用');
});
