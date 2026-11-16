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
import type { ChatMessage } from '../src/planner/llm.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-forge-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };
const asPlanner = (planner: object) => planner as unknown as ConstructorParameters<typeof SkillSmith>[0];
const internals = (smith: SkillSmith) => smith as unknown as { forgedAt: number[]; queue: { retryAt?: number; queuedAt?: number }[]; next(): void };
type ForgePayload = { existing_skill_contracts: { name: string }[]; episode: string[]; observed_events?: { data?: string }[] };
const payload = (messages: ChatMessage[]) => JSON.parse(messages[1].content) as ForgePayload;

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

test('死亡包只带相关契约，超预算时自动缩小材料', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const base = { code: 'return 1;', verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";' };
  for (const name of ['explore-edge-a', 'explore-edge-b', 'explore-edge-c', 'explore-edge-d']) {
    assert.ok(engine.write({ ...base, name, description: 'explore_toward 因为边缘/坠落停下时先稳住落点', when: { after_failure: { skill: ['explore_toward'] } } }).ok);
  }
  assert.ok(engine.write({ ...base, name: 'cook-food', description: '饿了就烤食物' }).ok);
  const calls: ChatMessage[][] = [];
  const planner = { autonomous: true, noteInvalid() {}, async complete(msgs: ChatMessage[]) {
    calls.push(msgs);
    if (calls.length === 1) throw new Error('PROMPT_BUDGET_EXCEEDED: 200000/128000');
    return { text: JSON.stringify({ none: true, why: '测试不写' }), latencyMs: 1 };
  } };
  const smith = new SkillSmith(asPlanner(planner), engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 0 });
  smith.start();
  const long = 'x'.repeat(2000);
  bus.publish('task_end', 'P2', `task_end explore_toward ${long}`, { status: 'failed', skill: 'explore_toward', failureCode: 'EFFECT_NOT_CONFIRMED', detail: long });
  smith.report('death', Date.now(), 'Curio tried to swim in lava（在做 explore_toward N）', 60_000, undefined,
    Array.from({ length: 90 }, (_, i) => `[${i}s] task_end explore_toward ${long}`));
  await flush();
  assert.equal(calls.length, 2, '第一次超预算后缩小材料重发一次');
  const first = payload(calls[0]);
  const second = payload(calls[1]);
  assert.ok(first.existing_skill_contracts.length <= 3, '完整材料最多带 3 份相关契约');
  assert.ok(first.existing_skill_contracts.some((s) => s.name === 'explore-edge-a'));
  assert.ok(!first.existing_skill_contracts.some((s) => s.name === 'cook-food'), '无关技能不整份带入');
  assert.ok(first.episode.length <= 30 && first.episode.length > 0, '完整死亡材料也只留最近 30 条');
  assert.ok(first.observed_events?.some((event) => typeof event.data === 'string' && event.data.length <= 401), '完整材料的事件 data 也截断');
  assert.ok(second.existing_skill_contracts.length < first.existing_skill_contracts.length, '缩小后契约更少');
  assert.ok(second.episode.length <= 30 && second.episode.length > 0, '死亡只留最近 30 条经过');
  assert.ok(second.episode.every((line) => line.length <= 221), '单条经过截断');
  assert.ok(second.observed_events?.some((event) => typeof event.data === 'string' && event.data.length <= 221), `事件 data 截断保留：${JSON.stringify(second.observed_events)?.slice(0, 200)}`);
  smith.stop();
});

test('中文死亡与 all 里嵌套的 after_failure 也能选中相关契约', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const base = { code: 'return 1;', verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";' };
  assert.ok(engine.write({ ...base, name: 'lava-edge-recover', description: '岩浆边先退到干地', when: { all: [{ after_failure: { skill: ['explore_toward'] } }] } }).ok);
  assert.ok(engine.write({ ...base, name: 'cook-food', description: '饿了就烤食物' }).ok);
  const prompts: ChatMessage[][] = [];
  const planner = { autonomous: true, noteInvalid() {}, async complete(msgs: ChatMessage[]) {
    prompts.push(msgs);
    return { text: JSON.stringify({ none: true, why: '测试不写' }), latencyMs: 1 };
  } };
  const smith = new SkillSmith(asPlanner(planner), engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 0 });
  smith.report('death', Date.now(), '死亡：被岩浆烧死', 0, undefined, ['explore_toward 掉进岩浆']);
  await flush();
  const user = payload(prompts[0]);
  assert.ok(user.existing_skill_contracts.some((s) => s.name === 'lava-edge-recover'));
  assert.ok(!user.existing_skill_contracts.some((s) => s.name === 'cook-food'));
  smith.stop();
});

