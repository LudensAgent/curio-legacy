import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildingArchive } from '../src/building/archive.ts';
import { constructBuilding, inspectBuilding, surveyFoundation } from '../src/building/engine.ts';
import { compileBuilding, materialCost, normalizeSpec, rotatePosition, rotateProperties, type BuildingBlueprint, type BuildingSpec } from '../src/building/spec.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { build, buildingArchive, buildingArchiveFor } from '../src/skills/build.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import { AbortedError, throwIfAborted } from '../src/util.ts';
import { planScaffolding } from '../src/building/scaffold.ts';
import { buildingReview } from '../src/skills/building-review.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** Immediate world mutations let the tests verify engineering logic without waiting on animation. */
class BuildingWorld extends FakeAdapter {
  failPlacement = false;
  placementCount = 0;
  afterPlacement?: () => void;
  constructor() { super(); this.speed = 100000; }
  override lightAt(x = 0, y = 64, z = 0) {
    let block = 0;
    for (const placed of this.blocks) if (placed.name === 'torch') block = Math.max(block, 14 - Math.abs(placed.pos.x - x) - Math.abs(placed.pos.y - y) - Math.abs(placed.pos.z - z));
    return { block, sky: y > this.groundY ? this.light : 0 };
  }
  setBlock(pos: Vec3Like, name: string) {
    this.blocks = this.blocks.filter((b) => b.pos.x !== pos.x || b.pos.y !== pos.y || b.pos.z !== pos.z);
    if (name === 'air') this.removed.add(`${pos.x},${pos.y},${pos.z}`);
    else { this.removed.delete(`${pos.x},${pos.y},${pos.z}`); this.blocks.push({ pos: { ...pos }, name }); }
  }
  override async moveTo(target: any, opts: any) {
    throwIfAborted(opts.signal);
    // The stand position remains beside a target, rather than clipping into its block.
    if (target.pos) this.pos = { x: target.pos.x - 1, y: 64, z: target.pos.z };
    this.actions.push('move');
  }
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    throwIfAborted(signal);
    this.actions.push(`dig:${this.blockAt(pos)}`);
    this.setBlock(pos, 'air');
    return { ok: true };
  }
  override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
    throwIfAborted(signal);
    const name = names.find((n) => (this.inv.get(n) ?? 0) > 0);
    if (!name) return { ok: false, reason: 'NO_ITEM' };
    if (this.failPlacement) return { ok: true };
    if (this.blockAt(pos) !== 'air') return { ok: true };
    this.setBlock(pos, name);
    this.inv.set(name, this.inv.get(name)! - 1);
    this.actions.push(`place:${name}`); this.placementCount++;
    this.afterPlacement?.();
    return { ok: true };
  }
}

function ctx(adapter: FakeAdapter, memory = new WorldMemory(null), signal = new AbortController().signal): SkillCtx {
  return { adapter, memory, bus: new EventBus(), signal, taskId: 'building-test', deadline: Date.now() + 60000, progress() {}, senses: { knownBlocks: () => [], perceivedEntities: () => [], refresh() {}, markSweep() {} } };
}
function design(archive: BuildingArchive, spec = normalizeSpec({}), origin = { x: 3, y: 64, z: 3 }, rotation: 0 | 90 | 180 | 270 = 0) {
  const blueprint = compileBuilding(spec);
  const project = archive.design({ worldId: 'fake-world', dimension: 'overworld', origin, rotation, spec, materials: materialCost(blueprint.cells) });
  return { blueprint, project };
}
function supply(adapter: FakeAdapter, blueprint: BuildingBlueprint, extra = 0) {
  for (const [name, count] of Object.entries(materialCost([...blueprint.cells, ...planScaffolding(blueprint)]))) adapter.inv.set(name, count + extra);
}

