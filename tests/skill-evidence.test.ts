import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine, normalizeSkillStates, nextSkillVersion, type BehaviorStats } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const definition = { name: 'observed-move', description: '按委托向前移动一小步', code: 'await api.move({forward:true},50); return {moved:true};',
  verify: 'const s = await api.state(); return Math.hypot(s.pos.x-args.before.pos.x,s.pos.z-args.before.pos.z)>0.01 ? true : "没有移动";' };

/** usageByVersion 里的 lastUsedAt 是时间戳，断言只比计数。 */
const usageCounts = (v: BehaviorStats['usageByVersion']) =>
  v && Object.fromEntries(Object.entries(v).map(([k, e]) => [k, { uses: e.uses, skipped: e.skipped, cancelled: e.cancelled }]));

function setup(t: TestContext, initialize?: (book: SkillBook, directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-skill-evidence-'));
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  const senses = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, senses);
  const book = new SkillBook(null, directory);
  initialize?.(book, directory);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, senses, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); arbiter.cancel('test end'); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = (name: string) => new Promise<TaskOutcome>((resolve, reject) => {
    arbiter.once('done', resolve);
    const started = arbiter.start({ skill: 'use_skill', args: { name } }, 'llm');
    if ('error' in started) { arbiter.off('done', resolve); reject(new Error(started.error)); }
  });
  return { directory, adapter, bus, book, engine, arbiter, run };
}

test('显式归一化退休状态保留历史，并阻止旧稳定版与旧候选绕过禁用', (t) => {
  const stats: Record<string, BehaviorStats> = { [definition.name]: { fired: 4, ok: 3, fail: 2, lastAt: 10, retired: '已合并', retiredAt: 20,
    disabled: false, candidatePermit: 2, byVersion: { '1': { ok: 3, fail: 2 } }, recent: [{ at: 10, ok: false, version: 1, summary: '实际失败' }] } };
  const history = stats[definition.name].byVersion;
  assert.deepEqual(normalizeSkillStates(stats), [definition.name]);
  assert.equal(stats[definition.name].byVersion, history);
  assert.equal(stats[definition.name].candidatePermit, undefined);
  assert.deepEqual(normalizeSkillStates(stats), []);
  stats[definition.name].disabled = false;
  stats[definition.name].candidatePermit = 2;
  const w = setup(t, (book, directory) => {
    assert.ok(book.write(definition.name, definition.description, '原有动作与实际验收', definition).ok);
    assert.ok(book.write(definition.name, definition.description, '尚未验收的旧候选', definition, { candidate: true }).ok);
    fs.writeFileSync(path.join(directory, 'stats.json'), JSON.stringify(stats));
  });
  assert.match(w.engine.executionError(definition.name)!, /停用或收起/);
  assert.match(w.engine.executionError(definition.name, true)!, /停用或收起/);
  assert.equal(w.engine.enabled(w.engine.get(definition.name)!), false);
  assert.deepEqual(w.engine.statsOf(definition.name)?.byVersion, history);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.directory, 'stats.json'), 'utf8'))[definition.name].disabled, true);
});

test('legacy rev、历史统计和磁盘快照共同分配版本，回退也不复用旧号', (t) => {
  const w = setup(t, (book, directory) => {
    const skillDirectory = path.join(directory, definition.name);
    fs.mkdirSync(path.join(skillDirectory, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), `---\nname: ${definition.name}\ndescription: 按委托观察周围\n---\n\n原有步骤\n\n\`\`\`behavior\n${JSON.stringify({ steps: [{ skill: 'look_around', args: { seconds: 2 } }], verify: definition.verify })}\n\`\`\`\n`);
    fs.writeFileSync(path.join(skillDirectory, 'versions', 'v17.js'), 'return {historical:true};');
    fs.writeFileSync(path.join(directory, 'stats.json'), JSON.stringify({ [definition.name]: { fired: 0, ok: 2, fail: 3, lastAt: 0, rev: 7, byVersion: { '11': { ok: 2, fail: 3 } } } }));
    book.reload();
  });
  assert.equal(w.engine.get(definition.name)?.version, 7);
  assert.equal(nextSkillVersion(w.book, definition.name, w.engine.statsOf(definition.name)), 18);
  assert.ok(w.engine.write(definition).ok);
  assert.equal(w.engine.get(definition.name)?.version, 18);
  const old = w.book.definitionVersion(definition.name, 7);
  assert.equal((old?.behavior as { version: number }).version, 7, '完整快照写入实际有效的 legacy 版本');
  w.engine.statsOf(definition.name)!.byVersion!['41'] = { ok: 1, fail: 2 };
  const rolled = w.engine.rollback(definition.name, 7, '恢复原有步骤');
  assert.ok(rolled.ok);
  assert.equal(rolled.version, 42, '回退分配高于全部历史证据的新版本');
  assert.equal(w.engine.get(definition.name)?.code, undefined);
  assert.equal((w.book.definitionVersion(definition.name, 18)?.behavior as { version: number }).version, 18);
  assert.deepEqual(w.engine.statsOf(definition.name)?.byVersion?.['41'], { ok: 1, fail: 2 });
});

