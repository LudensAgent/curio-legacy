import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-recovery-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };
const when = { after_failure: { skill: ['goto'], code: ['PATH_NOT_FOUND'] } };
const failure = { skill: 'goto', code: 'PATH_NOT_FOUND' };

function setup() {
  const engine = new BehaviorEngine(new SkillBook(BUILTIN_SKILLS_DIR, tmp()), new FakeAdapter(), null, new EventBus(), noSenses);
  assert.ok(engine.write({ name: 'high-but-useless', description: '优先级高，但一直没用', when, priority: 60, code: 'return { ok: true };' }).ok);
  assert.ok(engine.write({ name: 'lower-but-works', description: '优先级低，但管用', when, priority: 40, code: 'return { ok: true };' }).ok);
  engine.creditRecovery('high-but-useless', true); for (let i = 0; i < 3; i++) engine.creditRecovery('high-but-useless', false);
  for (let i = 0; i < 6; i++) engine.creditRecovery('lower-but-works', true);
  return engine;
}

test('recovery picks by priority plus actual success rate, not list order alone', () => {
  const engine = setup();
  assert.equal(engine.recoveryFor(failure)?.name, 'lower-but-works');
});

test('a recovery skill that says "not my case" is not charged, not counted as a takeover, and is not retried for the same failure for a while', () => {
  const engine = setup(), now = Date.now();
  assert.equal(engine.recoveryFor(failure, new Set(), now)?.name, 'lower-but-works');
  const firedBefore = engine.statsOf('lower-but-works')!.fired;
  engine.recoverySkipped('lower-but-works', failure, now);
  const st = engine.statsOf('lower-but-works')!;
  assert.equal(st.fired, firedBefore - 1);
  assert.equal(st.skipped, 1);
  assert.equal(st.fail, 0, 'skipping is neither success nor failure');
  // 换了一段活（tried 清空）也不马上再拿它试同一种失败
  assert.equal(engine.recoveryFor(failure, new Set(), now + 10_000)?.name, 'high-but-useless');
  assert.equal(engine.recoveryFor(failure, new Set(), now + BehaviorEngine.RECOVERY_MISS_MS + 10_000)?.name, 'lower-but-works');
});

test('a recovery that did not help is not re-run on the same failure right after re-planning', () => {
  const engine = setup(), now = Date.now();
  engine.creditRecovery('lower-but-works', false, failure);
  assert.equal(engine.recoveryFor(failure, new Set(), now + 10_000)?.name, 'high-but-useless');
});

test('a freshly forged, still unused version cannot be rewritten by background forging within minutes', () => {
  const engine = new BehaviorEngine(new SkillBook(BUILTIN_SKILLS_DIR, tmp()), new FakeAdapter(), null, new EventBus(), noSenses);
  assert.ok(engine.write({ name: 'climb-wet', description: '往上爬被水挡住时先横着挪开再爬', when, code: 'return 1;', verify: 'return true;' }, { by: 'forge' }).ok);
  const again = engine.write({ name: 'climb-wet', description: '往上爬被水挡住时换个方向挖', code: 'return 2;', verify: 'return true;' }, { by: 'forge' });
  assert.equal(again.ok, false);
  assert.equal((again as any).gated, true);
  assert.match((again as any).error, /才写下、还没用过/);
  engine.statsOf('climb-wet')!.writtenAt = Date.now() - BehaviorEngine.REWRITE_GAP_MS - 1;
  assert.ok(engine.write({ name: 'climb-wet', description: '往上爬被水挡住时换个方向挖', when, code: 'return 2;', verify: 'return true;' }, { by: 'forge' }).ok, 'after a while an unused version may be rewritten again');
  // 心智自己点名改写不受这个限制
  assert.ok(engine.write({ name: 'climb-wet', description: '往上爬被水挡住时心智自己改的做法', when, code: 'return 2;', verify: 'return true;' }, { by: 'mind' }).ok);
});

test('skill code that calls an api the sandbox does not have is rejected before saving', async () => {
  const { compileCheck } = await import('../src/codeskills/sandbox.ts');
  assert.match(String(compileCheck('const e = await api.nearbyEntities(8); return e;')), /没有 api\.nearbyEntities/);
  assert.equal(compileCheck('const land = await api.nearestLand(); api.log(land); return land;'), null);
});
