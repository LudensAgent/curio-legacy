import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { GameAdapter } from '../src/adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { Attention } from '../src/mind/attention.ts';
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-stall-'));
  const adapter = new FakeAdapter();
  adapter.hp = 5;
  adapter.entities = [{ id: 7, name: 'skeleton', kind: 'hostile', dist: 4.4, pos: { x: 4, y: 64, z: 0 }, perception: 'seen' }];
  const bus = new EventBus();
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  bus.on('event', (ev: { type: string; data?: Record<string, unknown> }) => events.push(ev));
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
  const fire = () => {
    const before = tasks.length;
    assert.equal(engine.tick(null, now), true);
    assert.equal(tasks.length, before + 1);
    const result: SkillResult = { status: 'succeeded', summary: '举盾完成了', data: { verified: true, result: {} } };
    done?.({ task: tasks.at(-1)!, result, durationMs: 5_000 });
  };
  const cleanup = () => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); };
  return { engine, adapter, bus, events, tasks, fire, cleanup,
    get now() { return now; }, set now(v: number) { now = v; } };
}

test('触发处境仍在且血量/距离/位置/背包都没有改善：连续两次后暂停自动接手', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 13_000;
  assert.equal(w.engine.tick(null, w.now), false); // 冷却中；同时做第一次事后观测
  const first = w.events.filter((e) => e.type === 'skill_aftermath').at(-1);
  assert.equal(first?.data?.stalled, 1);
  assert.equal(first?.data?.still, true);
  assert.equal(first?.data?.hp, 5);
  assert.equal(first?.data?.nearest, 4.4);

  w.now += 47_000;
  w.fire(); // 第二次实际运行：冷却已过，条件仍成立
  w.now += 13_000;
  assert.equal(w.engine.tick(null, w.now), false, '暂停后不应再自动接手');
  assert.equal(w.tasks.length, 2);
  assert.deepEqual(w.engine.heldNow(w.now), ['shield-stall']);
  const stalled = w.events.find((e) => e.type === 'skill_stalled');
  assert.equal(stalled?.data?.stalled, 2);
  assert.equal(stalled?.data?.still, true);
  assert.equal(stalled?.data?.hp, 5);
  assert.equal(stalled?.data?.nearest, 4.4);
  assert.match(String(stalled?.data?.name), /shield-stall/);
});

test('触发处境解除后，旧的无进展计数不再延续', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 13_000;
  assert.equal(w.engine.tick(null, w.now), false);
  assert.equal(w.events.filter((e) => e.type === 'skill_aftermath').at(-1)?.data?.stalled, 1);

  w.adapter.entities = [];
  w.now += 47_000; // 超过冷却：条件不成立，tick 会清掉旧计数
  assert.equal(w.engine.tick(null, w.now), false);
  w.adapter.entities = [{ id: 7, name: 'skeleton', kind: 'hostile', dist: 4.4, pos: { x: 4, y: 64, z: 0 }, perception: 'seen' }];
  w.now += 60_000;
  w.fire();
  w.now += 13_000;
  assert.equal(w.engine.tick(null, w.now), false);
  assert.equal(w.events.filter((e) => e.type === 'skill_aftermath').at(-1)?.data?.stalled, 1, '解除后重新从第一次算');
  assert.equal(w.events.some((e) => e.type === 'skill_stalled'), false);
});

test('forgetStats 会清掉无进展计数', (t) => {
  const w = setup(t);
  t.after(w.cleanup);
  w.fire();
  w.now += 13_000;
  assert.equal(w.engine.tick(null, w.now), false);
  assert.equal(w.events.filter((e) => e.type === 'skill_aftermath').at(-1)?.data?.stalled, 1);

  w.engine.forgetStats(['shield-stall']);
  w.now += 47_000;
  w.fire();
  w.now += 13_000;
  assert.equal(w.engine.tick(null, w.now), false);
  assert.equal(w.events.filter((e) => e.type === 'skill_aftermath').at(-1)?.data?.stalled, 1, '清掉后重新从第一次算');
  assert.equal(w.events.some((e) => e.type === 'skill_stalled'), false);
});

test('无进展事件进入注意力', () => {
  const attention = new Attention();
  const n = attention.fromEvent({ ts: Date.now(), type: 'skill_stalled', severity: 'P2',
    msg: '技能「shield」连续 2 次触发后，触发它的情况还在；血量、最近威胁距离、位置和背包都没有改善',
    data: { name: 'shield', hp: 5, nearest: 4.4, still: true, streak: 2 } });
  assert.ok(n);
  assert.match(n!.what, /触发它的情况还在/);
});

for (const [label, improve] of [
  ['血量回升', (w: ReturnType<typeof setup>) => { w.adapter.hp = 6; }],
  ['威胁距离拉开', (w: ReturnType<typeof setup>) => { w.adapter.entities[0]!.dist = 6.5; }],
  ['位置移动', (w: ReturnType<typeof setup>) => { w.adapter.pos.x += 2; }],
  ['背包变化', (w: ReturnType<typeof setup>) => { w.adapter.inv.set('torch', 1); }],
] as const) {
  test(`出现可观察改善（${label}）时不累计无进展`, (t) => {
    const w = setup(t);
    t.after(w.cleanup);
    w.fire();
    improve(w);
    w.now += 13_000;
    assert.equal(w.engine.tick(null, w.now), false);
    assert.equal(w.events.filter((e) => e.type === 'skill_aftermath').at(-1)?.data?.stalled, undefined, '改善不应累计无进展');
    assert.equal(w.events.some((e) => e.type === 'skill_stalled'), false);
    assert.deepEqual(w.engine.heldNow(w.now), []);
  });
}