test('自动验收和恢复重试绑定调用版本，已取消调用不产生事后成功', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 8 } }).ok);
  w.adapter.hp = 6;
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const now = Date.now();
  assert.equal(w.engine.tick(null, now), true);
  assert.equal((await done).result.status, 'succeeded');
  assert.ok(w.engine.write(definition).ok);
  w.adapter.hp = 10;
  w.engine.tick(null, now + BehaviorEngine.AFTERMATH_MS + 1);
  assert.deepEqual(w.engine.statsOf(definition.name)?.byVersion?.['1'], { ok: 1, fail: 0 });
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 0, fail: 0 });

  const recovery = { ...definition, name: 'observed-recovery', when: { after_failure: { skill: ['navigate_to'], code: ['PATH_NOT_FOUND'] } } };
  assert.ok(w.engine.write(recovery).ok);
  assert.equal(w.engine.recoveryFor({ skill: 'navigate_to', code: 'PATH_NOT_FOUND' })?.version, 1);
  assert.ok(w.engine.write({ ...definition, name: recovery.name }).ok);
  w.engine.creditRecovery(recovery.name, true, { skill: 'navigate_to', code: 'PATH_NOT_FOUND' });
  assert.deepEqual(w.engine.statsOf(recovery.name)?.byVersion?.['1'], { ok: 1, fail: 0 });
  assert.deepEqual(w.engine.currentStats(recovery.name), { ok: 0, fail: 0 });

  const cancelledName = 'cancelled-auto';
  assert.ok(w.engine.write({ ...definition, name: cancelledName, when: { hp_below: 8 }, code: 'api.log("cancellation-ready"); await api.sleep(1000); await api.move({forward:true},50);' }).ok);
  w.adapter.hp = 6;
  const cancelled = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const ready = new Promise<void>((resolve) => {
    const observed = (event: AgentEvent) => {
      if (event.type !== 'skill_log' || !event.msg.includes('cancellation-ready')) return;
      w.bus.off('event', observed);
      resolve();
    };
    w.bus.on('event', observed);
  });
  const startedAt = Date.now();
  assert.equal(w.engine.tick(null, startedAt), true);
  await ready;
  w.arbiter.cancel('取消本次试验');
  assert.equal((await cancelled).result.status, 'cancelled');
  w.adapter.hp = 10;
  w.engine.tick(null, startedAt + BehaviorEngine.AFTERMATH_MS + 1);
  assert.deepEqual(w.engine.currentStats(cancelledName), { ok: 0, fail: 0 }, '取消后状态自行解除也不归功给技能');
});

