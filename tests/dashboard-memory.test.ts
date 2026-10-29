import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { dashboardMemory } from '../src/observer/memory-snapshot.ts';

const pos = { x: 10, y: 64, z: 10 };
const dimensions = ['overworld', 'the_nether', 'the_end'];

function populate(memory: WorldMemory, worldId: string) {
  memory.setWorld(worldId);
  dimensions.forEach((dim) => {
    memory.addLandmark('resource', 'iron_ore', dim, pos);
    memory.addLandmark('danger', 'lava', dim, pos);
    memory.addLandmark('discovery', '我的熔炉', dim, pos);
    memory.noteHerd('wolf', dim, pos, 2);
    memory.noteChestUse(dim, pos, { put: [{ name: 'coal', count: 64 }], day: 1 });
    memory.addHazard({ dim, pos, kind: 'fall' });
    memory.addFarm({ id: `${worldId}:${dim}`, dim, crop: 'wheat', cells: [pos], harvests: 0, plantedAt: Date.now() });
    memory.savePassage({ id: `${worldId}:${dim}`, worldId, dim, entrances: [pos], path: [pos], deepestY: 64,
      dug: 4, ores: {}, createdAt: Date.now(), lastUsedAt: Date.now(), uses: 1 });
    memory.addNote('fact', `${worldId}:${dim}`, dim, pos);
    memory.recordGoal({ dimension: dim, goal: `${worldId}:${dim}`, goalType: 'explore', source: 'test', status: 'succeeded', summary: dim });
  });
}

test('dashboard memory keeps identical coordinates in separate dimensions and excludes other worlds', (t) => {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  populate(memory, 'other-world');
  populate(memory, 'current-world');

  dimensions.forEach((dim) => {
    const snapshot = dashboardMemory(memory, { worldId: 'current-world', dim, pos, worldDay: 1 }, 0);
    assert.equal(snapshot.worldId, 'current-world');
    assert.equal(snapshot.dimension, dim);
    [snapshot.landmarks, snapshot.resources, snapshot.creatures, snapshot.chests, snapshot.passages, snapshot.facilities, snapshot.hazards]
      .forEach((records) => {
        assert.ok(records.length > 0);
        assert.ok(records.every((record) => record.worldId === 'current-world' && record.dim === dim));
      });
    assert.equal(snapshot.chests.length, 1);
    assert.match(snapshot.chests[0].text, /coal/);
    assert.match(snapshot.chests[0].text, /coal×64/);
    assert.deepEqual(snapshot.farms.map((farm) => farm.dim), [dim]);
    assert.deepEqual(snapshot.notes.map((note) => note.text), [`current-world:${dim}`]);
    assert.deepEqual(snapshot.goals.map((goal) => goal.goal), [`current-world:${dim}`]);
    assert.deepEqual(snapshot.dimensions, dimensions.map((name) => ({ dim: name, landmarks: 4, resources: 1,
      creatures: 1, chests: 1, passages: 1, facilities: 2, hazards: 2 })));
  });
});

test('dashboard retains shared notes and goals without presenting another dimension as current', (t) => {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  populate(memory, 'w');
  memory.addNote('inference', '未标注维度的经验');
  memory.recordGoal({ goal: '未标注维度的经历', goalType: 'explore', source: 'test', status: 'succeeded', summary: 'shared' });
  const snapshot = dashboardMemory(memory, { worldId: 'w', dim: 'the_nether', pos }, null);
  assert.deepEqual(snapshot.notes.map((note) => note.dimension), ['the_nether', undefined]);
  assert.deepEqual(snapshot.goals.map((goal) => goal.dimension), ['the_nether', undefined]);
  assert.equal(snapshot.facingYaw, null);
});

test('dashboard clears spatial records when the Agent world differs from the loaded memory', (t) => {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  populate(memory, 'old-world');
  const snapshot = dashboardMemory(memory, { worldId: 'new-world', dim: 'the_nether', pos }, null);
  [snapshot.landmarks, snapshot.resources, snapshot.creatures, snapshot.chests, snapshot.passages, snapshot.facilities,
    snapshot.hazards, snapshot.farms, snapshot.notes, snapshot.goals].forEach((records) => assert.deepEqual(records, []));
  assert.ok(snapshot.dimensions.every((summary) => Object.entries(summary).every(([key, value]) => key === 'dim' || value === 0)));
});