test('building design composes typed functional cells, exact door halves, budgets and four rotations', () => {
  const spec = normalizeSpec({ facilities: ['crafting_table', 'furnace', 'chest', 'torch'] });
  const bp = compileBuilding(spec);
  assert.equal(bp.cells.filter((c) => c.tags.includes('door')).length, 2);
  assert.equal(materialCost(bp.cells).oak_door, 1);
  assert.equal(bp.cells.filter((c) => c.tags.includes('window')).length, 3);
  assert.equal(new Set(bp.cells.filter((c) => c.tags.includes('roof')).map((c) => c.pos.y)).size, 3);
  const pos = { x: 2, y: 3, z: 4 }, origin = { x: 10, y: 64, z: 10 };
  assert.deepEqual([0, 90, 180, 270].map((r) => rotatePosition(pos, origin, r as any)), [{ x: 12, y: 67, z: 14 }, { x: 6, y: 67, z: 12 }, { x: 8, y: 67, z: 6 }, { x: 14, y: 67, z: 8 }]);
  assert.deepEqual([0, 90, 180, 270].map((r) => rotateProperties({ facing: 'north' }, r as any).facing), ['north', 'east', 'south', 'west']);
  assert.throws(() => normalizeSpec({ palette: { roof: 'sand' } }), /实心/);
  assert.throws(() => compileBuilding(normalizeSpec({ layout: 'custom', components: [{ pos: { x: 0, y: 0, z: 0 }, name: 'stone', dependsOn: ['0,0,0'] }] })), /循环/);
});

test('composable beds, stairs and slabs preserve exact states and single-item paired budgets through rotation', async () => {
  const spec = normalizeSpec({ name: '带楼梯的休息角', layout: 'custom', components: [
    { pos: { x: 0, y: 0, z: 0 }, name: 'white_bed', properties: { part: 'foot', facing: 'north', occupied: false }, phase: 'facilities' },
    { pos: { x: 0, y: 0, z: -1 }, name: 'white_bed', properties: { part: 'head', facing: 'north', occupied: false }, phase: 'facilities' },
    { pos: { x: 2, y: 0, z: 0 }, name: 'oak_stairs', properties: { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false } },
    { pos: { x: 3, y: 0, z: 0 }, name: 'oak_slab', properties: { type: 'bottom', waterlogged: false } },
  ] });
  for (const rotation of [0, 90, 180, 270] as const) {
    const adapter = new BuildingWorld(), archive = new BuildingArchive(null), { blueprint, project } = design(archive, spec, { x: 4, y: 64, z: 4 }, rotation);
    assert.equal(materialCost(blueprint.cells).white_bed, 1);
    assert.equal(blueprint.cells.find((cell) => cell.properties.part === 'head')!.placedBy, '0,0,0');
    supply(adapter, blueprint);
    const result = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
    assert.equal(result.inspection.complete, true, JSON.stringify(result.inspection.defects));
    assert.equal(adapter.inv.get('white_bed'), 0);
    assert.equal(adapter.placementCount, 3);
  }
});

test('building end-to-end house has a real door, glass, roof, usable interior and facilities at all rotations', async () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
    const { blueprint, project } = design(archive, normalizeSpec({ facilities: ['crafting_table', 'furnace', 'chest', 'torch'] }), { x: 4, y: 64, z: 4 }, rotation);
    supply(adapter, blueprint);
    const result = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
    assert.equal(result.inspection.complete, true, JSON.stringify(result.inspection.defects));
    assert.equal(result.inspection.functions.entry, 'pass');
    assert.equal(result.inspection.functions.lighting, 'pass');
    assert.equal(adapter.inv.get('oak_door'), 0);
    assert.equal(archive.get(project.id)!.status, 'complete');
    const before = adapter.placementCount;
    const again = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'build');
    assert.equal(again.inspection.complete, true);
    assert.equal(adapter.placementCount, before, 'resumed complete construction consumes no new blocks');
  }
});

test('construction resolves actual placement faces even nearby and never requests reach_block on air', async () => {
  class StrictAccessWorld extends BuildingWorld {
    placementsWithFace = 0;
    override async moveTo(target: any, opts: any) {
      assert.equal(opts.constructionSafe, true);
      if (target.kind === 'reach_block') assert.notEqual(this.blockAt(target.pos), 'air', 'GoalLookAtBlock cannot hit an air target');
      if (target.kind === 'place_block') this.placementsWithFace++;
      await super.moveTo(target, opts);
    }
  }
  const adapter = new StrictAccessWorld(), archive = new BuildingArchive(null), { blueprint, project } = design(archive);
  supply(adapter, blueprint);
  const result = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
  assert.equal(result.inspection.complete, true);
  assert.equal(adapter.placementsWithFace, adapter.placementCount, 'every placement has a checked legal face, including nearby scaffold columns');
});

