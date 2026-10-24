import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentState, GameAdapter, Vec3Like } from '../src/adapter/types.ts';
import { constructBuilding, inspectBuilding } from '../src/building/engine.ts';
import { cellKey, compileBuilding, materialCost, normalizeSpec, rotatePosition } from '../src/building/spec.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildingArchive, buildingArchiveFor, describeBuildProblems } from '../src/skills/build.ts';
import type { SkillCtx } from '../src/skills/types.ts';

// One structural cell plus one clearance: only inspect/repair decisions, no game loop or house simulation.
function fixture(t: TestContext) {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  const spec = normalizeSpec({ layout: 'custom', components: [{ pos: { x: 0, y: 0, z: 0 }, name: 'stone' }] });
  const blueprint = { ...compileBuilding(spec), clearances: [{ x: 1, y: 0, z: 0 }] };
  const archive = buildingArchiveFor(memory);
  const project = archive.design({ worldId: 'w', dimension: 'overworld', origin: { x: -224, y: 87, z: 11 }, rotation: 90, spec, materials: materialCost(blueprint.cells) });
  const at = (pos: Vec3Like) => rotatePosition(pos, project.origin, project.rotation);
  const structural = at(blueprint.cells[0].pos), clearance = at(blueprint.clearances[0]);
  const blocks = new Map<string, string>([[cellKey(structural), 'stone']]);
  const actions: string[] = [];
  const state: AgentState = {
    connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1,
    username: 'test', pos: { x: -226, y: 87, z: 11 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20,
    timeOfDay: 1000, isDay: true, biome: null, onGround: true, inWater: false, inLava: false,
    inventory: [{ name: 'stone', count: 1 }], emptySlots: 36, held: null,
  };
  const adapter = {
    state: () => state,
    blockAt: (pos: Vec3Like) => blocks.get(cellKey(pos)) ?? 'air',
    lightAt: () => ({ block: 14, sky: 0 }),
    moveTo: async () => { actions.push('move'); },
    dig: async (pos: Vec3Like) => { actions.push(`dig:${blocks.get(cellKey(pos))}`); blocks.delete(cellKey(pos)); return { ok: true }; },
    placeBlockAt: async (pos: Vec3Like, names: string[]) => { actions.push(`place:${names[0]}`); blocks.set(cellKey(pos), names[0]); return { ok: true }; },
    collectNearbyDrops: async () => 0,
  } as unknown as GameAdapter;
  const ctx: SkillCtx = { adapter, memory, bus: new EventBus(), signal: new AbortController().signal,
    taskId: 'repair-test', deadline: Date.now() + 30_000, progress() {},
    senses: { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} },
  };
  return { adapter, archive, project, blueprint, blocks, structural, clearance, actions, ctx };
}

test('inspection accepts small passable furnishings but still rejects actual obstructions', (t) => {
  const w = fixture(t);
  for (const name of ['torch', 'soul_wall_torch', 'white_carpet', 'oak_button']) {
    w.blocks.set(cellKey(w.clearance), name);
    assert.equal(inspectBuilding(w.adapter, w.blueprint, w.project).complete, true, name);
  }
  for (const name of ['cobblestone', 'oak_fence', 'oak_trapdoor', 'chest', 'snow', 'water', 'campfire']) {
    w.blocks.set(cellKey(w.clearance), name);
    const result = inspectBuilding(w.adapter, w.blueprint, w.project);
    assert.equal(result.complete, false, name);
    assert.equal(result.defects[0].actual, name);
  }
});

test('repair of an intact decorated building performs no terrain clearing or placement', async (t) => {
  const w = fixture(t);
  w.blocks.set(cellKey(w.clearance), 'torch');
  const result = await constructBuilding(w.ctx, w.archive, w.project, w.blueprint, 'repair');
  assert.equal(result.inspection.complete, true);
  assert.equal(result.cleared, 0);
  assert.equal(result.placed, 0);
  assert.deepEqual(w.actions, [], 'verify before starting terrain preparation');
  assert.equal(w.blocks.get(cellKey(w.clearance)), 'torch');
  assert.equal(w.archive.get(w.project.id)?.status, 'complete');
});

test('repair preserves clearance furnishings while replacing a torch occupying a structural cell', async (t) => {
  const w = fixture(t);
  w.blocks.set(cellKey(w.clearance), 'white_carpet');
  w.blocks.set(cellKey(w.structural), 'torch');
  const result = await constructBuilding(w.ctx, w.archive, w.project, w.blueprint, 'repair');
  assert.equal(result.inspection.complete, true, JSON.stringify(result));
  assert.equal(result.placed, 1);
  assert.deepEqual(w.actions.filter((a) => a.startsWith('dig:')), ['dig:torch']);
  assert.equal(w.blocks.get(cellKey(w.clearance)), 'white_carpet');
  assert.equal(w.blocks.get(cellKey(w.structural)), 'stone');
});

test('unowned obstruction feedback and archive summary retain exact rotated defect coordinates', async (t) => {
  const w = fixture(t);
  w.blocks.set(cellKey(w.clearance), 'cobblestone');
  const result = await constructBuilding(w.ctx, w.archive, w.project, w.blueprint, 'repair');
  assert.equal(result.inspection.complete, false);
  assert.ok(!w.actions.some((a) => a.startsWith('dig:')), 'unknown ownership does not authorize demolition');
  const point = `(${w.clearance.x},${w.clearance.y},${w.clearance.z})`;
  assert.ok(result.failures[0].reason.includes(point));
  const summary = describeBuildProblems(result);
  assert.ok(summary.includes(point));
  assert.match(summary, /expected=.*actual=cobblestone/);
  assert.match(summary, /mode:"inspect"/);
  const read = await buildingArchive.run(w.ctx, { operation: 'read', projectId: w.project.id });
  assert.ok(read.summary.includes(point), read.summary);
  assert.match(read.summary, /actual=cobblestone/);
  assert.match(read.summary, /历史记录/);
});
