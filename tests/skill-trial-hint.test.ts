import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-trial-hint-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

test('动作失败时提示正管这类失败的候选试用，十分钟内不重复', async (t) => {
  const directory = tmp();
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write({
    name: 'pad-before-step',
    description: '迈步因脚下踩不住失败时先垫一块',
    when: { after_failure: { skill: ['move_step'], code: ['PATH_NOT_FOUND'] } },
    code: 'return 1;',
    verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";',
  }, { by: 'mind' }).ok);
  const planner = { autonomous: true, noteInvalid() {}, async complete() { return { text: '{"none":true,"why":"测试不写"}', latencyMs: 1 }; } };
  const smith = new SkillSmith(planner as unknown as ConstructorParameters<typeof SkillSmith>[0], engine, book, bus, () => adapter.state());
  smith.start();
  t.after(() => smith.stop());
  const fail = () => bus.publish('task_end', 'P1', '[llm] move_step → failed(PATH_NOT_FOUND)：踩不住', {
    status: 'failed', skill: 'move_step', failureCode: 'PATH_NOT_FOUND', source: 'llm',
  });
  fail();
  await flush();
  const hints = bus.recent().filter((event) => event.type === 'skill_hint');
  assert.equal(hints.length, 1, '失败当下提示一次');
  assert.match(hints[0].msg, /pad-before-step/);
  assert.match(hints[0].msg, /"trial":true/);
  assert.match(hints[0].msg, /是否试、何时试由你决定/);
  fail();
  await flush();
  assert.equal(bus.recent().filter((event) => event.type === 'skill_hint').length, 1, '同一候选同一失败码十分钟内不刷屏');
  bus.publish('task_end', 'P1', '[llm] move_step → failed(OTHER)：别的原因', {
    status: 'failed', skill: 'move_step', failureCode: 'OTHER', source: 'llm',
  });
  await flush();
  assert.equal(bus.recent().filter((event) => event.type === 'skill_hint').length, 1, '不覆盖的失败码不提示');
});
