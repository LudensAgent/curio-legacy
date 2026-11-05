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
  code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' };

function setup(t: TestContext, options: Partial<CuratorOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-game-idle-'));
  const book = new SkillBook(null, directory), adapter = new FakeAdapter(), bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{"ok":true}', latencyMs: 0 }; } };
  const clockFile = path.join(directory, 'clock.json'), lifetimeFile = path.join(directory, 'lifetimes.json');
  // 这个文件专门验证“按观察到的有效游戏日收起的门槛”，把门槛钉死，不受 DEFAULT_CURATOR 将来放宽影响。
  const create = () => new SkillCurator(planner, engine, book, bus, { unusedDays: 7, candidateUnusedDays: 3, disabledDays: 1, ...options }, new ObservedGameClock(clockFile), lifetimeFile);
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

test('候选改写、跳过和取消不续命，晋升后的新候选获得独立观察期', async (t) => {
  // 晋升后的稳定版会在整段测试里持续闲置（超过 13 天）：把稳定版门槛放宽到足够大，让本测试聚焦候选的独立观察期
  const w = setup(t, { unusedDays: 60 });
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

  // 用非应急技能验证“晋升后新候选独立观察期”，避免 protectedEmergency 干扰闲置收起逻辑
  const rescue = { ...definition, name: 'renewed-rescue' };
  assert.ok(w.engine.write(rescue, { by: 'mind' }).ok);
  w.observe();
  w.observe(2 * day);
  for (let i = 0; i < 3; i++) w.engine.recordInvocation(rescue.name, { status: 'succeeded', summary: '实际验收危险已解除', data: { version: 1, verified: true } });
  await Promise.resolve(); // 晋级检查延后一个微任务，好让调用方先否决这次成功
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

test('已验证的稳定应急版仍免闲置和容量淘汰；未验证的应急候选照常参与', (t) => {
  const w = setup(t, { maxActive: 1 });
  const emergency = { ...definition, when: { hp_below: 8 } };
  assert.ok(w.engine.write(emergency).ok);
  w.engine.recordInvocation(definition.name, { status: 'succeeded', summary: '观察确认危险已解除', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ ...emergency, name: 'unproven-rescue' }, { by: 'mind' }).ok);
  w.observe();
  w.observe(3 * day);
  // 未验证的应急候选不再一刀切豁免：按候选闲置门槛收起（已验证的那份仍留着）
  assert.deepEqual(w.curator.retireUnused(), ['unproven-rescue'], '未验证的应急候选照常按闲置收起');
  assert.ok(w.engine.candidateRetirement('unproven-rescue'), '收起的是候选');
  assert.equal(w.engine.executionError(definition.name), null, '已验证的稳定应急版不被闲置收起');
  w.observe(5 * day);
  assert.deepEqual(w.curator.retireUnused(), []);
  w.curator.opts.maxActive = 0;
  assert.deepEqual(w.curator.retireLowValue(), []);
  assert.equal(w.engine.executionError(definition.name), null);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 });
});