test('upper-cell path failures retry through an actually observed owned scaffold summit', async () => {
  const archive = new BuildingArchive(null), { blueprint, project } = design(archive);
  const summit = rotatePosition({ x: -1, y: blueprint.spec.height, z: 0 }, project.origin, 0);
  const upperCorner = rotatePosition({ x: 0, y: 2, z: 0 }, project.origin, 0);
  class ElevatedAccessWorld extends BuildingWorld {
    summitVisits = 0;
    override async moveTo(target: any, opts: any) {
      if (target.kind === 'near' && target.pos.x === summit.x + 0.5 && target.pos.y === summit.y + 1 && target.pos.z === summit.z + 0.5) {
        assert.equal(opts.constructionSafe, true);
        assert.equal(this.blockAt(summit), 'cobblestone');
        assert.ok(archive.get(project.id)!.temporaryBlocks.some((block) => block.pos.x === -1 && block.pos.y === blueprint.spec.height && block.pos.z === 0));
        this.summitVisits++;
        this.pos = { ...target.pos };
        return;
      }
      if (target.kind === 'place_block' && target.pos.x === upperCorner.x && target.pos.y === upperCorner.y && target.pos.z === upperCorner.z && !this.summitVisits) throw new Error('No path to the goal!');
      await super.moveTo(target, opts);
    }
  }
  const adapter = new ElevatedAccessWorld();
  supply(adapter, blueprint);
  const result = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
  assert.equal(adapter.summitVisits, 1);
  assert.equal(result.inspection.complete, true);
});

test('exact inspection rejects partial placement, wrong materials, unknown chunks and blocked entry', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive);
  supply(adapter, blueprint);
  adapter.failPlacement = true;
  let result = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
  assert.equal(result.inspection.complete, false, 'adapter success without world evidence cannot complete');
  assert.equal(result.placed, 0);
  adapter.failPlacement = false;
  result = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'build');
  assert.equal(result.inspection.complete, true);
  const roof = blueprint.cells.find((c) => c.phase === 'roof')!;
  adapter.setBlock(rotatePosition(roof.pos, project.origin, 0), 'dirt');
  const blocked = rotatePosition({ x: 2, y: 0, z: -1 }, project.origin, 0);
  adapter.setBlock(blocked, 'chest');
  const inspection = inspectBuilding(adapter, blueprint, project);
  assert.equal(inspection.complete, false);
  assert.ok(inspection.defects.some((d) => d.kind === 'wrong_block'));
  assert.ok(inspection.defects.some((d) => d.kind === 'obstruction'));
  assert.equal(inspection.functions.entry, 'fail');
});

test('survey fills shallow foundations and rejects lava, unloaded terrain or excessive depth before mutation', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive);
  const hole = rotatePosition({ x: 0, y: -2, z: 0 }, project.origin, 0);
  adapter.setBlock(hole, 'air');
  const survey = surveyFoundation(adapter, blueprint, project);
  assert.equal(survey.defects.length, 0);
  assert.equal(survey.blueprint.cells.filter((c) => c.tags.includes('foundation_fill')).length, 1);
  supply(adapter, survey.blueprint);
  const built = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
  assert.equal(built.inspection.complete, true, JSON.stringify(built.inspection.defects));
  assert.equal(adapter.blockAt(hole), 'cobblestone');
  const lava = new BuildingWorld(); lava.setBlock(hole, 'lava'); supply(lava, blueprint);
  const before = lava.actions.length;
  assert.equal((await constructBuilding(ctx(lava), archive, project, blueprint, 'build')).inspection.complete, false);
  assert.equal(lava.actions.length, before);
  const unloaded = new BuildingWorld();
  unloaded.blockAt = () => null as any;
  unloaded.blockStateAt = () => null as any;
  const unknown = await constructBuilding(ctx(unloaded), archive, project, blueprint, 'build');
  assert.ok(unknown.inspection.defects.some((d) => d.kind === 'unknown'));
  assert.equal(unloaded.actions.length, 0);
  const deep = new BuildingWorld(); deep.groundY = 50;
  assert.ok(surveyFoundation(deep, blueprint, project).defects.some((d) => d.kind === 'terrain'));
});

