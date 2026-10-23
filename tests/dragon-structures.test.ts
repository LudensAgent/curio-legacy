import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityInfo, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { dragonFight } from '../src/skills/dragon.ts';
import { findStronghold } from '../src/skills/structures.ts';
import { activateEndPortal } from '../src/skills/travel.ts';
import type { Senses, SkillCtx } from '../src/skills/types.ts';
import { travelStore } from '../src/travel/store.ts';
import { FakeAdapter } from './fake-adapter.ts';

const context = (adapter: FakeAdapter, senses: Senses = new Vision(adapter), durationMs = 5000): SkillCtx => ({ adapter, senses, memory: new WorldMemory(null), bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + durationMs, taskId: 'offline-test', progress() {} });

test('dragon local controller switches crystals, flying and perched phases and accepts actual matching death evidence', async () => {
  const adapter = new FakeAdapter();
  adapter.dim = 'the_end'; adapter.speed = 1000;
  adapter.inv.set('bow', 1); adapter.inv.set('arrow', 10); adapter.inv.set('iron_sword', 1);
  const crystal: EntityInfo = { id: 31, name: 'end_crystal', kind: 'other', pos: { x: 16, y: 64, z: 0 }, height: 1.6, dist: 16 };
  const dragon: EntityInfo = { id: 40, name: 'ender_dragon', kind: 'hostile', pos: { x: 20, y: 64, z: 0 }, height: 1.6, phase: 0, hp: 200, dist: 20 };
  adapter.entities.push(crystal, dragon);
  const shot = adapter.rangedAttack.bind(adapter);
  adapter.rangedAttack = async (id, signal) => {
    const result = await shot(id, signal);
    if (id === crystal.id) adapter.entities = adapter.entities.filter((e) => e.id !== crystal.id);
    if (id === dragon.id) { dragon.phase = 6; dragon.pos = { x: 6, y: 64, z: 0 }; }
    return result;
  };
  adapter.attack = async (id) => {
    adapter.actions.push(`attack:${id}`);
    adapter.dragonDeath = { entityId: id, worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId, observedAt: Date.now(), pos: { ...dragon.pos }, source: 'entity_dead' };
    adapter.entities = adapter.entities.filter((e) => e.id !== id);
    return true;
  };
  const move = adapter.moveTo.bind(adapter);
  adapter.moveTo = async (target, options) => {
    if (target.kind === 'near' && target.range === 2.5) {
      adapter.pos = { x: target.pos.x - target.range, y: target.pos.y, z: target.pos.z };
      adapter.actions.push('moveTo:near');
    } else await move(target, options);
  };
  const ctx = context(adapter);
  const result = await dragonFight.run(ctx, { seconds: 10 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.defeatVerified, true);
  assert.equal(result.data?.bodyMeleeAttempts, 1);
  assert.equal(result.data?.headHits, undefined);
  const stages = (result.data?.stages as { stage: string }[]).map((s) => s.stage);
  for (const expected of ['prepare', 'crystals', 'flying', 'perched', 'verify']) assert.ok(stages.includes(expected), expected);
  assert.ok(adapter.actions.includes('ranged:31'));
  assert.ok(adapter.actions.includes('attack:40'));
});

test('missing dragon, zero-health appearance without death evidence, and stale death records cannot produce victory', async () => {
  for (const mode of ['missing', 'unconfirmed', 'stale'] as const) {
    const adapter = new FakeAdapter();
    adapter.dim = 'the_end'; adapter.inv.set('bow', 1); adapter.inv.set('arrow', 10);
    if (mode !== 'missing') adapter.entities.push({ id: 40, name: 'ender_dragon', kind: 'hostile', pos: { x: 12, y: 64, z: 0 }, height: 1.6, phase: 9, hp: 0, dist: 12 });
    if (mode === 'stale') adapter.dragonDeath = { entityId: 40, worldId: adapter.worldId, dim: adapter.dim, sessionId: 'old-session', observedAt: Date.now(), pos: { x: 12, y: 64, z: 0 } };
    const result = await dragonFight.run(context(adapter, undefined, 350), { seconds: 10 });
    assert.equal(result.status, 'failed', mode);
    assert.equal(result.failureCode, 'TIMEOUT');
    assert.equal(result.data?.defeatVerified, false);
  }
});

test('low health makes the local dragon controller withdraw and preserves a failed battle outcome', async () => {
  const adapter = new FakeAdapter();
  adapter.dim = 'the_end'; adapter.speed = 1000; adapter.hp = 5;
  adapter.inv.set('bow', 1); adapter.inv.set('arrow', 2);
  adapter.entities.push({ id: 40, name: 'ender_dragon', kind: 'hostile', pos: { x: 12, y: 64, z: 0 }, height: 1.6, phase: 0, dist: 12 });
  const result = await dragonFight.run(context(adapter), { seconds: 10 });
  assert.equal(result.failureCode, 'LOW_HP');
  assert.ok(adapter.actions.includes('moveTo:away_from'));
});

test('stronghold guidance follows only observed eye samples and labels descent as a search hint', async () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('ender_eye', 2);
  let thrown = false, frame = 0;
  const use = adapter.useItem.bind(adapter);
  adapter.useItem = async (...args) => { const result = await use(...args); thrown = true; return result; };
  const senses: Senses = {
    refresh() { if (thrown) frame++; },
    perceivedEntities() { return thrown ? [{ id: 70, name: 'eye_of_ender', kind: 'other', pos: { x: 4 + frame * 0.3, y: 67 - frame * 0.2, z: 1 }, dist: 6 }] : []; },
    knownBlocks() { return []; }, markSweep() {},
  };
  const ctx = context(adapter, senses, 10000);
  const result = await findStronghold.run(ctx, { throws: 1, step: 16 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.structureVerified, false);
  assert.ok(result.data?.searchPosition);
  assert.ok(ctx.memory.landmarks().some((l) => l.label.includes('尚未发现要塞')));
  assert.ok(!adapter.actions.some((a) => a.startsWith('moveTo:')), 'a downward search hint should not invent a traversable underground route');
});

test('stronghold detection requires an actual observed frame, without spending or manufacturing an eye', async () => {
  const adapter = new FakeAdapter();
  const pos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'end_portal_frame', pos });
  const result = await findStronghold.run(context(adapter), { throws: 1, step: 16 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.structureVerified, true);
  assert.deepEqual(adapter.actions, []);
});

