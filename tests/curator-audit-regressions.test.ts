import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { compileCheck } from '../src/codeskills/sandbox.ts';
import { EventBus } from '../src/events.ts';
import { KnowledgeBase } from '../src/knowledge/library.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import type { ChatMessage } from '../src/planner/llm.ts';
import { FakeAdapter } from './fake-adapter.ts';

const definition = {
  name: 'merge-a', description: '按参数指定位置移动并核对真实位置变化', body: '只执行指定移动，通过前后观测确认结果。',
  code: 'return await api.moveTo(args.target);',
  verify: 'const s = await api.state(); return s.pos.x !== args.before.pos.x ? true : "位置未变";',
  args: { target: '目的地坐标' }, cooldown_s: 37, priority: 42,
};
const merged = { ...definition, code: 'await api.lookAt(args.target); return await api.moveTo(args.target);' };

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-curator-audit-'));
  const book = new SkillBook(null, directory), adapter = new FakeAdapter(), bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { book, adapter, bus, engine };
}

function plannerOf(responses: unknown[]) {
  let index = 0;
  return { autonomous: true, noteInvalid() {}, async complete() {
    return { text: JSON.stringify(responses[Math.min(index++, responses.length - 1)]), latencyMs: 0 };
  } };
}

test('整理输入保留长代码完整契约，并提供步骤技能的验收和参数', (t) => {
  const w = setup(t);
  const code = `/*${'完整源码'.repeat(700)}*/\n${definition.code}`;
  assert.ok(code.length > 2500);
  assert.equal(compileCheck(code), null);
  assert.notEqual(compileCheck(code.slice(0, 2500)), null, '原截断片段语法不完整');
  assert.ok(w.engine.write({ ...definition, code }, { by: 'mind' }).ok);
  const steps = [{ skill: 'move_step', args: { to: [1, 0, 0] } }];
  assert.ok(w.engine.write({ ...definition, name: 'step-contract', code: undefined, steps }, { by: 'mind' }).ok);
  const curator = new SkillCurator(plannerOf([{ ok: true }]), w.engine, w.book, w.bus);
  t.after(() => curator.stop());
  const messages = curator.messages();
  const input = JSON.parse(messages[1].content) as { skills: {
    name: string; code?: string; verify?: string; args?: Record<string, string>; cooldown_s: number; overrides: string[];
    code_validation?: { full_source: boolean; error: string | null }; steps?: unknown[];
  }[] };
  const actual = input.skills.find((entry) => entry.name === definition.name)!;
  assert.equal(actual.code, code);
  assert.deepEqual(actual.code_validation, { full_source: true, error: null });
  for (const entry of input.skills) {
    assert.equal(entry.verify, definition.verify);
    assert.deepEqual(entry.args, definition.args);
    assert.equal(entry.cooldown_s, definition.cooldown_s);
    assert.deepEqual(entry.overrides, []);
  }
  assert.deepEqual(input.skills.find((entry) => entry.name === 'step-contract')?.steps, steps);
  assert.match(messages[0].content, /通过编译不证明玩法正确/);
  assert.doesNotMatch(messages[0].content, /notes 里的 knowledge/, '没有知识库时提示词保持原样');
});

test('同轮合并加优先级只产生一份完整候选，替代关系跟随该版本验收', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  assert.ok(w.engine.write({ ...definition, name: 'merge-b' }).ok);
  for (let i = 0; i < 3; i++) w.engine.recordInvocation('merge-b', {
    status: 'succeeded', summary: '来源版本实际移动通过验收', data: { version: 1, verified: true },
  });
  const response = { merge: [{ from: ['merge-a', 'merge-b'], skill: merged }], priority: [{ name: 'MERGE-A', priority: 73 }] };
  const retire = { retire: [{ name: 'merge-b', target: 'skill', version: 1, why: '完整候选已通过验收', subsumed_by: 'merge-a' }] };
  const curator = new SkillCurator(plannerOf([response, retire]), w.engine, w.book, w.bus);
  t.after(() => curator.stop());
  const result = await curator.check(Date.now(), { force: true });
  assert.match(result!, /优先级 73（已合入候选）/);
  const candidate = w.engine.get('merge-a', true)!;
  assert.equal(candidate.version, 2);
  assert.equal(candidate.code, merged.code);
  assert.equal(candidate.priority, 73);
  assert.equal(candidate.verify, merged.verify);
  assert.equal(w.engine.get('merge-a')?.code, definition.code, '稳定版仍保留');
  assert.equal(w.book.definitionVersion('merge-a', 3), null, '没有覆盖合并内容的额外版本');
  for (let i = 0; i < 3; i++) w.engine.recordInvocation('merge-a', {
    status: 'succeeded', summary: '实际位置变化通过验收', data: { version: 2, verified: true },
  });
  await Promise.resolve();
  assert.equal(w.engine.get('merge-a')?.version, 2);
  assert.match((await curator.check(Date.now(), { force: true }))!, /收起 merge-b/);
  assert.equal(w.engine.inactive('merge-b'), true, '替代关系绑定完整合并候选而非被覆盖版本');
});

