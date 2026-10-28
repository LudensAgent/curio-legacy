import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { CodeImprover } from '../src/codeskills/improver.ts';
import { compileCheck, runSandboxed } from '../src/codeskills/sandbox.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-code-'));
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');
const run = (code: string, handle = async (m: string, a: unknown[]) => ({ m, a }), deadlineMs = 5000) =>
  runSandboxed(code, { n: 2 }, handle, { signal: new AbortController().signal, deadline: Date.now() + deadlineMs, pokeMs: 400 });

test('沙箱：代码通过 api 拿结果；死循环会被掐断；拿不到宿主的 process，也不能 eval', async () => {
  const r = await run('const a = await api.blockAt(1, 2, 3); api.log("看见", a.m); return args.n + a.a.length;');
  assert.equal(r.ok, true);
  assert.equal(r.result, 5);
  assert.deepEqual(r.logs, ['看见 blockAt']);
  const loop = await run('await api.state(); while (true) {}');
  assert.equal(loop.ok, false);
  assert.match(loop.error!, /卡住|超时/);
  const escape = await run('return ({}).constructor.constructor("return typeof pro" + "cess")();');
  assert.equal(escape.ok, false, '字符串生成代码被禁止');
  const g = await run('return [typeof setTimeout, typeof globalThis["pro" + "cess"], typeof globalThis["req" + "uire"]];');
  assert.deepEqual(g.result, ['undefined', 'undefined', 'undefined']);
  assert.match(compileCheck('require("fs")')!, /不能 require/);
  assert.match(compileCheck('const x = ;')!, /语法错误/);
});

test('沙箱：出错时报出是代码第几行，api 报错会变成代码里能 catch 的异常', async () => {
  const r = await run('const a = 1;\nconst b = 2;\nthrow new Error("走不过去");');
  assert.equal(r.ok, false);
  assert.equal(r.line, 3);
  assert.match(r.error!, /走不过去/);
  const caught = await run('try { await api.blockAt(0,0,0); } catch (e) { return "接住了：" + e.message; }', async () => { throw new Error('太远了'); });
  assert.equal(caught.result, '接住了：太远了');
  const hang = await run('await new Promise(() => {}); return 1;');
  assert.match(hang.error!, /永远不会来/);
});

test('旧局部寻路样本在未观察的地形前如实失败，不能读取墙后地图假装已找到路', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  adapter.speed = 1000;
  for (const z of [-1, 0, 1]) for (const y of [64, 65]) adapter.blocks.push({ name: 'stone', pos: { x: 2, y, z } });
  const book = new SkillBook(BUILTIN_SKILLS_DIR, FIXTURES);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  assert.equal(engine.get('local-path')?.mode, 'recover');
  assert.ok(engine.get('local-path')?.code?.includes('api.region'));
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'use_skill', args: { name: 'local-path', args: { target: '4,64,0' } } }, 'llm');
  const o = await done;
  assert.equal(o.result.status, 'failed', o.result.summary);
  assert.match(o.result.summary, /找不到能走的路/);
  assert.deepEqual(adapter.pos, { x: 0, y: 64, z: 0 }, '未观察完整地形时没有凭隐藏地图移动');
});

test('代码技能老失败：后台生成待验证修订，稳定版保留，显式试用新版本', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (messages: any[]) => {
    asked.push(messages.at(-1).content);
    return { text: JSON.stringify({ code: 'const s = await api.state();\nreturn s.feet;', verify: 'const s = await api.state(); return s.hp > 0 ? true : "没有存活状态";', change: '不再读 args.target，直接返回脚下' }), latencyMs: 5 };
  } };
  const improver = new CodeImprover(planner as any, engine, bus);
  engine.improve = (n, why, note) => { improver.consider(n, why, note); };
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  const w = engine.write({ name: 'buggy', description: '一段会出错的代码技能', code: 'const t = args.target.x;\nreturn t;' });
  assert.ok(w.ok, JSON.stringify(w));
  const once = (trial = false) => new Promise<TaskOutcome>((resolve, reject) => {
    const done = (outcome: TaskOutcome) => resolve(outcome);
    arbiter.once('done', done);
    const started = arbiter.start({ skill: 'use_skill', args: { name: 'buggy', ...(trial ? { trial: true } : {}) } }, 'llm');
    if ('error' in started) { arbiter.off('done', done); reject(new Error(started.error)); }
  });
  const first = await once();
  assert.match(first.result.summary, /第 1 行/);
  assert.equal(asked.length, 0, '失败一次还不改');
  await once();
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.equal(asked.length, 1, '失败两次后在后台改');
  assert.match(asked[0], /args\.target/, '改进时看得到出错的代码和记录');
  assert.equal(engine.get('buggy')?.version, 1, '生成修订不覆盖稳定版');
  assert.equal(engine.get('buggy', true)?.version, 2);
  assert.ok(fs.existsSync(path.join(path.dirname(book.get('buggy')!.file), 'code.js')), '稳定代码仍在原位置');
  const ok = await once(true);
  assert.equal(ok.result.status, 'succeeded');
  const limited = new CodeImprover(planner as any, engine, bus, { globalGapMs: 60_000 });
  (limited as any).lastAt = Date.now();
  assert.match(limited.consider('buggy', 'requested', '想更快')!, /太近/, '需要时仍可配置间隔（默认不限）');
});

test('代码技能达到后台改进轮数上限：停止本次改进，保留稳定版和历史', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => ({ text: JSON.stringify({ code: 'return 1;', change: 'x' }), latencyMs: 1 }) };
  assert.ok(engine.write({ name: 'churn', description: '老改不好的技能', code: 'return 1;' }).ok);
  // 已经换过 3 版（byVersion 里 4 个版本），每版都没攒够成功
  for (let v = 1; v <= 4; v++) (engine as any).touch('churn', (st: any) => { st.byVersion = { ...(st.byVersion ?? {}), [v]: { ok: 0, fail: 2 } }; });
  const improver = new CodeImprover(planner as any, engine, bus, { maxRounds: 3 });
  const stable = engine.get('churn');
  const history = structuredClone(engine.statsOf('churn')?.byVersion);
  const why = improver.consider('churn', 'requested', '再改改');
  assert.match(why!, /上限 3 轮.*停止本次改进/);
  assert.equal(engine.inactive('churn'), false, '轮数限制不能替代技能停用或收起决定');
  assert.equal(engine.get('churn'), stable, '保留原稳定版');
  assert.deepEqual(engine.statsOf('churn')?.byVersion, history, '历史证据保留');
  assert.ok(bus.recent().some((e) => e.type === 'skill_improve_skipped' && e.data?.maxRounds === 3));
  assert.equal(improver.busy, null, '没有再发请求');
  const loose = new CodeImprover(planner as any, engine, bus, { maxRounds: 0 });
  const fresh = engine.write({ name: 'fresh', description: '另一份老改不好的技能', code: 'const s = await api.state();\nreturn s.feet;' });
  assert.ok(fresh.ok, JSON.stringify(fresh));
  for (let v = 1; v <= 4; v++) (engine as any).touch('fresh', (st: any) => { st.byVersion = { ...(st.byVersion ?? {}), [v]: { ok: 0, fail: 2 } }; });
  assert.equal(loose.consider('fresh', 'requested', '改'), null, 'maxRounds=0 不限');
});