test('候选失败保留自己的版本证据，独立收起不改变稳定版的可靠性或竞争分', (t) => {
  const w = setup(t, (book, directory) => {
    assert.ok(book.write(definition.name, definition.description, '已使用过的原有做法', definition).ok);
    fs.writeFileSync(path.join(directory, 'stats.json'), JSON.stringify({ [definition.name]: { fired: 3, ok: 3, fail: 0, lastAt: 1 } }));
  });
  const score = w.engine.choiceScore(w.engine.get(definition.name)!);
  assert.ok(w.engine.write({ ...definition, code: 'throw new Error("试验未成");' }, { by: 'mind' }).ok);
  for (let i = 0; i < 6; i++) w.engine.recordInvocation(definition.name, { status: 'failed', failureCode: 'ERROR', summary: '候选执行失败', data: { version: 2 } });
  assert.equal(w.engine.reliable(definition.name), null);
  assert.equal(w.engine.choiceScore(w.engine.get(definition.name)!), score);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 3, fail: 0 });
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 0, fail: 6 });
  const curator = new SkillCurator({ autonomous: false, noteInvalid() {}, async complete() { return { text: '{}', latencyMs: 0 }; } }, w.engine, w.book, w.bus);
  assert.deepEqual(curator.retireLowValue(Date.now() + 2 * 3600_000), [definition.name]);
  assert.equal(w.engine.candidateRetirement(definition.name)?.version, 2);
  assert.equal(w.engine.inactive(definition.name), false);
  assert.equal(w.engine.executionError(definition.name), null);
  assert.equal(w.engine.reliable(definition.name), null);
});

test('稳定版什么都没做的成功返回不累积成功或失败证据', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, code: 'return {ok:true};', verify: 'const s = await api.state(); return true;' }).ok);
  const result = await w.run(definition.name);
  assert.equal(result.result.status, 'succeeded');
  assert.equal(result.result.data?.noop, true);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 0, fail: 0 });
  assert.equal(w.engine.statsOf(definition.name)?.skipped, 1);
});

test('反射触发的空转独立于是否打断：记 idle、歇一会儿、不计成败', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 8 }, code: 'return {ok:true};', verify: 'const s = await api.state(); return true;' }).ok);
  w.adapter.hp = 6;
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const now = Date.now();
  assert.equal(w.engine.tick(null, now), true);
  assert.equal((await done).result.data?.noop, true);
  assert.equal(w.engine.statsOf(definition.name)?.idleInterrupts, 1, '独立触发的空转也要记 idle');
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 0, fail: 0 });
  assert.ok(w.engine.heldNow(now + 1).includes(definition.name), '空转后先歇一会儿，别反复空转');
});

test('手动和候选调用的使用次数分版持久化，跳过和候选失败不污染稳定版成败', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  assert.equal((await w.run(definition.name)).result.status, 'succeeded');
  assert.ok(w.engine.write({ ...definition, code: 'return {skipped:"当前不用做"};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const started = w.arbiter.start({ skill: 'use_skill', args: { name: definition.name, trial: true } }, 'llm');
  assert.ok(!('error' in started));
  assert.equal((await done).result.status, 'succeeded');
  w.engine.recordInvocation(definition.name, { status: 'failed', failureCode: 'ERROR', summary: '候选实际失败', data: { version: 2 } });
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 });
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 0, fail: 1 });
  const stored = JSON.parse(fs.readFileSync(path.join(w.directory, 'stats.json'), 'utf8')) as Record<string, BehaviorStats>;
  assert.equal(stored[definition.name].uses, 3);
  assert.equal(stored[definition.name].skipped, 1);
  assert.deepEqual(usageCounts(stored[definition.name].usageByVersion), {
    '1': { uses: 1, skipped: 0, cancelled: 0 }, '2': { uses: 2, skipped: 1, cancelled: 0 },
  });
});

test('恢复技能返回skipped后调度清理只记一次使用和跳过', async (t) => {
  const w = setup(t), failure = { skill: 'navigate_to', code: 'PATH_NOT_FOUND', args: { to: { x: 1, y: 64, z: 0 } } };
  assert.ok(w.engine.write({ ...definition, when: { after_failure: { skill: ['navigate_to'], code: ['PATH_NOT_FOUND'] } },
    code: 'return {skipped:"不符合本次条件"};', verify: 'const s = await api.state(); return true;' }).ok);
  assert.equal(w.engine.recoveryFor(failure)?.name, definition.name);
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const started = w.arbiter.start({ skill: 'use_skill', args: { name: definition.name, failure } }, 'llm');
  assert.ok(!('error' in started), 'error' in started ? started.error : undefined);
  assert.equal((await done).result.status, 'succeeded');
  w.engine.recoverySkipped(definition.name, failure);
  const stats = w.engine.statsOf(definition.name)!;
  assert.equal(stats.uses, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.fired, 0);
  assert.deepEqual(usageCounts(stats.usageByVersion)?.['1'], { uses: 1, skipped: 1, cancelled: 0 });
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 0, fail: 0 });
});

