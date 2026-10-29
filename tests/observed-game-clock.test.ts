import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { AgentState } from '../src/adapter/types.ts';
import { GAME_DAY_TICKS, ObservedGameClock } from '../src/codeskills/game-clock.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { FakeAdapter } from './fake-adapter.ts';

const state = (age: number | undefined, patch: Partial<AgentState> = {}): AgentState => ({
  ...new FakeAdapter().state(), worldAgeTicks: age, ...patch,
});

test('game clock counts observed server age, not sleep or daylight changes', () => {
  const clock = new ObservedGameClock();
  assert.equal(clock.worldId, null);
  clock.observe(state(100, { timeOfDay: 13_000, worldDay: 4 }), false, 0);
  clock.observe(state(120, { timeOfDay: 0, worldDay: 5 }), false, 1_000);
  clock.observe(state(140, { timeOfDay: 12_000, worldDay: 500 }), false, 2_000);
  clock.observe(state(140, { timeOfDay: 0, worldDay: 0 }), false, 3_000);
  assert.equal(clock.ticks(), 40);
  assert.equal(clock.ticks('overworld'), 40);
  assert.equal(clock.ticks('the_end'), 0);
  assert.equal(GAME_DAY_TICKS, 24_000);
});

test('pauses, invalid observations and lifecycle resets never bridge unobserved intervals', () => {
  const interruptions = [
    { patch: {}, paused: true },
    { patch: { connected: false }, paused: false },
    { patch: { alive: false }, paused: false },
    { patch: { observationReady: false }, paused: false },
  ];
  for (const { patch, paused } of interruptions) {
    const clock = new ObservedGameClock();
    clock.observe(state(100), false, 0);
    clock.observe(state(120), false, 1_000);
    clock.observe(state(140, patch), paused, 2_000);
    clock.observe(state(1_000), false, 3_000);
    assert.equal(clock.ticks(), 20);
    clock.observe(state(1_020), false, 4_000);
    assert.equal(clock.ticks(), 40);
    // Pause/resume or death/spawn may both occur between the two samples.
    clock.resetBaseline();
    clock.observe(state(2_000), false, 5_000);
    assert.equal(clock.ticks(), 40);
  }
  const clock = new ObservedGameClock();
  clock.observe(state(10), false, 0);
  clock.observe(state(20, { connected: false, worldId: 'unknown-world' }), false, 1_000);
  assert.equal(clock.worldId, 'fake-world');
});

test('worlds and dimensions retain independent totals while transitions reset continuity', () => {
  const clock = new ObservedGameClock();
  clock.observe(state(0), false, 0);
  clock.observe(state(20), false, 1_000);
  clock.observe(state(500, { sessionId: 'reconnected' }), false, 2_000);
  clock.observe(state(530, { sessionId: 'reconnected' }), false, 3_000);
  clock.observe(state(600, { dim: 'the_nether', sessionId: 'nether' }), false, 4_000);
  clock.observe(state(640, { dim: 'the_nether', sessionId: 'nether' }), false, 5_000);
  assert.equal(clock.ticks(), 90);
  assert.equal(clock.ticks('overworld'), 50);
  assert.equal(clock.ticks('the_nether'), 40);
  clock.observe(state(700, { worldId: 'second-world' }), false, 6_000);
  assert.equal(clock.worldId, 'second-world');
  assert.equal(clock.ticks(), 0);
  clock.observe(state(750, { worldId: 'second-world' }), false, 7_000);
  assert.equal(clock.ticks(), 50);
  clock.observe(state(900), false, 8_000);
  assert.equal(clock.ticks(), 90);
  clock.observe(state(920), false, 9_000);
  assert.equal(clock.ticks(), 110);
  // Also reject dimension changes when an adapter has not changed its session ID.
  clock.observe(state(1_000, { dim: 'the_end' }), false, 10_000);
  assert.equal(clock.ticks('the_end'), 0);
});