test('主动维护技能没有失败证据时不按闲置收起，有失败证据的主动/恢复技能仍照常收', (t) => {
  const w = setup(t);
  const proactive = { ...definition, name: 'top-up-torches', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  const failedProactive = { ...definition, name: 'plant-surplus-saplings', description: '树苗多了就种到附近空地', when: { food_below: 7 } };
  const failedRecovery = { ...definition, name: 'retry-goto-after-path-failure', when: { after_failure: { skill: ['goto'], code: ['PATH_NOT_FOUND'] } } };
  for (const skill of [proactive, failedProactive, failedRecovery]) assert.ok(w.engine.write(skill).ok, skill.name);
  assert.equal(w.engine.get(proactive.name)?.mode, 'auto');
  assert.equal(w.engine.get(failedRecovery.name)?.mode, 'recover');
  w.observe();
  for (let i = 0; i < 3; i++) w.engine.recordInvocation(failedProactive.name, { status: 'failed', summary: '种下去没活', data: { version: 1 } });
  for (let i = 0; i < 2; i++) w.engine.recordInvocation(failedRecovery.name, { status: 'failed', summary: '重试后路仍不通', data: { version: 1 } });
  w.observe();
  w.observe(8 * day);
  const retired = w.curator.retireUnused();
  assert.deepEqual(new Set(retired), new Set([failedProactive.name, failedRecovery.name]));
  assert.ok(!retired.includes(proactive.name), '没触发过也没失败的主动维护技能免闲置收起');
  assert.equal(w.engine.statsOf(proactive.name)?.retired, undefined);
  assert.equal(w.engine.statsOf(failedProactive.name)?.retired !== undefined, true);
  assert.equal(w.engine.statsOf(failedRecovery.name)?.retired !== undefined, true);
});

test('主动维护技能触发过却只 skip、0 成 0 败时不算无负面证据', (t) => {
  const w = setup(t);
  const noop = { ...definition, name: 'plant-surplus-saplings', description: '树苗多了就种到附近空地', when: { food_below: 8 } };
  const clean = { ...definition, name: 'top-up-torches', description: '火把少了就补到箱子里', when: { food_below: 7 } };
  const worked = { ...definition, name: 'refill-torch-box', description: '火把少了就补满箱子', when: { food_below: 6 } };
  for (const skill of [noop, clean, worked]) assert.ok(w.engine.write(skill).ok, skill.name);
  w.observe();
  // 真实 no-op 路径：noteInvocation 记 uses/skipped，不记 ok/fail，也不刷新闲置活动。
  for (let i = 0; i < 5; i++) w.engine.recordInvocation(noop.name, { status: 'succeeded', summary: '当前不适用，未执行', data: { version: 1, noop: true } });
  w.engine.recordInvocation(worked.name, { status: 'succeeded', summary: '实际补满了火把箱', data: { version: 1, verified: true } });
  assert.deepEqual(w.engine.currentStats(noop.name), { ok: 0, fail: 0 });
  assert.equal(w.engine.statsOf(noop.name)?.uses, 5);
  assert.equal(w.engine.statsOf(noop.name)?.skipped, 5);
  w.observe();
  w.observe(8 * day);
  const retired = w.curator.retireUnused();
  assert.ok(retired.includes(noop.name), '触发过却一次没成的主动技能照常按闲置收起');
  assert.ok(!retired.includes(clean.name), '从未触发、也没有 skip 的主动技能仍受保护');
  assert.ok(!retired.includes(worked.name), '已有成功证据的主动技能仍受保护');
  assert.deepEqual(w.engine.currentStats(worked.name), { ok: 1, fail: 0 });
});

test('主动维护技能只触发后被取消不算负面证据，真实 no-op 和成功证据仍按原口径', (t) => {
  const w = setup(t);
  const cancelled = { ...definition, name: 'rare-torch-top-up', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  const noop = { ...definition, name: 'plant-surplus-saplings', description: '树苗多了就种到附近空地', when: { food_below: 7 } };
  const worked = { ...definition, name: 'refill-torch-box', description: '火把少了就补满箱子', when: { food_below: 6 } };
  for (const skill of [cancelled, noop, worked]) assert.ok(w.engine.write(skill).ok, skill.name);
  w.observe();
  w.engine.recordInvocation(cancelled.name, { status: 'cancelled', summary: '被更高优先级任务取消', data: { version: 1 } });
  w.engine.recordInvocation(noop.name, { status: 'succeeded', summary: '当前不适用，未执行', data: { version: 1, noop: true } });
  w.engine.recordInvocation(worked.name, { status: 'succeeded', summary: '实际补满了火把箱', data: { version: 1, verified: true } });
  const cancelledUsage = w.engine.statsOf(cancelled.name)?.usageByVersion?.['1'];
  assert.equal(cancelledUsage?.uses, 1);
  assert.equal(cancelledUsage?.cancelled, 1);
  assert.equal(cancelledUsage?.skipped, 0);
  w.observe();
  w.observe(8 * day);
  const retired = w.curator.retireUnused();
  assert.ok(!retired.includes(cancelled.name), '只触发后被取消不算“没有实际执行”');
  assert.ok(retired.includes(noop.name), '真实 no-op 仍取消保护');
  assert.ok(!retired.includes(worked.name), '已有成功证据的仍受保护');
});

test('重写成新版本后，主动维护技能从新版本重新判断', (t) => {
  const w = setup(t);
  const skill = { ...definition, name: 'rewritten-torch-top-up', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  assert.ok(w.engine.write(skill).ok);
  w.observe();
  for (let i = 0; i < 5; i++) w.engine.recordInvocation(skill.name, { status: 'succeeded', summary: '当前不适用，未执行', data: { version: 1, noop: true } });
  assert.ok(w.engine.write({ ...skill, code: 'return {revised:true};' }).ok);
  assert.equal(w.engine.get(skill.name)?.version, 2);
  w.observe();
  w.observe(8 * day);
  assert.deepEqual(w.curator.retireUnused(), [], '新版本还没触发过，不被旧版本的 skip 连坐');
  assert.equal(w.engine.statsOf(skill.name)?.retired, undefined);
});

test('没有按版本统计的老存档：fired/uses/skipped 也取消主动保护', (t) => {
  const w = setup(t);
  const firedOnly = { ...definition, name: 'legacy-fired-torch-top-up', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  const legacyUsage = { ...definition, name: 'legacy-used-torch-top-up', description: '火把少了就补满箱子', when: { food_below: 7 } };
  for (const skill of [firedOnly, legacyUsage]) assert.ok(w.engine.write(skill).ok, skill.name);
  const stats = (w.engine as any).stats;
  stats[firedOnly.name] = { fired: 5, ok: 0, fail: 0, lastAt: Date.now() - 11 * 60_000 };
  stats[legacyUsage.name] = { fired: 5, uses: 5, skipped: 5, ok: 0, fail: 0, lastAt: Date.now() };
  w.observe();
  w.observe(8 * day);
  assert.deepEqual(new Set(w.curator.retireUnused()), new Set([firedOnly.name, legacyUsage.name]));
});

test('老存档刚触发还没结果时，不把 fired 当成负面证据', (t) => {
  const w = setup(t);
  const skill = { ...definition, name: 'legacy-fresh-torch-top-up', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  assert.ok(w.engine.write(skill).ok);
  const stats = (w.engine as any).stats;
  stats[skill.name] = { fired: 1, ok: 0, fail: 0, lastAt: Date.now() };
  w.observe();
  w.observe(8 * day);
  assert.deepEqual(w.curator.retireUnused(), [], '触发宽限期内不能把执行中的技能收起');
  stats[skill.name].lastAt = Date.now() - 11 * 60_000;
  assert.deepEqual(w.curator.retireUnused(), [skill.name], '过了宽限期仍是 0 成 0 败才按负面证据收起');
});

test('老存档有 uses 时取消豁免优先，不再被 fired 覆盖', (t) => {
  const w = setup(t);
  const cancelled = { ...definition, name: 'legacy-cancelled-torch-top-up', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  const executed = { ...definition, name: 'legacy-executed-torch-top-up', description: '火把少了就补满箱子', when: { food_below: 7 } };
  for (const skill of [cancelled, executed]) assert.ok(w.engine.write(skill).ok, skill.name);
  const stats = (w.engine as any).stats;
  stats[cancelled.name] = { fired: 5, uses: 5, cancelled: 5, skipped: 0, ok: 0, fail: 0, lastAt: Date.now() - 11 * 60_000 };
  stats[executed.name] = { fired: 5, uses: 5, cancelled: 0, skipped: 0, ok: 0, fail: 0, lastAt: Date.now() - 11 * 60_000 };
  w.observe();
  w.observe(8 * day);
  assert.deepEqual(w.curator.retireUnused(), [executed.name], '有 uses 时只看未取消的实际执行，fired 不再覆盖取消豁免');
});

test('容量压力先收有失败证据的，从没用过的主动维护技能排在后面', (t) => {
  const w = setup(t, { maxActive: 1 });
  const proactive = { ...definition, name: 'top-up-torches', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  const failedManual = { ...definition, name: 'failed-manual-work' };
  assert.ok(w.engine.write(proactive).ok);
  assert.ok(w.engine.write(failedManual).ok);
  for (let i = 0; i < 2; i++) w.engine.recordInvocation(failedManual.name, { status: 'failed', summary: '没有完成委托', data: { version: 1 } });
  w.observe();
  w.observe(day);
  const out = w.curator.retireLowValue();
  assert.ok(out.includes(failedManual.name), '有失败证据的先收');
  assert.ok(!out.includes(proactive.name), '没证据的主动维护技能不先被容量挤掉');
  assert.equal(w.engine.statsOf(proactive.name)?.retired, undefined);
});

test('只剩没证据的主动维护技能时容量上限仍执行，已验证的稳定应急版不受影响', (t) => {
  const w = setup(t, { maxActive: 0 });
  const emergency = { ...definition, name: 'escape-lava', when: { hp_below: 8 } };
  const proactive = { ...definition, name: 'top-up-torches', description: '火把少了就补到箱子里', when: { food_below: 8 } };
  assert.ok(w.engine.write(emergency).ok);
  w.engine.recordInvocation(emergency.name, { status: 'succeeded', summary: '实际躲开危险', data: { version: 1, verified: true } });
  assert.ok(w.engine.write(proactive).ok);
  w.observe();
  w.observe(day);
  assert.deepEqual(w.curator.retireLowValue(), [proactive.name], '容量上限仍有界；应急版不占容量也不被收');
  assert.equal(w.engine.statsOf(emergency.name)?.retired, undefined);
});
