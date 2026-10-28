import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-args-'));

function rig(t: any, dir = tmp()) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const engine = new BehaviorEngine(new SkillBook(null, dir), adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  const run = (args: unknown) => new Promise<TaskOutcome>((res) => { arbiter.once('done', res); arbiter.start({ skill: 'use_skill', args: { name: 'echo-y', args } }, 'llm'); });
  return { adapter, engine, run };
}

test('声明了参数的技能：传了不认识的参数名当场说清楚它要什么；没声明的照旧不管', (t) => {
  const { engine, adapter } = rig(t);
  assert.ok(engine.write({ name: 'echo-y', description: '把要到的高度原样报回来', args: { y: '要挖到的高度' }, code: 'return { y: args.y };', verify: 'return true;' }).ok);
  const bad = useSkill.validate({ name: 'echo-y', args: { targetY: 30 } }, adapter as any) as any;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不认识参数 args\.targetY；它要的是：args\.y（要挖到的高度）/);
  assert.equal((useSkill.validate({ name: 'echo-y', args: { y: 30 } }, adapter as any) as any).ok, true);
  assert.equal((useSkill.validate({ name: 'echo-y', args: { y: 30, trigger: {} } }, adapter as any) as any).ok, true, 'trigger 是身体自己带的');
});

test('代码里照判定的写法读 args.args.y 也读得到调用参数', async (t) => {
  const { engine, run } = rig(t);
  assert.ok(engine.write({ name: 'echo-y', description: '把要到的高度原样报回来', code: 'return { a: args.y, b: args.args.y };', verify: 'return args.args.y === 30 ? true : "没读到 y";' }).ok);
  const o = await run({ y: 30 });
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.match(o.result.summary, /"a":30,"b":30/);
});

test('dig-down-to-depth v11：声明了 y，判定拿调用方给的 y 核对', () => {
  const md = fs.readFileSync('data/skills/dig-down-to-depth/SKILL.md', 'utf8');
  const b = JSON.parse(md.match(/```behavior\n([\s\S]*?)\n```/)![1]);
  assert.equal(b.version, 11);
  assert.deepEqual(Object.keys(b.args), ['y']);
  assert.match(b.verify, /args\.args\.y/);
  assert.doesNotMatch(b.verify, /r\.target/);
  const code = fs.readFileSync('data/skills/dig-down-to-depth/code.js', 'utf8');
  assert.match(code, /typeof args\.y === "number"/);
  assert.doesNotMatch(code, /feet\.y - 20/);
});

test('参数摊平写也认；说明里写了默认值的参数可以不给', (t) => {
  const { engine, adapter } = rig(t);
  assert.ok(engine.write({ name: 'echo-y', description: '把要到的高度原样报回来', args: { y: '要挖到的高度', dir: '方向 N/S/E/W，不给就按当前朝向' }, code: 'return { y: args.y };', verify: 'return true;' }).ok);
  const flat = useSkill.validate({ name: 'echo-y', y: 30, dir: 'E' }, adapter as any) as any;
  assert.equal(flat.ok, true, flat.error);
  assert.deepEqual(flat.args.args, { y: 30, dir: 'E' });
  const noDir = useSkill.validate({ name: 'echo-y', args: { y: 30 } }, adapter as any) as any;
  assert.equal(noDir.ok, true, noDir.error);
  const noY = useSkill.validate({ name: 'echo-y', args: { dir: 'E' } }, adapter as any) as any;
  assert.equal(noY.ok, false);
  assert.match(noY.error, /需要参数：args\.y/);
});
