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

function ownedRig(reply: (msgs: any[]) => unknown, limits: Record<string, unknown> = {}) {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  assert.ok(engine.write({ name: 'dig-and-climb-stairs-up', description: '一级级挖台阶往上走到见天', code: 'return 1;' }).ok);
  const prompts: any[][] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (msgs: any[]) => { prompts.push(msgs); return { text: JSON.stringify(reply(msgs)), latencyMs: 1 }; } };
  const events: { type: string; msg: string }[] = [];
  bus.on('event', (e: any) => events.push({ type: e.type, msg: e.msg }));
  const ownersFile = path.join(tmp(), 'owners.json');
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 0, ownersFile, ...limits });
  return { smith, engine, prompts, events, ownersFile, bus, book, adapter };
}

const climb = (smith: SkillSmith) => { for (let i = 0; i < 3; i++) { smith.didAction('dig_at', { at: [1, 1, 0] }); smith.didAction('step', { at: [1, 1, 0] }); } };

test('写技能：模型说“这事归 X 管”，同一件事再来直接交给 X、提醒心智，不再请模型；X 出了问题才再请', async () => {
  const r = ownedRig(() => ({ none: true, why: '挖台阶上行归 dig-and-climb-stairs-up 管', covered_by: 'dig-and-climb-stairs-up' }));
  climb(r.smith);
  await flush();
  assert.equal(r.prompts.length, 1);
  assert.match(r.prompts[0][0].content, /covered_by/);
  assert.ok(r.events.some((e) => e.type === 'skill_forge_none' && /归「dig-and-climb-stairs-up」管/.test(e.msg)));
  // 换个起点的同一串（step → dig_at）也是同一件事；隔了 20 分钟也认
  (r.smith as any).repeatedAt.clear();
  r.smith.didAction('step', { at: [1, 1, 0] });
  climb(r.smith);
  await flush();
  assert.equal(r.prompts.length, 1, '归 X 管的事不再请模型');
  assert.ok(r.events.some((e) => e.type === 'skill_forge_owned'));
  assert.ok(r.events.some((e) => e.type === 'skill_hint' && /use_skill \{"name":"dig-and-climb-stairs-up"/.test(e.msg)), '提醒心智用现成技能');
  // 重启后还记得
  const saved = JSON.parse(fs.readFileSync(r.ownersFile, 'utf8'));
  assert.equal(Object.values<any>(saved)[0].skill, 'dig-and-climb-stairs-up');
  // X 最近一次没成：作废，再请模型
  r.engine.statsOf('dig-and-climb-stairs-up') ?? (r.engine as any).touch('dig-and-climb-stairs-up', () => {});
  (r.engine as any).stats['dig-and-climb-stairs-up'] = { fired: 1, ok: 0, fail: 1, lastAt: Date.now(), recent: [{ at: Date.now(), ok: false, summary: '没上去' }] };
  (r.smith as any).repeatedAt.clear();
  climb(r.smith);
  await flush();
  assert.equal(r.prompts.length, 2, 'X 刚失败过：这件事重新请模型看');
  r.smith.stop();
});

test('写技能：X 被改写（换了版本）或收起，归属作废', async () => {
  const r = ownedRig(() => ({ none: true, why: '有人管', covered_by: 'dig-and-climb-stairs-up' }));
  climb(r.smith);
  await flush();
  assert.ok(r.smith.ownerOf('repeated:dig_at > step'));
  assert.ok(r.engine.write({ name: 'dig-and-climb-stairs-up', description: '一级级挖台阶往上走到见天 v2', code: 'return 2;' }).ok);
  assert.equal(r.smith.ownerOf('repeated:dig_at > step'), null, '改写后重新判断');
  r.smith.stop();
});

test('写技能：攒批——几分钟里的几件事一次请模型看完，各自记结论；死亡不等', async () => {
  const r = ownedRig((msgs) => {
    const u = JSON.parse(msgs[1].content);
    if (!u.events) return { none: true, why: '单件' };
    return { results: [
      { event: 1, none: true, why: '归它管', covered_by: 'dig-and-climb-stairs-up' },
      { event: 2, skill: { name: 'plug-water-first', description: '旁边有水先堵上再挖', code: 'return 1;', verify: 'const s = await api.state(); return true;' } },
    ] };
  }, { batchMs: 60_000 });
  r.smith.report('recurring', Date.now(), 'step 半小时内第 3 次因为 PATH_NOT_FOUND 失败', 0, undefined, ['失败：step PATH_NOT_FOUND'], undefined, 'recurring:step:PATH_NOT_FOUND');
  r.smith.report('noted', Date.now(), '挖到水边灌进来了', 0, '挖到水边灌进来了');
  await flush();
  assert.equal(r.prompts.length, 0, '先攒着');
  (r.smith as any).queue.forEach((q: any) => { q.queuedAt -= 61_000; });
  (r.smith as any).next();
  await flush();
  assert.equal(r.prompts.length, 1, '一批只请一次');
  const u = JSON.parse(r.prompts[0][1].content);
  assert.equal(u.events.length, 2);
  assert.ok(u.events.every((e: any) => e.how_to_look && e.what_happened));
  assert.ok(r.engine.get('plug-water-first'), '第 2 件写成了技能');
  assert.ok(r.events.some((e) => e.type === 'skill_forge_start' && /一批 2 件/.test(e.msg)));
  r.smith.report('death', Date.now(), 'Curio was slain by Zombie', 0);
  await flush();
  assert.equal(r.prompts.length, 2, '死亡不等批');
  r.smith.stop();
});
