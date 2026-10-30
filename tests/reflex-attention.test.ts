import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentState, EntityInfo, GameAdapter } from '../src/adapter/types.ts';
import type { Arbiter, Step, TaskInfo, TaskSource } from '../src/arbiter/arbiter.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import type { Senses } from '../src/skills/types.ts';

// Decision-only fixture: no skill execution, game simulation, timers or real waiting.
function fixture(t: TestContext, options: { routineCare?: boolean; habits?: () => { torch_every?: number } } = {}) {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const state: AgentState = {
    connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1,
    username: 'test', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20,
    timeOfDay: 1000, isDay: true, biome: null, onGround: true, inWater: false, inLava: false,
    inventory: [], emptySlots: 36, held: null,
  };
  let current: TaskInfo | null = null;
  const setTask = (skill: string, source: TaskSource = 'llm', progress = 0, age = 3000): TaskInfo => current = {
    id: `task-${skill}`, planVersion: 1, skill, args: {}, source, progress, note: '',
    startedAt: now - age, deadline: now + 60_000, movement: false,
  };
  let entities: EntityInfo[] = [];
  const cave = { dark: true };
  const starts: { step: Step; gentle?: boolean }[] = [];
  const cancellations: { reason: string; code?: string }[] = [];
  const adapter = {
    state: () => state,
    hasFood: () => state.inventory.some((i) => ['bread', 'beef'].includes(i.name) && i.count > 0),
    blockAt: ({ y }: { y: number }) => y < 64 || y === 67 ? 'stone' : 'air',
    lightAt: () => ({ block: cave.dark ? 0 : 12, sky: 0 }),
  } as unknown as GameAdapter;
  const arbiter = {
    paused: false, info: () => current,
    start: (step: Step, _source: TaskSource, meta: { gentle?: boolean } = {}) => {
      starts.push({ step, ...meta }); setTask(step.skill, 'reflex'); return current;
    },
    cancel: (reason: string, code?: string) => { cancellations.push({ reason, code }); current = null; },
  } as unknown as Arbiter;
  const senses: Senses = { perceivedEntities: () => entities, knownBlocks: () => [], refresh() {}, markSweep() {} };
  const reflex = new Reflex(adapter, arbiter, new EventBus(), senses, options);
  return { state, cave, starts, cancellations, setTask, setIdle: () => { current = null; }, tick: () => reflex.tick(), advance: (ms: number) => { now += ms; },
    hostile: (name: string, extra: Record<string, unknown> = {}) => { entities = [{ id: 42, name, kind: 'hostile', dist: 3, pos: { x: 3, y: 64, z: 0 }, ...extra }]; },
  };
}

test('intentional eating, defending and escaping continue without duplicate reflexes', (t) => {
  const w = fixture(t);
  w.state.hp = 11; w.state.food = 10; w.state.inventory = [{ name: 'bread', count: 2 }];
  w.setTask('eat'); w.tick();
  assert.equal(w.starts.length, 0, 'keep the meal already in progress');
  w.hostile('spider'); w.setTask('defend'); w.tick();
  assert.equal(w.starts.length, 0, 'keep the fight already in progress');
  w.state.hp = 6; w.tick();
  assert.equal(w.starts.at(-1)?.step.skill, 'flee', 'a worsening fight still escalates immediately');
  const n = w.starts.length;
  w.hostile('creeper'); w.setTask('flee'); w.tick();
  assert.equal(w.starts.length, n, 'keep running away from the creeper');
});

test('emergencies can interrupt an ongoing meal reflex immediately', (t) => {
  const w = fixture(t);
  w.setTask('eat', 'reflex'); w.hostile('creeper', { fusing: true }); w.tick();
  assert.equal(w.starts.length, 1);
  assert.equal(w.starts.at(-1)?.step.skill, 'flee');
});

test('routine meals wait for a suitable pause, while urgent hunger does not', (t) => {
  const w = fixture(t);
  w.state.food = 10; w.state.inventory = [{ name: 'bread', count: 2 }];
  w.setTask('goto', 'llm', 0, 100); w.tick();
  w.advance(2000); w.setTask('goto', 'llm', 0.95); w.tick();
  assert.equal(w.starts.length, 0, 'finish a short or nearly completed action before eating');
  w.setTask('goto'); w.tick();
  assert.equal(w.starts.at(-1)?.step.skill, 'eat');
  assert.equal(w.starts.at(-1)?.gentle, true);
  w.setTask('craft', 'llm', 0.95, 100); w.state.food = 5; w.advance(15000); w.tick();
  assert.equal(w.starts.length, 2, 'urgent hunger interrupts even focused work');
  assert.equal(w.starts.at(-1)?.step.skill, 'eat');
  assert.notEqual(w.starts.at(-1)?.gentle, true);
});

