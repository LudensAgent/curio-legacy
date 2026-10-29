import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SkillCurator, type CuratorOptions } from '../src/codeskills/curator.ts';
import { ObservedGameClock } from '../src/codeskills/game-clock.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const day = 24_000;
const definition = { name: 'observed-work', description: '按委托完成动作并核对真实结果', body: '只执行指定动作，返回观测结果，不把尚未验证的推断当作成功。',
  code: 'return {worked:true};', verify: 'return true;' };

function setup(t: TestContext, options: Partial<CuratorOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-game-idle-'));
  const book = new SkillBook(null, directory), adapter = new FakeAdapter(), bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{"ok":true}', latencyMs: 0 }; } };
  const clockFile = path.join(directory, 'clock.json'), lifetimeFile = path.join(directory, 'lifetimes.json');
  const create = () => new SkillCurator(planner, engine, book, bus, options, new ObservedGameClock(clockFile), lifetimeFile);
  let curator = create(), now = Date.now(), worldAgeTicks = 0;
  curator.dim = () => adapter.dim;
  t.after(() => { curator.stop(); engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const observe = (ticks = 0, paused = false) => {
    now += 1000;
    worldAgeTicks += ticks;
    curator.observe({ ...adapter.state(), worldAgeTicks }, paused, now);
  };
  return { book, adapter, bus, engine, observe, get curator() { return curator; }, restart() {
    curator.stop();
    curator = create();
    curator.dim = () => adapter.dim;
  } };
}

test('稳定版七日和候选三日分别计时，同名两侧的实际使用互不刷新', (t) => {
  const w = setup(t);
  for (const name of ['stable-used', 'candidate-used']) {
    assert.ok(w.engine.write({ ...definition, name }).ok);
    assert.ok(w.engine.write({ ...definition, name }, { by: 'mind' }).ok);
  }
  assert.deepEqual(w.curator.retireUnused(Date.now() + 100 * 86_400_000), [], '没有在线游戏观察时不从墙钟推算旧技能年龄');
  w.observe();
  w.observe(2 * day);
  w.engine.recordInvocation('stable-used', { status: 'succeeded', summary: '稳定版完成了指定动作', data: { version: 1, verified: true } });
  w.engine.recordInvocation('candidate-used', { status: 'succeeded', summary: '候选实际验收成功一次', data: { version: 2, verified: true } });
  w.observe();
  w.observe(day);
  assert.deepEqual(w.curator.retireUnused(), ['stable-used']);
  assert.equal(w.engine.candidateRetirement('stable-used')?.version, 2);
  assert.equal(w.engine.executionError('stable-used'), null);
  w.observe(day);
  w.engine.recordInvocation('candidate-used', { status: 'failed', summary: '候选实际执行未达目标', data: { version: 2 } });
  w.observe();
  w.observe(2 * day);
  w.engine.recordInvocation('candidate-used', { status: 'succeeded', summary: '候选第二次实际验收成功', data: { version: 2, verified: true } });
  w.observe();
  w.observe(day - 1);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.observe(1);
  assert.deepEqual(w.curator.retireUnused(), ['candidate-used'], '候选的使用不能让七日未用的稳定版续命');
  assert.match(w.engine.executionError('candidate-used')!, /停用或收起/);
  assert.equal(w.engine.executionError('candidate-used', true), null, '收起稳定版仍允许正在验证的新候选');
  assert.deepEqual(w.engine.currentStats('candidate-used', true), { ok: 2, fail: 1 });
});

test('候选改写、跳过和取消不续命，晋升后的新候选获得独立观察期', (t) => {
  const w = setup(t);
  for (const name of ['rewritten-candidate', 'skipped-candidate', 'cancelled-candidate']) {
    assert.ok(w.engine.write({ ...definition, name }, { by: 'mind' }).ok);
  }
  w.observe();
  w.observe(2 * day);
  assert.ok(w.engine.write({ ...definition, name: 'rewritten-candidate', code: 'return {changed:true};' }, { by: 'mind' }).ok);
  w.engine.recordInvocation('skipped-candidate', { status: 'succeeded', summary: '当前不适用，未执行', data: { version: 1, noop: true } });
  w.engine.recordInvocation('cancelled-candidate', { status: 'cancelled', summary: '未完成前取消', data: { version: 1 } });
  w.observe();
  w.observe(day - 1);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.observe(1);
  assert.deepEqual(new Set(w.curator.retireUnused()), new Set(['rewritten-candidate', 'skipped-candidate', 'cancelled-candidate']));
  assert.equal(w.engine.candidateRetirement('rewritten-candidate')?.version, 2);
  assert.ok(w.book.definitionVersion('rewritten-candidate', 1), '改写前的完整契约仍保留');
  assert.deepEqual(w.engine.currentStats('skipped-candidate', true), { ok: 0, fail: 0 });
  assert.deepEqual(w.engine.currentStats('cancelled-candidate', true), { ok: 0, fail: 0 });

  const rescue = { ...definition, name: 'renewed-rescue', when: { hp_below: 8 } };
  assert.ok(w.engine.write(rescue, { by: 'mind' }).ok);
  w.observe();
  w.observe(2 * day);
  for (let i = 0; i < 3; i++) w.engine.recordInvocation(rescue.name, { status: 'succeeded', summary: '实际验收危险已解除', data: { version: 1, verified: true } });
  assert.equal(w.engine.get(rescue.name)?.candidate, undefined);
  w.observe();
  w.observe(5 * day);
  assert.ok(w.engine.write(rescue, { by: 'mind' }).ok);
  w.observe();
  w.observe(3 * day - 1);
  assert.deepEqual(w.curator.retireUnused(), [], '晋升后候选缺席的时间不计入后来新候选');
  w.observe(1);
  assert.deepEqual(w.curator.retireUnused(), [rescue.name]);
  assert.equal(w.engine.candidateRetirement(rescue.name)?.version, 2);
  assert.equal(w.engine.executionError(rescue.name), null);

  const reopened = 'reopened-candidate';
  assert.ok(w.engine.write({ ...definition, name: reopened }, { by: 'mind' }).ok);
  w.observe();
  w.observe(2 * day);
  assert.ok(w.engine.write({ name: reopened, disable: true }, { by: 'mind' }).ok);
  assert.ok(w.engine.write({ name: reopened, from_version: 1 }, { by: 'mind' }).ok);
  w.observe();
  w.observe(3 * day - 1);
  assert.deepEqual(w.curator.retireUnused(), [], '名称停用后显式选择历史版本再试，不继承已封闭候选的闲置时间');
  w.observe(1);
  assert.deepEqual(w.curator.retireUnused(), [reopened]);
  assert.equal(w.engine.candidateRetirement(reopened)?.version, 2);
});

test('暂停断线期间不累计，重启保留已观察闲置但不补计离线游戏日', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  w.observe();
  w.observe(2 * day);
  w.observe(100 * day, true);
  w.observe(100 * day);
  w.adapter.connected = false;
  w.observe(100 * day);
  w.adapter.connected = true;
  w.observe(100 * day);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.restart();
  w.observe(100 * day);
  assert.deepEqual(w.curator.retireUnused(), [], '重启后的首次观察只建立基线');
  w.observe(day - 1);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.observe(1);
  assert.deepEqual(w.curator.retireUnused(), [definition.name], '累计满三日时收起，重启不赠送新窗口');
  assert.match(w.engine.candidateRetirement(definition.name)!.why, /3 个有效游戏日/);
});

test('停用应急稳定版一天后收起，保留成功证据和同名新候选试用', (t) => {
  const w = setup(t);
  const emergency = { ...definition, when: { hp_below: 8 } };
  assert.ok(w.engine.write(emergency).ok);
  w.engine.recordInvocation(definition.name, { status: 'succeeded', summary: '这版实际解除过危险', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ name: definition.name, disable: true }, { by: 'mind' }).ok);
  assert.ok(w.engine.write(emergency, { by: 'mind' }).ok);
  w.observe();
  w.observe(day - 1);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.observe(1);
  assert.deepEqual(w.curator.retireUnused(), [definition.name]);
  assert.match(w.engine.statsOf(definition.name)!.retired!, /已停用.*1 个有效游戏日/);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 });
  assert.equal(w.book.get(definition.name)?.behavior !== undefined, true);
  assert.equal(w.book.candidate(definition.name)?.behavior !== undefined, true);
  assert.equal(w.engine.executionError(definition.name, true), null);
});

test('成功且可用的稳定应急版免闲置和容量淘汰，未成功应急候选三日可收', (t) => {
  const w = setup(t, { maxActive: 1 });
  const emergency = { ...definition, when: { hp_below: 8 } };
  assert.ok(w.engine.write(emergency).ok);
  w.engine.recordInvocation(definition.name, { status: 'succeeded', summary: '观察确认危险已解除', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ ...emergency, name: 'unproven-rescue' }, { by: 'mind' }).ok);
  w.observe();
  w.observe(3 * day);
  assert.deepEqual(w.curator.retireUnused(), ['unproven-rescue']);
  w.observe(5 * day);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.curator.opts.maxActive = 0;
  assert.deepEqual(w.curator.retireLowValue(), []);
  assert.equal(w.engine.executionError(definition.name), null);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 });
});
