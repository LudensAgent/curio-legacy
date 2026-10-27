import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-forge-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

function rig(limits: { maxPerHour: number; repeatMs: number }) {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  let calls = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => { calls++; return { text: JSON.stringify({ none: true, why: '不是技能能解决的' }), latencyMs: 1 }; } };
  const events: string[] = [];
  bus.on('event', (e: any) => events.push(e.type));
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), () => [], limits);
  return { smith, calls: () => calls, events };
}

test('写技能：同一件事（只差数字）一段时间内只请一次模型', async () => {
  const r = rig({ maxPerHour: 24, repeatMs: 20 * 60_000 });
  r.smith.report('recurring', Date.now(), 'goto 第 3 次 PATH_NOT_FOUND（362,22,-325）', 0);
  await flush();
  r.smith.report('recurring', Date.now() + 120_000, 'goto 第 5 次 PATH_NOT_FOUND（361,17,-324）', 0);
  await flush();
  assert.equal(r.calls(), 1);
  assert.ok(r.events.includes('skill_forge_skipped'));
  r.smith.report('recurring', Date.now() + 240_000, 'step 第 3 次 PATH_NOT_FOUND', 0);
  await flush();
  assert.equal(r.calls(), 2, '不同的事照常看');
  r.smith.stop();
});

test('写技能：每小时有上限，死亡不受限', async () => {
  const r = rig({ maxPerHour: 2, repeatMs: 0 });
  for (const h of ['挖矿一再失败', '放方块一再失败', '合成一再失败']) { r.smith.report('noted', Date.now() + Math.random() * 1e6 + 1e5, h, 0, h); await flush(); }
  assert.equal(r.calls(), 2);
  assert.ok(r.events.includes('skill_forge_capped'));
  r.smith.report('death', Date.now() + 5e6, 'Curio was slain by Zombie', 0);
  await flush();
  assert.equal(r.calls(), 3, '死了照样看');
  r.smith.stop();
});

test('代码技能自己返回 {ok:false}：记成没成，不再报"做完了"', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const engine = new BehaviorEngine(new SkillBook(null, tmp()), adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  assert.ok(engine.write({ name: 'gives-up', description: '血太少就不打了的反击', code: 'return { ok: false, flee: "血太少" };' }).ok);
  const o = await new Promise<TaskOutcome>((res) => { arbiter.once('done', res); arbiter.start({ skill: 'use_skill', args: { name: 'gives-up' } }, 'llm'); });
  assert.equal(o.result.status, 'failed');
  assert.match(o.result.summary, /自己报告没成.*血太少/);
});