test('opted-in lighting waits for idle and does not run in daylight or while airborne', (t) => {
  const w = fixture(t, { habits: () => ({ torch_every: 8 }) });
  w.state.inventory = [{ name: 'torch', count: 8 }];
  w.setTask('goto'); w.tick();
  w.advance(500); w.cave.dark = false; w.tick();
  w.advance(1000); w.cave.dark = true; w.state.onGround = false; w.tick();
  w.state.onGround = true; w.setTask('look_around'); w.tick();
  w.setTask('goto', 'llm', 0.95); w.tick();
  assert.equal(w.starts.length, 0, 'do not cancel observation, a jump or the end of a walk');
  w.setTask('goto'); w.tick(); w.advance(800); w.tick();
  assert.equal(w.starts.length, 0, 'sustained darkness does not interrupt a walk');
  w.setIdle(); w.state.onGround = false; w.tick();
  assert.equal(w.starts.length, 0, 'do not place while airborne');
  w.state.onGround = true; w.cave.dark = false; w.tick();
  assert.equal(w.starts.length, 0, 'do not place when sufficiently lit');
  w.cave.dark = true; w.tick();
  assert.equal(w.starts.length, 1, 'idle darkness with the habit enabled gets light');
  assert.equal(w.starts[0].step.skill, 'place_torch');
  assert.equal(w.starts[0].gentle, true);
});

test('autonomous reflexes preserve routine choices and return stuck movement while retaining emergencies', (t) => {
  const w = fixture(t, { routineCare: false });
  w.state.inventory = [{ name: 'bread', count: 2 }, { name: 'torch', count: 8 }, { name: 'cobblestone', count: 4 }];
  w.state.food = 10; w.setTask('goto'); w.tick(); w.advance(1000); w.tick();
  assert.equal(w.starts.length, 0, 'routine hunger and sustained darkness do not take control');
  w.state.food = 20; w.state.hp = 7; w.state.isDay = false; w.tick();
  assert.equal(w.starts.length, 0, 'night and low health without a nearby enemy do not force shelter');
  w.state.hp = 20;
  w.setTask('goto', 'llm', 0, 21000).movement = true;
  w.tick(); w.advance(19000); w.tick();
  assert.equal(w.cancellations.at(-1)?.code, 'STUCK');
  assert.equal(w.starts.length, 0, 'stuck movement does not start digging or climbing');

  w.state.food = 6; w.setTask('craft'); w.tick();
  assert.equal(w.starts.at(-1)?.step.skill, 'eat', 'urgent hunger still interrupts');
  w.advance(15000); w.state.food = 16; w.state.hp = 7; w.setTask('craft'); w.tick();
  assert.equal(w.starts.at(-1)?.step.skill, 'eat', 'low health with insufficient food still interrupts');
  assert.equal(w.starts.length, 2);
  w.state.hp = 20; w.setTask('craft'); w.hostile('creeper', { fusing: true }); w.tick();
  assert.equal(w.starts.at(-1)?.step.skill, 'flee');
  w.setTask('craft'); w.hostile('spider'); w.tick();
  assert.equal(w.starts.at(-1)?.step.skill, 'defend');
});

test('苦力怕：打还是跑由脑子定；没响的苦力怕不打断，嘶嘶响才躲，正在跟它打时只后撤几步', (t) => {
  const w = fixture(t);
  w.state.hp = 20;
  w.setTask('hunt', 'llm'); w.hostile('creeper'); w.tick();
  assert.ok(!w.starts.some((x) => x.step.skill === 'flee'), '3 格外没响：交给脑子决定');
  w.setTask('defend', 'llm'); w.hostile('creeper', { fusing: true }); w.tick();
  const f = w.starts.at(-1)!;
  assert.equal(f.step.skill, 'flee');
  assert.equal((f.step.args as any).distance, 6, '正在打：后撤几步就行');
});
