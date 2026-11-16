import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { CodeImprover } from '../src/codeskills/improver.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const definition = { name: 'observe-again', description: '重新观察当前位置', code: 'return (await api.state()).feet;', verify: 'const s = await api.state(); return true;' };

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-rewrite-evidence-'));
  const bus = new EventBus(), book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, bus, { perceivedEntities: () => [] });
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write(definition).ok);
  engine.recordInvocation(definition.name, { status: 'failed', failureCode: 'ERROR', summary: '代码技能没成：TypeError: old version', data: { version: 1 } });
  assert.ok(engine.write(definition, { by: 'mind' }).ok);
  return { engine, bus };
}

test('旧版代码错误不能绕过未试用候选的观察期，当前版程序错误仍可及时修订', (t) => {
  const { engine } = setup(t);
  assert.match(engine.rewriteGate(definition.name)!, /还没用过/);
  engine.recordInvocation(definition.name, { status: 'failed', failureCode: 'ERROR', summary: '代码技能没成：Error: 前方没有支撑', data: { version: 2 } });
  assert.match(engine.rewriteGate(definition.name)!, /证据还不够/);
  engine.recordInvocation(definition.name, { status: 'failed', failureCode: 'ERROR', summary: '代码技能没成：TypeError: current version', data: { version: 2 } });
  assert.equal(engine.rewriteGate(definition.name), null);
});

test('改进器的新版本观察期只由当前版程序错误豁免', (t) => {
  const { engine, bus } = setup(t);
  const stats = engine.statsOf(definition.name)!;
  stats.swappedAt = Date.now();
  stats.byVersion!['2'] = { ok: 0, fail: 2 };
  stats.recent!.unshift({ at: Date.now(), ok: false, version: 2, summary: '代码技能没成：Error: 没有看清目标' });
  const planner = { autonomous: true, noteInvalid() {}, async complete() { return { text: '{"keep":true}', latencyMs: 1 }; } };
  const improver = new CodeImprover(planner, engine, bus);
  assert.equal(improver.consider(definition.name, 'failures'), '这一版刚换上不久');
  stats.recent!.push({ at: Date.now(), ok: false, version: 2, summary: 'TypeError: 当前代码调用失败' });
  assert.equal(improver.consider(definition.name, 'failures'), null);
});

test('死亡负证据可改写只用过 1–2 次的技能，零成功边界仍拦住', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-rewrite-death-'));
  const bus = new EventBus(), book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, bus, { perceivedEntities: () => [] });
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write({ ...definition, name: 'death-guard', description: '死亡前该管住的处境' }).ok);
  engine.recordInvocation('death-guard', { status: 'failed', failureCode: 'ERROR', summary: '第一次没管住', data: { version: 1 } });
  engine.recordInvocation('death-guard', { status: 'failed', failureCode: 'ERROR', summary: '第二次没管住', data: { version: 1 } });
  assert.match(engine.rewriteGate('death-guard')!, /证据还不够/);
  assert.equal(engine.write({ ...definition, name: 'death-guard', description: '按死亡负证据改写' }, { by: 'forge' }).ok, false);
  assert.ok(engine.write({ ...definition, name: 'death-guard', description: '按死亡负证据改写' }, { by: 'forge', deathEvidence: true }).ok);
  assert.equal(engine.get('death-guard')?.description, '死亡前该管住的处境');
  assert.equal(engine.get('death-guard', true)?.description, '按死亡负证据改写');

  assert.ok(engine.write({ ...definition, name: 'zero-success', description: '连续失败的做法' }).ok);
  for (const why of ['一次', '两次', '三次']) engine.recordInvocation('zero-success', { status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: why, data: { version: 1 } });
  assert.match(engine.rewriteGate('zero-success')!, /一次都没成/);
  assert.equal(engine.write({ ...definition, name: 'zero-success', description: '死亡也不该绕过零成功' }, { by: 'forge', deathEvidence: true }).ok, false);
});

test('死亡负证据不绕过未试用候选、刚换上版本、墓碑和已收起候选', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-rewrite-deny-'));
  const bus = new EventBus(), book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, bus, { perceivedEntities: () => [] });
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const write = (name: string, extra: Record<string, unknown> = {}) => engine.write({ ...definition, name, ...extra });

  assert.ok(engine.write({ ...definition, name: 'untested-candidate' }, { by: 'mind' }).ok);
  assert.match(engine.rewriteGate('untested-candidate', { deathEvidence: true })!, /还没用过/);
  assert.equal(engine.write({ ...definition, name: 'untested-candidate', description: '死亡也别急改未试用候选' }, { by: 'forge', deathEvidence: true }).ok, false);

  assert.ok(write('fresh-version').ok);
  engine.statsOf('fresh-version')!.swappedAt = Date.now();
  assert.match(engine.rewriteGate('fresh-version', { deathEvidence: true })!, /换上/);
  assert.equal(engine.write({ ...definition, name: 'fresh-version', description: '死亡也别急改' }, { by: 'forge', deathEvidence: true }).ok, false);

  assert.ok(write('tombstoned').ok);
  assert.ok(engine.retire('tombstoned', '之前做坏了'));
  assert.equal(engine.write({ ...definition, name: 'tombstoned', description: '死亡也别复活' }, { by: 'forge', deathEvidence: true }).ok, false);

  assert.ok(engine.write({ ...definition, name: 'retired-candidate' }, { by: 'mind' }).ok);
  assert.ok(engine.retireCandidate('retired-candidate', 1, '候选做坏了'));
  assert.equal(engine.write({ ...definition, name: 'retired-candidate', description: '死亡也别复活候选' }, { by: 'forge', deathEvidence: true }).ok, false);
});

test('零成功技能用够次数后不再自动重写，交给整理收起', (t) => {
  const { engine } = setup(t);
  const name = definition.name;
  // 当前版本（v2 候选）连续失败、一次没成、且不是代码报错：重写只是换一套坏代码，应该拦住
  for (const why of ['没走到目标格', '前方没有支撑', '被挡住过不去']) {
    engine.recordInvocation(name, { status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: `代码技能没成：${why}`, data: { version: 2 } });
  }
  assert.match(engine.rewriteGate(name)!, /一次都没成/);
  // 有过成功、用够次数：允许重写
  engine.recordInvocation(name, { status: 'succeeded', summary: '走到目标格', data: { version: 2, verified: true } });
  assert.equal(engine.rewriteGate(name), null);
});