test('合并校验失败时，同轮优先级不能从旧稳定版再生成候选', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  const response = { merge: [{ from: ['merge-a'], skill: { ...merged, verify: undefined } }], priority: [{ name: 'merge-a', priority: 73 }] };
  const curator = new SkillCurator(plannerOf([response, { ok: true }]), w.engine, w.book, w.bus);
  t.after(() => curator.stop());
  assert.match((await curator.check(Date.now(), { force: true }))!, /没存下/);
  assert.equal(w.engine.get('merge-a', true), undefined);
  assert.equal(w.engine.get('merge-a')?.version, 1);
  assert.equal(w.engine.get('merge-a')?.priority, definition.priority);
});

test('重复完整合并保留候选版本及证据，不再报告生成新候选', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  assert.ok(w.engine.write({ ...definition, name: 'merge-b' }).ok);
  const response = { merge: [{ from: ['merge-a', 'merge-b'], skill: merged }], priority: [{ name: 'merge-a', priority: 73 }] };
  const curator = new SkillCurator(plannerOf([response]), w.engine, w.book, w.bus);
  t.after(() => curator.stop());
  await curator.check(Date.now(), { force: true });
  w.engine.recordInvocation('merge-a', { status: 'succeeded', summary: '实际移动通过验收', data: { version: 2, verified: true } });
  const repeat = await curator.check(Date.now(), { force: true });
  assert.match(repeat!, /契约未变，保留候选 v2 及已有证据/);
  assert.equal(w.engine.get('merge-a', true)?.version, 2);
  assert.deepEqual(w.engine.currentStats('merge-a', true), { ok: 1, fail: 0 });
  assert.equal(w.bus.recent().filter((event) => event.type === 'skill_merged').length, 1);
});

test('整理回复绑定输入版本，不覆盖模型等待期间的显式修订', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  let calls = 0;
  const newer = { ...definition, code: 'return await api.stepTo(args.target);' };
  const planner = { autonomous: true, noteInvalid() {}, async complete(_messages: ChatMessage[]) {
    if (calls++ > 0) return { text: '{"ok":true}', latencyMs: 0 };
    assert.ok(w.engine.write(newer, { by: 'mind' }).ok);
    return { text: JSON.stringify({ merge: [{ from: ['merge-a'], skill: merged }] }), latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, w.engine, w.book, w.bus);
  t.after(() => curator.stop());
  assert.match((await curator.check(Date.now(), { force: true }))!, /忽略过期结果/);
  assert.equal(w.engine.get('merge-a', true)?.code, newer.code);
  assert.equal(w.engine.get('merge-a', true)?.version, 2);
});

test('文字记录带着按内容检索到的相关资料进入整理，不传整库目录', (t) => {
  const w = setup(t);
  assert.ok(w.book.write('nether-fortress-note', '在下界找要塞', '沿着一个方向找下界要塞，没写清区域和间距。').ok);
  const curator = new SkillCurator(plannerOf([{ ok: true }]), w.engine, w.book, w.bus, {}, undefined, null, new KnowledgeBase('1.20.1'));
  t.after(() => curator.stop());
  const messages = curator.messages();
  const input = JSON.parse(messages[1].content) as { notes: { name: string; knowledge?: { id: string; section?: string; excerpt: string }[] }[]; knowledge_reference?: { edition: string; version: string; evidence: string } };
  const note = input.notes.find((entry) => entry.name === 'nether-fortress-note')!;
  assert.equal(note.knowledge?.[0]?.id, 'blazes-and-fortresses');
  assert.equal(note.knowledge?.[0]?.section, 'generation');
  assert.match(note.knowledge![0]!.excerpt, /432×432/);
  assert.ok(note.knowledge!.length <= 2 && note.knowledge!.every((match) => match.section), '只带可引用章节且每条记录最多 2 条');
  assert.ok(!('catalog' in note) && !('documents' in note), '不塞整库目录');
  assert.match(messages[0].content, /外部参考，不是现场事实/);
  assert.match(messages[0].content, /资料与记录可能一致、矛盾，或只在某些条件下适用/);
  assert.match(messages[0].content, /单条记录要改写也可以 merge，from 只写它自己/);
  assert.deepEqual(input.knowledge_reference, { edition: 'java', version: '1.20.1', evidence: 'reference_not_current_state' });
});

test('长正文不稀释文字记录的检索；没有命中时不带 knowledge', (t) => {
  const w = setup(t);
  assert.ok(w.book.write('nether-fortress-long', '在下界找要塞', '很长的探索记录。'.repeat(200)).ok);
  assert.ok(w.book.write('zzz-note', 'zzzz qqqq', '与任何资料都不相关的记录，只是随便写写的文字。').ok);
  const curator = new SkillCurator(plannerOf([{ ok: true }]), w.engine, w.book, w.bus, {}, undefined, null, new KnowledgeBase('1.20.1'));
  t.after(() => curator.stop());
  const input = JSON.parse(curator.messages()[1].content) as { notes: { name: string; knowledge?: { id: string; section?: string }[] }[] };
  const long = input.notes.find((entry) => entry.name === 'nether-fortress-long')!;
  assert.equal(long.knowledge?.[0]?.id, 'blazes-and-fortresses', '正文长度不稀释主题检索');
  assert.ok(long.knowledge!.every((match) => match.section));
  assert.ok(!('knowledge' in input.notes.find((entry) => entry.name === 'zzz-note')!), '没有相关章节时不带 knowledge');
});