test('long sampling gaps, backward clocks and unavailable server ages do not fabricate elapsed ticks', () => {
  const clock = new ObservedGameClock();
  clock.observe(state(0), false, 0);
  clock.observe(state(100), false, 5_000);
  clock.observe(state(1_000), false, 10_001);
  clock.observe(state(1_020), false, 11_001);
  assert.equal(clock.ticks(), 120);
  clock.observe(state(1_040), false, 10_000);
  clock.observe(state(1_060), false, 11_000);
  assert.equal(clock.ticks(), 140);
  clock.observe(state(10), false, 12_000);
  clock.observe(state(30), false, 13_000);
  assert.equal(clock.ticks(), 160);
  for (const age of [undefined, -1, NaN, Infinity]) {
    clock.observe(state(age), false, 14_000);
    clock.observe(state(1_000), false, 15_000);
    assert.equal(clock.ticks(), 160);
  }
  clock.observe(state(1_020), false, 16_000);
  assert.equal(clock.ticks(), 180);
});

test('persistence restores totals but never resumes an earlier sampling baseline', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'observed-game-clock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'nested', 'clock.json');
  const clock = new ObservedGameClock(file);
  clock.observe(state(100), false, 0);
  clock.observe(state(120), false, 1_000);
  clock.observe(state(200, { dim: 'the_end' }), false, 2_000);
  clock.observe(state(230, { dim: 'the_end' }), false, 3_000);
  clock.save();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    version: 1, worlds: { 'fake-world': { totalTicks: 50, dimensions: { overworld: 20, the_end: 30 } } },
  });
  const restored = new ObservedGameClock(file);
  assert.equal(restored.loadError, null);
  assert.equal(restored.worldId, null);
  assert.equal(restored.ticks(), 0);
  restored.observe(state(999_000), false, 4_000);
  assert.equal(restored.ticks(), 50);
  restored.observe(state(999_020), false, 5_000);
  assert.equal(restored.ticks(), 70);
  assert.equal(restored.ticks('overworld'), 40);
  assert.equal(restored.ticks('the_end'), 30);
  const snapshot = restored.snapshot();
  snapshot.worlds['fake-world'].totalTicks = 0;
  snapshot.worlds['fake-world'].dimensions.overworld = 0;
  assert.equal(restored.ticks(), 70);
  assert.equal(restored.ticks('overworld'), 40);
});

test('disk schema is validated once and corrupt snapshots are rejected as a whole', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'observed-game-clock-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'clock.json');
  assert.equal(new ObservedGameClock(file).loadError, null);
  for (const data of [
    '{', 'null', JSON.stringify({ version: 2, worlds: {} }),
    JSON.stringify({ version: 1, worlds: [] }),
    JSON.stringify({ version: 1, worlds: { 'fake-world': { totalTicks: -1, dimensions: {} } } }),
    JSON.stringify({ version: 1, worlds: { 'fake-world': { totalTicks: 10, dimensions: { overworld: '10' } } } }),
    JSON.stringify({ version: 1, worlds: {
      'fake-world': { totalTicks: 10, dimensions: { overworld: 10 } },
      'broken-world': { totalTicks: 20, dimensions: null },
    } }),
  ]) {
    writeFileSync(file, data);
    const clock = new ObservedGameClock(file);
    assert.ok(clock.loadError);
    clock.observe(state(10), false, 0);
    assert.equal(clock.ticks(), 0);
    clock.observe(state(30), false, 1_000);
    assert.equal(clock.ticks(), 20);
  }
});

test('Mineflayer state exposes server age independently of daylight and omits unavailable ages', () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const time: { age: number | null; day: number; timeOfDay: number } = { age: 100, day: 4, timeOfDay: 13_000 };
  adapter.bot = {
    entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, health: 20,
    inventory: { items: () => [], emptySlotCount: () => 36, slots: [] },
    blockAt: () => ({ biome: { name: 'plains' } }), time,
  };
  adapter.mcData = { itemsByName: {} };
  Reflect.set(adapter, 'connectedFlag', true);
  Reflect.set(adapter, 'spawned', true);
  assert.equal(adapter.state().worldAgeTicks, 100);
  time.day = 500;
  time.timeOfDay = 0;
  time.age = 120;
  assert.equal(adapter.state().worldAgeTicks, 120);
  for (const age of [null, -1, NaN, Infinity]) {
    time.age = age;
    assert.ok(!('worldAgeTicks' in adapter.state()));
  }
});
