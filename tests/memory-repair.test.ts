import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairMemoryData } from '../src/maintenance/memory-repair.ts';

const now = 1_800_000_000_000;
const world = {
  version: 3, worldId: 'w', unrelated: { keep: true },
  landmarks: [{ id: 'box', kind: 'discovery', label: '箱子', worldId: 'w', dim: 'overworld', pos: { x: 17, y: 64, z: 19 }, ts: now - 3600_000 }],
  chests: { 'w:overworld:17,64,19': { worldId: 'w', dim: 'overworld', pos: { x: 17, y: 64, z: 19 }, uses: 2, ts: now - 3600_000,
    traces: [{ item: 'coal', kind: 'put', qty: 'some', ts: now - 3600_000, op: 1, times: 1 }] } },
  notes: [{ worldId: 'w', dimension: 'overworld', ts: now - 3600_000, kind: 'fact', text: '箱子 (17,64,19) 放过 coal×12' }],
  goals: [{ worldId: 'w', dimension: 'overworld', ts: now - 3600_000, goal: '翻箱子 (17,64,19)', summary: '箱子里 coal×12' }],
  lessons: [{ worldId: 'w', ts: now, source: 'model', text: '箱子 (17,64,19) 有 coal×12' }],
};

test('world repair projects only historical prose and preserves structured observations and timestamps', () => {
  const before = structuredClone(world), result = repairMemoryData(world, { kind: 'world', worldId: 'w', now });
  const data = result.data as typeof world;
  assert.deepEqual(world, before, 'the caller input remains untouched');
  assert.deepEqual(data.chests, world.chests); assert.deepEqual(data.landmarks, world.landmarks);
  assert.deepEqual(data.unrelated, world.unrelated);
  assert.equal(data.notes[0].ts, world.notes[0].ts);
  assert.match(data.notes[0].text, /历史容器区域/); assert.doesNotMatch(data.notes[0].text, /coal×12|\(17,64,19\)/);
  assert.equal(result.changed.texts, 4); assert.equal(result.changed.quarantined, 0);
  const twice = repairMemoryData(data, { kind: 'world', worldId: 'w', now });
  assert.deepEqual(twice.data, data); assert.equal(twice.changed.texts, 0);
});

test('episode repair quarantines unknown scope and distant discoveries without inventing facts', () => {
  const episode = { id: 'e', worldId: 'w', dimension: 'overworld', ts: now, kind: 'inference', source: 'lesson', text: '箱子 (17,64,19) 有 coal×12', sourceObservation: 'original' };
  const input = [episode, { ...episode, id: 'unknown', dimension: 'unknown' }, { ...episode, id: 'other-world', worldId: 'other' },
    { ...episode, id: 'far', kind: 'experience', source: 'discovery', text: '首次看见方块：iron_ore（90 格外）' }];
  const result = repairMemoryData(input, { kind: 'episodes', worldId: 'w', worldMemory: world, now });
  const data = result.data as typeof input;
  assert.equal(data.length, 1); assert.equal(data[0].id, 'e'); assert.equal(data[0].ts, now);
  assert.equal(data[0].sourceObservation, 'original'); assert.match(data[0].text, /历史容器区域/);
  assert.deepEqual(result.quarantine.map((entry) => entry.reason), ['unverified_dimension', 'unverified_world', 'discovery_beyond_64_blocks']);
  assert.deepEqual(result.quarantine[0].value, input[1]);
  const twice = repairMemoryData(data, { kind: 'episodes', worldId: 'w', worldMemory: world, now });
  assert.deepEqual(twice.data, data); assert.deepEqual(twice.changed, { texts: 0, quarantined: 0 });
});

test('mind repair leaves current intentions, plans, code and action arguments unchanged', () => {
  const input = { version: 1, agenda: [{ text: '去箱子 (17,64,19)', args: { target: [17, 64, 19] } }], plan: { goal: '箱子 (17,64,19)', code: 'return 12;' },
    knowHow: [{ id: 'k', text: '箱子 (17,64,19) 有 coal×12', updatedAt: now }], diary: [{ at: now, text: '箱子 (17,64,19) 有 coal×12' }],
    history: [{ at: now - 3600_000, what: '翻箱子 (17,64,19)', summary: '箱子有 coal×12', routine: [{ skill: 'take_items', args: { target: [17, 64, 19], count: 12 } }] }] };
  const result = repairMemoryData(input, { kind: 'mind', worldId: 'w', worldMemory: world, now });
  const data = result.data as typeof input;
  assert.deepEqual(data.agenda, input.agenda); assert.deepEqual(data.plan, input.plan);
  assert.deepEqual(data.history[0].routine, input.history[0].routine);
  assert.equal(data.knowHow[0].updatedAt, now); assert.match(data.knowHow[0].text, /历史容器区域/);
  assert.deepEqual(repairMemoryData(data, { kind: 'mind', worldId: 'w', worldMemory: world, now }).data, data);
});

test('repair rejects an unknown document shape or a different identity before projection', () => {
  assert.throws(() => repairMemoryData(null, { kind: 'world', worldId: 'w', now }), /version 3/);
  assert.throws(() => repairMemoryData({ ...world, worldId: 'other' }, { kind: 'world', worldId: 'w', now }), /selected world/);
  assert.throws(() => repairMemoryData({ ...world, notes: [{ text: 12 }] }, { kind: 'world', worldId: 'w', now }), /history text/);
});