test('existing correctly facing End frames accept eyes and only an actual portal block is recorded', async () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('ender_eye', 12);
  const center: Vec3Like = { x: 8, y: 64, z: 0 };
  const frames = [-1, 0, 1].flatMap((offset) => [
    { pos: { x: center.x + offset, y: center.y, z: center.z - 2 }, facing: 'south' }, { pos: { x: center.x + offset, y: center.y, z: center.z + 2 }, facing: 'north' },
    { pos: { x: center.x - 2, y: center.y, z: center.z + offset }, facing: 'east' }, { pos: { x: center.x + 2, y: center.y, z: center.z + offset }, facing: 'west' },
  ]);
  for (const f of frames) { adapter.blocks.push({ name: 'end_portal_frame', pos: f.pos }); adapter.blockProperties.set(`${f.pos.x},${f.pos.y},${f.pos.z}`, { facing: f.facing, eye: false }); }
  const use = adapter.useBlockAt.bind(adapter);
  adapter.useBlockAt = async (...args) => {
    const result = await use(...args);
    if (frames.every((f) => adapter.blockStateAt(f.pos).properties.eye === true)) adapter.blocks.push({ name: 'end_portal', pos: center });
    return result;
  };
  const senses: Senses = { refresh() {}, perceivedEntities() { return []; }, knownBlocks() { return frames.map((f) => ({ name: 'end_portal_frame', pos: f.pos, dist: 8 })); }, markSweep() {} };
  const ctx = context(adapter, senses);
  const result = await activateEndPortal.run(ctx, {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.inv.get('ender_eye'), 0);
  assert.equal(travelStore(ctx.memory).snapshot(adapter.worldId).endpoints[0].kind, 'end_portal');
});
