import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { GameAdapter } from '../src/adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import type { Senses, SkillResult } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const behavior = {
  when: { hp_below: 10, hostile: { within: 24 } },
  code: 'return { ok: true };',
  verify: 'const s = await api.state(); return s.hp > 0 ? true : "死了";',
  priority: 80,
  cooldown_s: 30,
};

function setup(t: TestContext) {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-idle-streak-'));
  const adapter = new FakeAdapter();
  adapter.hp = 5;
  adapter.entities = [{ id: 7, name: 'skeleton', kind: 'hostile', dist: 4.4, pos: { x: 4, y: 64, z: 0 }, perception: 'seen' }];
  const bus = new EventBus();
  const book = new SkillBook(null, directory);
  assert.ok(book.write('shield-stall', '低血时有远程怪就举盾', '身体观察到的处境与结果', behavior).ok);
  const tasks: TaskInfo[] = [];
  let done: ((o: TaskOutcome) => void) | null = null;
  const arbiter = {
    info: () => null,
    on: (event: string, cb: (o: TaskOutcome) => void) => { if (event === 'done') done = cb; },
    off: () => {},
    start: (step: { skill: string; args?: unknown }, source: string) => {
      const task = { id: `t${tasks.length + 1}`, planVersion: tasks.length + 1, skill: step.skill, args: step.args, source, progress: 0,
        note: '', startedAt: now, deadline: now + 30_000, movement: false } as TaskInfo;
      tasks.push(task);
      return task;
    },
  } as unknown as Pick<Arbiter, 'start' | 'info' | 'on' | 'off'>;
  const senses = { perceivedEntities: () => adapter.entities, observeBlocks: () => [] } as unknown as Pick<Senses, 'perceivedEntities' | 'observeBlocks'>;
  const engine = new BehaviorEngine(book, adapter as unknown as GameAdapter, arbiter, bus, senses);
  const finish = (noop: boolean) => {
    const task = tasks.at(-1)!;
    const result: SkillResult = { status: 'succeeded', summary: noop ? '举盾但什么都没动' : '完成了', data: { verified: true, ...(noop ? { noop: true } : {}), result: {} } };
    done?.({ task, result, durationMs: 5_000 });
  };
  const fire = (noop = true) => {
    const before = tasks.length;
    assert.equal(engine.tick(null, now), true);
    assert.equal(tasks.length, before + 1);
    finish(noop);
  };
  const cleanup = () => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); };
  return { engine, adapter, bus, book, tasks, fire, cleanup,
    get now() { return now; }, set now(v: number) { now = v; } };
}

test('连续空转后不再因为威胁靠近或挨打而重新接手同一版本', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 91_000;
  w.fire();
  const afterTwo = w.tasks.length;
  assert.deepEqual(w.engine.heldNow(w.now), ['shield-stall']);

  // 已经超过冷却、威胁更近、刚挨打：连续空转后的暂停仍不应让同一版本重新接手。
  w.now += 35_000;
  w.adapter.entities[0]!.dist = 2.3;
  w.bus.publish('hurt', 'P2', '被箭射中');
  assert.equal(w.engine.tick(null, w.now), false);
  assert.equal(w.tasks.length, afterTwo);

  w.engine.forgetStats(['shield-stall']);
  assert.deepEqual(w.engine.heldNow(w.now), [], '忘掉技能时也清掉暂停');
  w.now += 31_000;
  w.fire();
  w.now += 31_000;
  w.bus.publish('hurt', 'P2', '被箭射中');
  assert.equal(w.engine.tick(null, w.now), true, '忘掉技能后第一次空转仍按首次空转处理');
});

test('第一次空转仍允许威胁靠近或挨打时重试', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 31_000;
  w.adapter.entities[0]!.dist = 2.3;
  w.bus.publish('hurt', 'P2', '被箭射中');
  assert.equal(w.engine.tick(null, w.now), true);
  assert.equal(w.tasks.length, 2);
});

test('产生实际效果后连续空转计数清零', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 91_000;
  w.fire(false); // 这一版产生了实际效果，不应继续累计上一次空转
  w.now += 31_000;
  w.fire(); // 新的第一次空转
  w.now += 31_000;
  w.adapter.entities[0]!.dist = 2.3;
  w.bus.publish('hurt', 'P2', '被箭射中');
  assert.equal(w.engine.tick(null, w.now), true, '实际效果后的首次空转仍可按原规则紧急重试');
});

test('新版重写会清掉旧版本的空转暂停，让新代码重新获得机会', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 91_000;
  w.fire();
  assert.deepEqual(w.engine.heldNow(w.now), ['shield-stall']);

  const rewritten = w.engine.write({
    name: 'shield-stall', description: '低血时有远程怪就举盾并后撤', body: '后撤版',
    when: behavior.when, code: 'await api.move({ back: true }, 100); return { ok: true };', verify: behavior.verify, priority: 80, cooldown_s: 30,
  });
  assert.ok(rewritten.ok);
  w.now += 31_000;
  assert.equal(w.engine.tick(null, w.now), true, '新版本不再被旧版本的暂停压住');
  assert.equal(w.tasks.length, 3);
});

test('从磁盘换上新版本时，旧版本的暂停不压住新版本', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 91_000;
  w.fire();
  assert.deepEqual(w.engine.heldNow(w.now), ['shield-stall']);

  // 直接写技能书（模拟回退/晋升等不经过 engine.write 的版本变化）：引擎重载后版本号变了，旧暂停不再生效。
  assert.ok(w.book.write('shield-stall', '低血时有远程怪就举盾并后撤', '后撤版', { ...behavior, version: 2 }, { version: 2 }).ok);
  w.now += 31_000;
  assert.equal(w.engine.tick(null, w.now), true);
});
