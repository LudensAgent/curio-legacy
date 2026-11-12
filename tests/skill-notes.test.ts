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

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-skill-notes-'));
  const book = new SkillBook(null, directory), bus = new EventBus(), adapter = new FakeAdapter();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] });
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, book, bus, engine };
}

const body = '只观察当前脚下位置，不移动、不挖掘、不放置，读完即停止。';
const notes = '这份做法只确认当前脚下的观察结果，不能把未知格子当作空气。';
const behavior = { code: 'return (await api.state()).feet;', verify: 'const s = await api.state(); return true;' };

test('补充笔记保留候选契约和版本，重载、晋升后仍可读', (t) => {
  const { directory, book, engine } = setup(t);
  assert.ok(book.write('observe-feet', '观察脚下位置', body, behavior, { candidate: true, version: 2 }).ok);
  const candidateFile = path.join(directory, 'observe-feet', 'candidate.json');
  const candidate = fs.readFileSync(candidateFile, 'utf8');
  const before = engine.get('observe-feet', true);
  assert.ok(book.write('observe-feet', '脚下观察的补充笔记', notes).ok);
  assert.equal(fs.readFileSync(candidateFile, 'utf8'), candidate);
  assert.equal(fs.existsSync(path.join(directory, 'observe-feet', 'SKILL.md')), false);
  book.reload();
  assert.equal(engine.get('observe-feet', true)?.version, before?.version);
  assert.equal(engine.get('observe-feet', true)?.code, before?.code);
  assert.equal(book.candidate('observe-feet')?.notes, notes);
  assert.ok(book.promote('observe-feet'));
  book.reload();
  assert.equal(book.get('observe-feet')?.notes, notes);
  assert.equal(engine.get('observe-feet')?.version, 2);
  assert.equal(engine.get('observe-feet')?.candidate, undefined);
});

test('纯文字技能在索引里明确标为未验证，不会伪装成已验证策略', (t) => {
  const { book } = setup(t);
  assert.ok(book.write('observe-feet', '观察脚下位置', notes).ok);
  assert.match(book.index().join('\n'), /observe-feet（自写）：［文字（未验证）］/, '文字笔记需要标明未验证');
});

test('同名正式版和候选共享笔记，纯文字转为行为后笔记也不会丢失', (t) => {
  const { directory, book, engine } = setup(t);
  assert.ok(book.write('observe-feet', '观察脚下的文字做法', notes).ok);
  assert.ok(book.write('observe-feet', '观察脚下位置', body, behavior, { candidate: true, version: 1 }).ok);
  assert.equal(book.get('observe-feet')?.notes, notes, '转为候选后无需重载就能读到原笔记');
  assert.equal(book.candidate('observe-feet')?.notes, notes);
  assert.ok(book.promote('observe-feet'));
  assert.equal(book.get('observe-feet')?.notes, notes);
  assert.ok(book.write('observe-feet', '候选的观察做法', body, { ...behavior, code: 'return (await api.state()).hp;' }, { candidate: true, version: 2 }).ok);
  const codeFile = path.join(directory, 'observe-feet', 'code.js');
  const revised = notes + ' 新观察：需要分别记录每次看到的高度。';
  assert.ok(book.write('observe-feet', '修订后的学习笔记', revised).ok);
  book.reload();
  assert.equal(fs.readFileSync(codeFile, 'utf8'), behavior.code);
  assert.equal(engine.get('observe-feet')?.version, 1);
  assert.equal(engine.get('observe-feet', true)?.version, 2);
  assert.equal(book.get('observe-feet')?.notes, revised);
  assert.equal(book.candidate('observe-feet')?.notes, revised);
  assert.ok(book.promote('observe-feet', 1));
  book.reload();
  assert.equal(book.get('observe-feet')?.notes, revised);
  assert.equal(engine.get('observe-feet')?.code, 'return (await api.state()).hp;');
});

test('后台改进接收已有正文、笔记及调度约束', async (t) => {
  const { book, engine, bus } = setup(t);
  assert.ok(engine.write({ name: 'observe-feet', description: '观察脚下位置', body, ...behavior, priority: 37, cooldown_s: 45 }).ok);
  assert.ok(book.write('observe-feet', '观察脚下位置', notes).ok);
  let resolve!: () => void;
  const completed = new Promise<void>((done) => { resolve = done; });
  const planner = { autonomous: true, noteInvalid() {}, async complete(messages: { role: string; content: string }[]) {
    const { skill } = JSON.parse(messages[1].content.split('\n\n')[0]);
    assert.equal(skill.body, body);
    assert.equal(skill.notes, notes);
    assert.equal(skill.priority, 37);
    assert.equal(skill.cooldown_s, 45);
    assert.deepEqual(skill.overrides, []);
    resolve();
    return { text: '{"keep":true}', latencyMs: 1 };
  } };
  const improver = new CodeImprover(planner, engine, bus);
  assert.equal(improver.consider('observe-feet', 'requested'), null);
  await completed;
});

test('自写的纯文字技能被想起时标明未验证，不会和可执行技能混在一起', async (t) => {
  const { book } = setup(t);
  assert.ok(book.write('observe-feet', '观察脚下位置', notes).ok);
  const { SelfModel } = await import('../src/mind/self.ts');
  const { WorldMemory } = await import('../src/memory/store.ts');
  const { recallLocal } = await import('../src/mind/recall.ts');
  const memory = new WorldMemory(null);
  const recalled = recallLocal('观察脚下位置', { self: new SelfModel(null), memory, book });
  memory.close();
  const skill = recalled.find((r) => r.ref === 'observe-feet');
  assert.ok(skill, '文字笔记仍可被想起');
  assert.match(skill.text, /未验证的文字笔记/);
});