test('construction cancellation persists a checkpoint and restart reobserves instead of replaying the cursor', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-building-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = new BuildingArchive(directory), adapter = new BuildingWorld();
  const { blueprint, project } = design(archive);
  supply(adapter, blueprint);
  const cancel = new AbortController();
  adapter.afterPlacement = () => { if (adapter.placementCount === 7) cancel.abort(); };
  await assert.rejects(constructBuilding(ctx(adapter, undefined, cancel.signal), archive, project, blueprint, 'build'), AbortedError);
  const reopened = new BuildingArchive(directory), saved = reopened.get(project.id)!;
  assert.ok(saved.checkpoint.ownedCells.length > 0 || saved.temporaryBlocks.length > 0);
  adapter.afterPlacement = undefined;
  const result = await constructBuilding(ctx(adapter), reopened, saved, blueprint, 'build');
  assert.equal(result.inspection.complete, true, JSON.stringify(result.inspection.defects));
  assert.equal(reopened.get(project.id)!.temporaryBlocks.length, 0, 'completion requires scaffold cleanup');
  assert.equal(adapter.placementCount, Object.values(materialCost([...blueprint.cells, ...planScaffolding(blueprint)])).reduce((a, b) => a + b, 0));
});

test('building observations and artifacts are isolated by actual world and current observation session', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive);
  supply(adapter, blueprint);
  adapter.worldId = 'another-world';
  const wrongWorld = await constructBuilding(ctx(adapter), archive, project, blueprint, 'build');
  assert.equal(wrongWorld.inspection.checked, 0);
  assert.equal(adapter.actions.length, 0);
  adapter.worldId = project.worldId;
  adapter.observationReady = false;
  assert.equal(inspectBuilding(adapter, blueprint, project).complete, false);
  adapter.observationReady = true;
  adapter.afterPlacement = () => { adapter.sessionId = 'new-session'; };
  await assert.rejects(constructBuilding(ctx(adapter), archive, project, blueprint, 'build'), AbortedError);
});

test('design rollback preserves history and repair removes obsolete owned roof parts', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive);
  supply(adapter, blueprint);
  assert.equal((await constructBuilding(ctx(adapter), archive, project, blueprint, 'build')).inspection.complete, true);
  const flat = normalizeSpec({ ...blueprint.spec, roof: 'flat' });
  archive.design({ id: project.id, worldId: project.worldId, dimension: project.dimension, origin: project.origin, rotation: 0, spec: flat, materials: materialCost(compileBuilding(flat).cells), reason: '希望试住更矮的屋顶' });
  supply(adapter, compileBuilding(flat));
  const repaired = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, compileBuilding(flat), 'repair');
  assert.equal(repaired.inspection.complete, true, JSON.stringify(repaired.inspection.defects));
  const oldRidge = blueprint.cells.filter((c) => c.phase === 'roof' && c.pos.y > blueprint.spec.height);
  assert.ok(oldRidge.every((c) => adapter.blockAt(rotatePosition(c.pos, project.origin, 0)) === 'air'));
  assert.deepEqual(archive.compareVersions(project.id, 1, 2).changedFields, ['roof']);
  const rolledBack = archive.rollback(project.id, 1, '比较之后更喜欢坡顶');
  assert.equal(rolledBack.versions.length, 3);
  assert.equal(rolledBack.versions.at(-1)!.spec.roof, 'gable');
  assert.match(rolledBack.versions.at(-1)!.reason, /比较之后/);
});

