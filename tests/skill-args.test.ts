import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const book = new SkillBook(null, dir);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  const run = (args: unknown) => new Promise<TaskOutcome>((res) => { arbiter.once('done', res); arbiter.start({ skill: 'use_skill', args: { name: 'echo-y', args } }, 'llm'); });
  return { adapter, book, engine, run };
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
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills', 'dig-down-to-depth');
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const b = JSON.parse(md.match(/```behavior\n([\s\S]*?)\n```/)![1]);
  assert.equal(b.version, 11);
  assert.deepEqual(Object.keys(b.args), ['y']);
  assert.match(b.verify, /args\.args\.y/);
  assert.doesNotMatch(b.verify, /r\.target/);
  const code = fs.readFileSync(path.join(dir, 'code.js'), 'utf8');
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

test('漏参时说明完整契约并指出已经提供的参数，避免补一项时丢掉另一项', (t) => {
  const { engine, adapter } = rig(t);
  assert.ok(engine.write({ name: 'toss-items', description: '丢弃指定物品', args: { items: '物品名列表', count: '每种最多扔多少个' }, code: 'return {};', verify: 'return true;' }).ok);
  const result = useSkill.validate({ name: 'toss-items', args: { items: ['private-item'] } }, adapter);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /需要参数：args\.count/);
  assert.match(result.error, /完整参数：args\.items（物品名列表）、args\.count（每种最多扔多少个）/);
  assert.match(result.error, /已提供：args\.items；保留已提供的参数并补齐缺项/);
  assert.doesNotMatch(result.error, /private-item/);
});

test('技能调用分别报告文字记录、无效定义、候选、停用及不存在', (t) => {
  const dir = tmp();
  const { engine, adapter, book } = rig(t, dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(book.write('notes-only', '文字记录做法', '这是一份没有可执行行为的文字记录，用于阅读和参考。').ok);
  assert.ok(book.write('bad-behavior', '无效定义示例', '这份记录包含一个无法注册的动作定义。', { steps: [{ skill: 'no-such-action' }] }).ok);
  assert.ok(book.write('bad-candidate', '无效候选示例', '这份候选记录包含一个无法注册的动作定义。', { steps: [{ skill: 'no-such-action' }] }, { candidate: true }).ok);
  assert.ok(engine.write({ name: 'candidate-only', description: '候选做法', code: 'return {};', verify: 'return true;' }, { by: 'forge' }).ok);
  assert.ok(engine.write({ name: 'retired-skill', description: '停用做法', code: 'return {};', verify: 'return true;' }).ok);
  engine.retire('retired-skill', '不再使用');
  const error = (name: string, trial = false) => {
    const result = useSkill.validate({ name, trial }, adapter);
    assert.equal(result.ok, false);
    return result.ok ? '' : result.error;
  };
  assert.match(error('notes-only'), /文字记录，没有可执行行为/);
  assert.match(error('bad-behavior'), /可执行定义.*未通过校验/);
  assert.match(error('bad-candidate', true), /候选版本未通过校验/);
  assert.match(error('bad-candidate'), /候选版本未通过校验/);
  assert.match(error('candidate-only'), /尚为候选.*trial:true/);
  assert.equal(useSkill.validate({ name: 'candidate-only', trial: true }, adapter).ok, true);
  assert.match(error('retired-skill'), /已停用或收起/);
  assert.match(error('unknown-skill'), /没有技能 unknown-skill/);
  assert.match(error('notes-only', true), /没有 notes-only 的候选版本/);
});
