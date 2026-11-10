import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { CodeImprover } from '../src/codeskills/improver.ts';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Mind } from '../src/mind/mind.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const definition = { name: 'measured-emergency', description: '血少时按明确选择的方向移动并核对结果', body: '观察当前血量和位置，只按指定方向试验；完成后核对身体位置变化。',
  when: { hp_below: 8 }, args: { direction: '可选，默认向前' }, priority: 63, cooldown_s: 17,
  code: 'await api.move({forward:true},50); return {moved:true};', verify: 'return (await api.state()).pos.x !== args.before.pos.x;' };
const notes = '已观察到的成功只属于当时的条件；遇到新环境时保留这些观察，再确认这份做法是否仍有效。';

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-emergency-history-'));
  const book = new SkillBook(null, directory), adapter = new FakeAdapter(), bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write(definition).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation(definition.name, { status: 'succeeded', summary: '在当时的处境中实际离开危险位置', data: { version: 1, verified: true } });
  assert.ok(book.write(definition.name, definition.description, notes).ok);
  return { directory, book, adapter, bus, engine };
}

test('成功应急稳定版不被失败候选覆盖，收起候选后仍可发现完整成功版本', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 5 }, code: 'return {changed:false};' }, { by: 'forge' }).ok);
  for (let i = 0; i < 6; i++) w.engine.recordInvocation(definition.name, { status: 'failed', summary: '新候选没有达到委托目标', data: { version: 2 } });
  assert.ok(w.engine.retireCandidate(definition.name, 2, '六次试用未成功'));
  w.book.reload();
  assert.equal(w.engine.get(definition.name)?.version, 1);
  assert.equal(w.engine.get(definition.name)?.code, definition.code);
  assert.equal(w.engine.get(definition.name)?.notes, notes);
  assert.equal(w.engine.executionError(definition.name), null);
  assert.match(w.engine.executionError(definition.name, true)!, /已收起/);
  assert.deepEqual(w.engine.successfulEmergencyVersions(definition.name), [{ version: 1, ok: 3, fail: 0, location: 'stable' }]);
  assert.match(w.engine.overview().join('\n'), /保留成功过的应急版本 v1（成3\/败0）/);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 3, fail: 0 });
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 0, fail: 6 });
  delete w.engine.statsOf(definition.name)!.byVersion;
  assert.deepEqual(w.engine.successfulEmergencyVersions(definition.name), [], '只有名字累计成功的旧记录不能归到某个版本');
  assert.doesNotMatch(w.engine.overview().join('\n'), /保留成功过的应急版本/);
});

test('心智可将已收起的成功历史选为新候选，完整契约和笔记保留但旧证据不授予新版', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 4 }, priority: 22, code: 'return {newer:true};' }).ok);
  assert.ok(w.engine.retire(definition.name, '新版不再适用'));
  const before = structuredClone(w.engine.statsOf(definition.name)?.byVersion);
  const mind = Object.create(Mind.prototype) as Mind;
  Object.defineProperty(mind, 'd', { value: { behaviors: w.engine, self: { think() {} }, bus: w.bus } });
  const decision = { skill: { name: definition.name, from_version: 1 }, notes: [] };
  Reflect.apply(Mind.prototype['applySkill'], mind, [decision]);
  assert.deepEqual(decision.notes, []);
  w.book.reload();
  const candidate = w.engine.get(definition.name, true)!;
  assert.equal(candidate.version, 3);
  assert.equal(candidate.code, definition.code);
  assert.equal(candidate.verify, definition.verify);
  assert.deepEqual(candidate.when, definition.when);
  assert.deepEqual(candidate.needs, definition.args);
  assert.equal(candidate.priority, definition.priority);
  assert.equal(candidate.cooldownMs, definition.cooldown_s * 1000);
  assert.equal(candidate.body, definition.body);
  assert.equal(candidate.notes, notes);
  assert.equal(w.engine.get(definition.name)?.version, 2, '历史选择不覆盖当前稳定版');
  assert.equal(w.engine.statsOf(definition.name)?.retired, '新版不再适用');
  assert.equal(useSkill.validate({ name: definition.name }, w.adapter).ok, false);
  assert.equal(useSkill.validate({ name: definition.name, trial: true }, w.adapter).ok, true);
  assert.equal(w.engine.enabled(candidate), false);
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 0, fail: 0 });
  assert.deepEqual(w.engine.statsOf(definition.name)?.byVersion, before);
  assert.equal(w.bus.recent().some((event) => event.type === 'skill_promoted'), false);
  assert.deepEqual(w.engine.successfulEmergencyVersions(definition.name), [{ version: 1, ok: 3, fail: 0, location: 'history' }]);

  const thinker = Object.create(Thinker.prototype) as Thinker;
  Object.defineProperties(thinker, {
    book: { value: w.book }, bus: { value: w.bus }, skillStats: { value: (name: string) => w.engine.statsOf(name) },
    successfulEmergencyVersions: { value: (name: string) => w.engine.successfulEmergencyVersions(name) },
  });
  const catalog = JSON.parse(await Reflect.apply(Thinker.prototype['query'], thinker, ['skill', { query: definition.name }]));
  assert.deepEqual(catalog.entries[0].successfulEmergencyVersions, [{ version: 1, ok: 3, fail: 0, location: 'history' }]);
  const read = await Reflect.apply(Thinker.prototype['query'], thinker, ['skill', { name: definition.name, version: 1 }]);
  assert.match(read, /from_version/);
  assert.match(read, /不会直接启用/);
  assert.match(read, /成|"ok":3/);
  assert.equal(w.engine.get(definition.name, true)?.version, 3, '查询不会另写候选或启用');
  assert.deepEqual(w.adapter.actions, []);
});