test('fixed building camera reviews save actual raycast evidence and never fabricate pixel screenshots', async () => {
  const adapter = new BuildingWorld(), memory = new WorldMemory(null), context = ctx(adapter, memory);
  const archive = buildingArchiveFor(memory);
  const { project } = design(archive);
  context.senses = new Vision(adapter, { ...DEFAULT_VISION, range: 16, cols: 8, rows: 4, bandCols: 8, bandRows: 2 });
  const validation = buildingReview.validate({ projectId: project.id, cameras: ['front', 'right'] }, adapter);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const result = await buildingReview.run(context, validation.args);
  assert.equal(result.status, 'succeeded', result.summary);
  const views = archive.get(project.id)!.views;
  assert.equal(views.length, 2);
  assert.equal(views[0].observation!.kind, 'raycast_summary');
  assert.equal(views[0].observation!.pixelImage, null);
  assert.equal(views[0].observation!.worldId, adapter.worldId);
  assert.ok(views[0].observation!.vision);
  assert.ok(views[0].observation!.raycastFrame);
});

test('cancelled placement leaves a pending intention and makes no late archive mutations', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive), controller = new AbortController();
  supply(adapter, blueprint);
  const lateWrites: string[] = [];
  for (const method of ['checkpoint', 'temporary', 'pending', 'inspect', 'actualMaterialEstimate'] as const) {
    const original = archive[method].bind(archive) as (...args: any[]) => any;
    (archive as any)[method] = (...args: any[]) => { if (controller.signal.aborted) lateWrites.push(method); return original(...args); };
  }
  adapter.afterPlacement = () => controller.abort();
  await assert.rejects(constructBuilding(ctx(adapter, undefined, controller.signal), archive, project, blueprint, 'build'), AbortedError);
  assert.deepEqual(lateWrites, []);
  const interrupted = archive.get(project.id)!;
  assert.equal(interrupted.temporaryBlocks.length, 0, 'pending intention is not fabricated ownership evidence');
  assert.equal(interrupted.pendingPlacement?.kind, 'temporary');
  adapter.afterPlacement = undefined;
  assert.equal((await constructBuilding(ctx(adapter), archive, interrupted, blueprint, 'build')).inspection.complete, true);
  assert.equal(archive.get(project.id)!.pendingPlacement, null);
});

test('already cancelled building and archive tools cannot create designs or feedback', async () => {
  const adapter = new BuildingWorld(), memory = new WorldMemory(null), controller = new AbortController();
  controller.abort();
  const context = ctx(adapter, memory, controller.signal), archive = buildingArchiveFor(memory);
  const args = build.validate({ blueprint: 'hut' }, adapter);
  assert.equal(args.ok, true);
  if (args.ok) await assert.rejects(build.run(context, args.args), AbortedError);
  assert.deepEqual(archive.list(), []);
  await assert.rejects(buildingArchive.run(context, { operation: 'list' }), AbortedError);
});

test('repair fixes only real owned defects and repairs a damaged door pair', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive);
  supply(adapter, blueprint, 3);
  assert.equal((await constructBuilding(ctx(adapter), archive, project, blueprint, 'build')).inspection.complete, true);
  const roof = blueprint.cells.find((c) => c.phase === 'roof')!;
  adapter.setBlock(rotatePosition(roof.pos, project.origin, 0), 'air');
  const before = adapter.placementCount;
  supply(adapter, blueprint, 3);
  let result = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'repair');
  assert.equal(result.inspection.complete, true);
  assert.equal(result.placed, 1, 'only the one damaged permanent cell is rebuilt');
  assert.equal(adapter.placementCount - before, 1 + planScaffolding(blueprint).length);
  const upper = blueprint.cells.find((c) => c.placedBy)!;
  adapter.setBlock(rotatePosition(upper.pos, project.origin, 0), 'air');
  supply(adapter, blueprint, 3);
  result = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'repair');
  assert.equal(result.inspection.complete, true, JSON.stringify(result.inspection.defects));
  const passage = rotatePosition({ x: 2, y: 0, z: -1 }, project.origin, 0);
  adapter.setBlock(passage, 'chest');
  result = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'repair');
  assert.equal(result.inspection.complete, false);
  assert.equal(adapter.blockAt(passage), 'chest', 'unrelated valuables are never erased to make the inspection pass');
});