test('没有词能对上时仍带最近的自学契约（含只有候选的技能）', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  assert.ok(engine.write({ name: 'candidate-only', description: '完全无关描述', code: 'return 1;', verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";' }, { by: 'mind' }).ok);
  const prompts: ChatMessage[][] = [];
  const planner = { autonomous: true, noteInvalid() {}, async complete(msgs: ChatMessage[]) {
    prompts.push(msgs);
    return { text: JSON.stringify({ none: true, why: '测试不写' }), latencyMs: 1 };
  } };
  const smith = new SkillSmith(asPlanner(planner), engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 0 });
  smith.report('death', Date.now(), '死亡', 0, undefined, ['qqq']);
  await flush();
  const user = payload(prompts[0]);
  assert.ok(user.existing_skill_contracts.some((s) => s.name === 'candidate-only'));
  smith.stop();
});

test('超预算失败不占每小时额度，死亡也不占', async () => {
  let calls = 0;
  const r = ownedRig(() => {
    calls++;
    if (calls === 1) throw new Error('PROMPT_BUDGET_EXCEEDED: 200000/128000');
    return { none: true, why: '测试不写' };
  }, { maxPerHour: 2 });
  r.smith.report('noted', Date.now(), '第一件值得学的事', 0);
  await flush();
  assert.equal(internals(r.smith).forgedAt.length, 1, '只有真正到模型的缩减请求计数');
  r.smith.report('death', Date.now(), 'Curio was slain by Zombie', 0);
  await flush();
  assert.equal(internals(r.smith).forgedAt.length, 1, '死亡不占普通学习额度');
  r.smith.stop();
});

test('模型持续不可用时也有重试上限', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const events: { type: string; msg: string }[] = [];
  bus.on('event', (e: { type: string; msg: string }) => events.push({ type: e.type, msg: e.msg }));
  const planner = { autonomous: true, noteInvalid() {}, async complete() { throw new Error('模拟网络失败'); } };
  const smith = new SkillSmith(asPlanner(planner), engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 99, repeatMs: 0 });
  smith.report('noted', Date.now(), '网络一直不通的事', 0);
  await flush();
  for (let i = 0; i < 8; i++) {
    internals(smith).queue.forEach((q) => { q.retryAt = 0; q.queuedAt = 0; });
    internals(smith).next();
    await flush();
  }
  assert.equal(internals(smith).queue.length, 0, '超过上限后不再回到队列');
  assert.ok(events.some((e) => e.type === 'skill_forge_abandoned' && /6 次/.test(e.msg)));
  smith.stop();
});

test('同一件事实在写不出来时有重试上限', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const events: { type: string; msg: string }[] = [];
  bus.on('event', (e: { type: string; msg: string }) => events.push({ type: e.type, msg: e.msg }));
  const planner = { autonomous: true, noteInvalid() {}, async complete() { throw new Error('PROMPT_BUDGET_EXCEEDED: 999999/128000'); } };
  const smith = new SkillSmith(asPlanner(planner), engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 99, repeatMs: 0 });
  smith.report('noted', Date.now(), '一直写不出来的事', 0);
  await flush();
  for (let i = 0; i < 5; i++) {
    internals(smith).queue.forEach((q) => { q.retryAt = 0; q.queuedAt = 0; });
    internals(smith).next();
    await flush();
  }
  assert.equal(internals(smith).queue.length, 0, '超过上限后不再回到队列');
  assert.ok(events.some((e) => e.type === 'skill_forge_abandoned' && /停止自动重试/.test(e.msg)));
  smith.stop();
});
