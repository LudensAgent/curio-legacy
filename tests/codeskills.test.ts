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

test('样本里的局部寻路代码技能：绕过一堵墙走到目标', async (t) => {
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
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.ok(Math.abs(adapter.pos.x - 4.5) <= 1.6 && Math.abs(adapter.pos.z - 0.5) <= 1.6, `走到了 ${JSON.stringify(adapter.pos)}`);
});

test('代码技能老失败：后台单独请模型改代码，换上新版本；改进有间隔，不会频繁发生', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (messages: any[]) => {
    asked.push(messages.at(-1).content);
    return { text: JSON.stringify({ code: 'const s = await api.state();\nreturn s.feet;', change: '不再读 args.target，直接返回脚下' }), latencyMs: 5 };
  } };
  const improver = new CodeImprover(planner as any, engine, bus);
  engine.improve = (n, why, note) => { improver.consider(n, why, note); };
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  const w = engine.write({ name: 'buggy', description: '一段会出错的代码技能', code: 'const t = args.target.x;\nreturn t;' });
  assert.ok(w.ok, JSON.stringify(w));
  const once = () => new Promise<TaskOutcome>((r) => { arbiter.once('done', r); arbiter.start({ skill: 'use_skill', args: { name: 'buggy' } }, 'llm'); });
  const first = await once();
  assert.match(first.result.summary, /第 1 行/);
  assert.equal(asked.length, 0, '失败一次还不改');
  await once();
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.equal(asked.length, 1, '失败两次后在后台改');
  assert.match(asked[0], /args\.target/, '改进时看得到出错的代码和记录');
  assert.equal(engine.get('buggy')?.version, 2);
  assert.ok(fs.existsSync(path.join(path.dirname(book.get('buggy')!.file), 'versions', 'v1.js')), '旧版本留着');
  const ok = await once();
  assert.equal(ok.result.status, 'succeeded');
  assert.match(improver.consider('buggy', 'requested', '想更快')!, /太近/, '刚改过不会马上再改');
});