test('inspect never toggles doors and repair waits for the server-observed access-state acknowledgement', async () => {
  const adapter = new BuildingWorld(), archive = new BuildingArchive(null);
  const { blueprint, project } = design(archive); supply(adapter, blueprint);
  assert.equal((await constructBuilding(ctx(adapter), archive, project, blueprint, 'build')).inspection.complete, true);
  const lower = blueprint.cells.find((c) => c.properties.half === 'lower')!, upper = blueprint.cells.find((c) => c.placedBy === lower.id)!;
  for (const cell of [lower, upper]) {
    const pos = rotatePosition(cell.pos, project.origin, project.rotation);
    adapter.blockProperties.set(`${pos.x},${pos.y},${pos.z}`, { ...adapter.blockStateAt(pos).properties, open: true });
  }
  const before = adapter.actions.length;
  assert.equal((await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'inspect')).inspection.complete, false);
  assert.equal(adapter.actions.length, before, 'read-only inspection must not repair open door states');
  const activate = adapter.useBlockAt.bind(adapter);
  let activations = 0;
  adapter.useBlockAt = async (pos, item, signal) => {
    activations++;
    // Mineflayer activateBlock acknowledges sending, not the subsequent block update.
    setTimeout(() => { void activate(pos, item, signal); }, 30);
    return { ok: true };
  };
  const repaired = await constructBuilding(ctx(adapter), archive, archive.get(project.id)!, blueprint, 'repair');
  assert.equal(repaired.inspection.complete, true, JSON.stringify(repaired.inspection.defects));
  assert.equal(activations, 1, 'a stale pre-update value must not trigger a second toggle');
});

test('archive retains version reasons, separate user/agent feedback and comparison after reload', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = new BuildingArchive(directory);
  const first = design(archive);
  archive.feedback(first.project.id, { source: 'user', text: '喜欢玻璃窗，屋顶想更矮', category: 'preference' });
  archive.feedback(first.project.id, { source: 'agent', text: '试住之后觉得可以改平顶', category: 'use' });
  const revised: BuildingSpec = { ...first.blueprint.spec, roof: 'flat' };
  archive.design({ id: first.project.id, worldId: 'fake-world', dimension: 'overworld', origin: first.project.origin, rotation: 0, spec: revised, materials: materialCost(compileBuilding(revised).cells), reason: '根据试住反馈降低屋顶' });
  const second = design(archive, normalizeSpec({ width: 7, name: '另一种候选' }));
  const reloaded = new BuildingArchive(directory), saved = reloaded.get(first.project.id)!;
  assert.equal(saved.versions.length, 2);
  assert.match(saved.versions[1].reason, /试住/);
  assert.equal(saved.feedback[0].source, 'user');
  assert.equal(saved.feedback[1].source, 'agent');
  assert.ok(reloaded.compare(first.project.id, second.project.id).materialDelta.cobblestone > 0);
  assert.equal(buildingArchive.validate({ operation: 'feedback', projectId: first.project.id, text: '冒充用户', source: 'user' }, new BuildingWorld()).ok, false);
});

test('building skill never creates a home for incomplete work and supports real custom components', async () => {
  const adapter = new BuildingWorld(), context = ctx(adapter);
  const validated = build.validate({ blueprint: 'hut', origin: { x: 3, y: 64, z: 3 }, rotation: 0 }, adapter);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  let result = await build.run(context, validated.args);
  assert.equal(result.failureCode, 'MISSING_MATERIALS');
  assert.ok(!context.memory.base());
  assert.ok(Object.keys(result.data!.missingMaterials as object).includes('glass'));
  const projectId = String(result.data!.projectId);
  const saved = buildingArchiveFor(context.memory).get(projectId)!;
  supply(adapter, compileBuilding(saved.versions.at(-1)!.spec));
  const resume = build.validate({ projectId }, adapter);
  assert.equal(resume.ok, true);
  if (!resume.ok) return;
  result = await build.run(context, resume.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(context.memory.base());
  const custom = normalizeSpec({ layout: 'custom', components: Array.from({ length: 9 }, (_, i) => ({ pos: { x: i, y: 0, z: 0 }, name: 'stone', dependsOn: i < 8 ? [`${i + 1},0,0`] : [] })) });
  const archive = new BuildingArchive(null), world = new BuildingWorld();
  const fixture = design(archive, custom); supply(world, fixture.blueprint);
  assert.equal((await constructBuilding(ctx(world), archive, fixture.project, fixture.blueprint, 'build')).inspection.complete, true);
});