test('自动技能的成败在完成时按执行结果记一次，事后观测只补事实不重复记成败', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 8 } }).ok);
  w.adapter.hp = 6;
  const after: AgentEvent[] = [];
  const onAftermath = (event: AgentEvent) => { if (event.type === 'skill_aftermath') after.push(event); };
  w.bus.on('event', onAftermath);
  t.after(() => w.bus.off('event', onAftermath));
  const now = Date.now(), done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  assert.equal(w.engine.tick(null, now), true);
  assert.equal((await done).result.status, 'succeeded');
  assert.equal(w.engine.statsOf(definition.name)?.uses, 1);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 }, '完成即按执行结果记成败');
  w.adapter.hp = 10;
  w.engine.tick(null, now + BehaviorEngine.AFTERMATH_MS + 1);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 }, '事后观测不再重复记成败');
  assert.equal(w.engine.statsOf(definition.name)?.uses, 1);
  assert.deepEqual(usageCounts(w.engine.statsOf(definition.name)?.usageByVersion)?.['1'], { uses: 1, skipped: 0, cancelled: 0 });
  assert.equal(after.length, 1, '一次试验只补一条事后观测');
  assert.equal((after[0].data as Record<string, unknown>).still, false);
});

test('顶层取消分别记录稳定版和候选使用，执行期间修订且缺版本时不猜归属', async (t) => {
  const w = setup(t);
  const cancellable = (marker: string) => ({ ...definition, code: `api.log("${marker}"); await api.sleep(1000); await api.move({forward:true},50);` });
  const cancelRun = async (trial: boolean, marker: string, revise?: () => void) => {
    const ready = new Promise<void>((resolve) => {
      const observed = (event: AgentEvent) => {
        if (event.type !== 'skill_log' || !event.msg.includes(marker)) return;
        w.bus.off('event', observed);
        resolve();
      };
      w.bus.on('event', observed);
    });
    const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
    const started = w.arbiter.start({ skill: 'use_skill', args: { name: definition.name, ...(trial ? { trial } : {}) } }, 'llm');
    assert.ok(!('error' in started));
    await ready;
    revise?.();
    w.arbiter.cancel('取消测试调用');
    assert.equal((await done).result.status, 'cancelled');
  };
  assert.ok(w.engine.write(cancellable('stable-cancel-ready')).ok);
  await cancelRun(false, 'stable-cancel-ready');
  assert.ok(w.engine.write(cancellable('candidate-cancel-ready'), { by: 'mind' }).ok);
  await cancelRun(true, 'candidate-cancel-ready');
  await cancelRun(false, 'stable-cancel-ready', () => { assert.ok(w.engine.write(definition).ok); });
  const stats = w.engine.statsOf(definition.name)!;
  assert.equal(stats.uses, 3);
  assert.equal(stats.cancelled, 3);
  assert.deepEqual(usageCounts(stats.usageByVersion), {
    '1': { uses: 1, skipped: 0, cancelled: 1 }, '2': { uses: 1, skipped: 0, cancelled: 1 },
  }, 'the third cancellation has no trustworthy result version and is counted only in the total');
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 0, fail: 0 });
  const stored = JSON.parse(fs.readFileSync(path.join(w.directory, 'stats.json'), 'utf8')) as Record<string, BehaviorStats>;
  assert.equal(stored[definition.name].cancelled, 3);
});

test('试用中的反射触发后空转，也和稳定版一样记 idle、歇一会儿，不会冷却一过就再打断', async (t) => {
  const w = setup(t, (book) => {
    assert.ok(book.write(definition.name, definition.description, '尚未验收的候选',
      { ...definition, when: { hp_below: 8 }, code: 'return {skipped:"这次不适用"};', verify: 'return true;' }, { candidate: true }).ok);
  });
  w.adapter.hp = 6;
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const now = Date.now();
  assert.equal(w.engine.tick(null, now), true, '要命条件下候选可以自动接手');
  await done;
  assert.equal(w.engine.statsOf(definition.name)?.idleInterrupts, 1, '候选空转也要留下 idle 信号');
  assert.ok(w.engine.heldNow(now + 1).includes(definition.name), '候选空转后先歇一会儿');
});