test('仅代码的历史不能重试，历史选择只接受心智明确指定的有效版本', (t) => {
  const w = setup(t), versions = path.join(w.directory, definition.name, 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.writeFileSync(path.join(versions, 'v9.js'), 'return {old:true};');
  w.engine.statsOf(definition.name)!.byVersion!['9'] = { ok: 2, fail: 0 };
  const missing = w.engine.write({ name: definition.name, from_version: 9 }, { by: 'mind' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /缺少.*完整契约/);
  for (const by of ['forge', 'curator', 'improve', undefined] as const) {
    const denied = w.engine.write({ name: definition.name, from_version: 1 }, { by });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.error, /需要心智明确选择/);
  }
  for (const from_version of [0, -1, 1.5, '1']) assert.equal(w.engine.write({ name: definition.name, from_version }, { by: 'mind' }).ok, false);
  assert.deepEqual(w.engine.successfulEmergencyVersions(definition.name), [{ version: 1, ok: 3, fail: 0, location: 'stable' }]);
  assert.equal(w.engine.get(definition.name, true), undefined);
  assert.equal(w.engine.get(definition.name)?.version, 1);
});

test('整理稳定版可保留未收起候选的显式试用，普通收起和停用仍封闭旧入口', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 5 } }, { by: 'forge' }).ok);
  assert.ok(w.engine.retire(definition.name, '稳定版目前失败过多', { preserveCandidate: true }));
  assert.equal(w.engine.executionError(definition.name, true), null);
  assert.match(w.engine.executionError(definition.name)!, /已停用或收起/);
  assert.equal(w.engine.statsOf(definition.name)?.candidatePermit, 2);
  assert.equal(w.engine.enabled(w.engine.get(definition.name, true)!), false);
  assert.ok(w.engine.retireCandidate(definition.name, 2, '候选也不适用'));
  assert.ok(w.engine.retire(definition.name, '再次整理稳定版', { preserveCandidate: true }));
  assert.equal(w.engine.statsOf(definition.name)?.candidatePermit, undefined);
  assert.match(w.engine.executionError(definition.name, true)!, /候选 v2 已收起/);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  assert.ok(w.engine.retire(definition.name, '明确收起整份技能'));
  assert.match(w.engine.executionError(definition.name, true)!, /已停用或收起/);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  assert.ok(w.engine.write({ name: definition.name, disable: true }, { by: 'mind' }).ok);
  assert.match(w.engine.executionError(definition.name, true)!, /已停用或收起/);
});

test('稳定版收起后候选的程序错误可后台修订并延续许可，其他后台和过期结果仍被拒绝', { timeout: 5000 }, async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 5 } }, { by: 'forge' }).ok);
  assert.ok(w.engine.retire(definition.name, '稳定版已不适用', { preserveCandidate: true }));
  for (let i = 0; i < 2; i++) w.engine.recordInvocation(definition.name, { status: 'failed', summary: 'TypeError: 当前候选读取状态失败', data: { version: 2 } });
  for (const by of ['forge', 'curator'] as const) assert.equal(w.engine.write(definition, { by }).ok, false);
  const expectedToken = w.engine.editToken(definition.name);
  let calls = 0;
  const revised = { ...definition, when: { hp_below: 7 }, code: 'return {checked:true};' };
  const planner = { autonomous: true, noteInvalid(error: string) { assert.fail(error); }, async complete() {
    calls++;
    return { text: JSON.stringify({ skill: revised, change: '按本候选的失败证据修订' }), latencyMs: 1 };
  } };
  const improver = new CodeImprover(planner, w.engine, w.bus, { maxRounds: 0, perSkillGapMs: 0 });
  const finished = new Promise<AgentEvent>((resolve) => {
    const onEvent = (event: AgentEvent) => {
      if (!['skill_improved', 'skill_improve_failed', 'skill_improve_skipped'].includes(event.type)) return;
      w.bus.off('event', onEvent);
      resolve(event);
    };
    w.bus.on('event', onEvent);
    t.after(() => w.bus.off('event', onEvent));
  });
  assert.equal(improver.consider(definition.name, 'failures'), null);
  const event = await finished;
  await setImmediate();
  assert.equal(event.type, 'skill_improved', event.msg);
  assert.equal(improver.busy, null);
  assert.equal(calls, 1);
  assert.equal(w.engine.get(definition.name, true)?.version, 3);
  assert.equal(w.engine.get(definition.name, true)?.code, revised.code);
  assert.equal(w.engine.get(definition.name, true)?.notes, notes);
  assert.equal(w.engine.statsOf(definition.name)?.candidatePermit, 3);
  assert.equal(w.engine.executionError(definition.name, true), null);
  assert.equal(w.engine.get(definition.name)?.version, 1);
  assert.equal(w.engine.statsOf(definition.name)?.retired, '稳定版已不适用');
  assert.match(w.engine.executionError(definition.name)!, /已停用或收起/);
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 0, fail: 0 });
  assert.deepEqual(w.engine.statsOf(definition.name)?.byVersion?.['2'], { ok: 0, fail: 2 });
  const stale = w.engine.write(revised, { by: 'improve', expectedToken });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /过期结果/);
  for (const by of ['forge', 'curator'] as const) assert.equal(w.engine.write(definition, { by }).ok, false);
  assert.ok(w.engine.retireCandidate(definition.name, 3, '这份候选也已不适用'));
  assert.ok(improver.consider(definition.name, 'requested'));
  assert.equal(w.engine.write(revised, { by: 'improve' }).ok, false);
  assert.equal(calls, 1, '候选收起后不会再请求模型');
  assert.equal(w.engine.get(definition.name, true)?.version, 3);
});
