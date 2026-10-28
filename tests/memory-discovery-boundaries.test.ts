import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ride } from '../src/skills/actions.ts';
import { explore, glance } from '../src/skills/movement.ts';
import { observePortal, travelPortal, useEndGateway } from '../src/skills/travel.ts';
import { travelStore } from '../src/travel/store.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

function fixture() {
  const world = new TestWorld(), memory = new WorldMemory(null), batches: number[] = [];
  memory.setWorld(world.worldId);
  const sight = { visible: false };
  const ctx = makeCtx(world, { memory, senses: { observeBlocks: (positions) => {
    batches.push(positions.length);
    return sight.visible ? positions.map((pos): BlockObservation => ({
      name: world.blockAt(pos), properties: {}, pos, worldId: world.worldId, dimension: world.dim,
      sessionId: world.sessionId, observationId: world.observationId, observedAt: Date.now(), source: 'vision',
    })) : [];
  } } });
  return { world, memory, ctx, sight, batches };
}

test('explore until does not call an eighty-block historical ore location current sight', async (t) => {
  const { world, memory, ctx } = fixture();
  t.after(() => memory.close());
  const ore = { name: 'iron_ore', pos: { x: 80, y: 64, z: 0 }, dist: 80 };
  ctx.senses.knownBlocks = (names) => names.includes(ore.name) ? [ore] : [];
  let movements = 0;
  world.moveTo = async () => { movements++; throw new Error('PATH_NOT_FOUND'); };
  const result = await explore.run(ctx, { direction: 'E', distance: 24, until: 'iron_ore' });
  assert.equal(result.data?.found, undefined);
  assert.equal(result.status, 'failed');
  assert.ok(movements > 0);
  assert.equal(ctx.senses.knownBlocks(['iron_ore'], 96).length, 1, 'historical clue is preserved');
});

test('explore until still stops for a freshly seen target', async (t) => {
  const { world, memory, ctx, sight } = fixture();
  t.after(() => memory.close());
  const pos = { x: 4, y: 64, z: 0 };
  world.setBlock(pos, 'iron_ore'); sight.visible = true;
  const result = await explore.run(ctx, { direction: 'E', distance: 24, until: 'iron_ore' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.found, 'iron_ore');
  assert.equal(result.data?.moved, 0);
  assert.equal(world.actions.length, 0);
});

test('a visible target after the first thirty-two historical candidates is still checked in bounded batches', async (t) => {
  const { world, memory, ctx, batches } = fixture();
  t.after(() => memory.close());
  const visible = { x: 4, y: 64, z: 0 };
  ctx.senses.knownBlocks = () => Array.from({ length: 33 }, (_, index) => ({
    name: 'iron_ore', pos: index === 32 ? visible : { x: index + 5, y: 64, z: 0 }, dist: index + 5,
  }));
  ctx.senses.observeBlocks = (positions) => {
    batches.push(positions.length);
    return positions.filter((pos) => pos === visible).map((pos): BlockObservation => ({
      name: 'iron_ore', properties: {}, pos, worldId: world.worldId, dimension: world.dim,
      sessionId: world.sessionId, observationId: world.observationId, observedAt: Date.now(), source: 'vision',
    }));
  };
  const result = await explore.run(ctx, { direction: 'E', distance: 24, until: 'iron_ore' });
  assert.equal(result.data?.found, 'iron_ore');
  assert.deepEqual(batches, [32, 1]);
});

test('glance and explore until do not promote hearing to a precise visual discovery', async (t) => {
  const { world, memory, ctx } = fixture();
  t.after(() => memory.close());
  ctx.senses.knownBlocks = () => [];
  ctx.senses.perceivedEntities = () => [{ id: 1, name: 'cow', kind: 'passive', pos: { x: 4, y: 64, z: 0 }, dist: 4, perception: 'heard' }];
  assert.equal(await glance(ctx, 'cow'), null);
  world.moveTo = async () => { throw new Error('PATH_NOT_FOUND'); };
  const result = await explore.run(ctx, { direction: 'AUTO', distance: 24, until: 'cow' });
  assert.equal(result.data?.found, undefined);
});

test('ride until keeps moving past an unconfirmed historical target and stops on fresh sight', async (t) => {
  const { world, memory, ctx, sight } = fixture();
  t.after(() => memory.close());
  world.riding = 'horse';
  world.setBlock({ x: 4, y: 64, z: 0 }, 'iron_ore');
  const stops: boolean[] = [];
  world.ride = async (_target, _signal, opts) => {
    const stopped = opts.stop?.() ?? false;
    stops.push(stopped);
    return { ok: true, arrived: !stopped, moved: stopped ? 0 : 8 };
  };
  const hidden = await ride.run(ctx, { direction: 'E', distance: 8, until: 'iron_ore' });
  assert.equal(hidden.data?.found, undefined);
  sight.visible = true;
  const visible = await ride.run(ctx, { direction: 'E', distance: 8, until: 'iron_ore' });
  assert.equal(visible.data?.found, 'iron_ore');
  assert.deepEqual(stops, [false, true]);
});

test('observe_portal requires current visible evidence despite an unchanged historical block', async (t) => {
  const { world, memory, ctx, sight } = fixture();
  t.after(() => memory.close());
  world.setBlock({ x: 3, y: 64, z: 0 }, 'nether_portal');
  const hidden = await observePortal.run(ctx, {});
  assert.equal(hidden.failureCode, 'NOT_FOUND');
  assert.deepEqual(travelStore(memory).snapshot(world.worldId).endpoints, []);
  sight.visible = true;
  assert.equal((await observePortal.run(ctx, {})).status, 'succeeded');
  assert.equal(travelStore(memory).snapshot(world.worldId).endpoints[0]?.portalObserved, true);
});

test('a real dimension arrival records its position but does not discover an unseen nearby return portal', async (t) => {
  const { world, memory, ctx, batches } = fixture();
  t.after(() => memory.close());
  const pos = { x: 3, y: 64, z: 0 }, arrival = { x: 100, y: 64, z: 100 };
  world.setBlock(pos, 'nether_portal');
  world.setBlock({ ...arrival, x: 102 }, 'nether_portal');
  world.portalDestinations.set(`${world.worldId}:overworld:3,64,0`, { dim: 'the_nether', pos: arrival, arrivalPortal: false });
  const source = travelStore(memory).observe(world.state(), pos, 'nether_portal');
  const result = await travelPortal.run(ctx, { portalId: source.id });
  assert.equal(result.status, 'succeeded', result.summary);
  const destination = travelStore(memory).snapshot(world.worldId).endpoints.find((endpoint) => endpoint.dim === 'the_nether');
  assert.deepEqual(destination?.pos, arrival);
  assert.equal(destination?.portalObserved, false);
  assert.match(result.summary, /尚需寻找/);
  assert.ok(batches.length >= 3);
  assert.ok(batches.every((size) => size <= 32));
});

test('a freshly visible portal near the actual arrival becomes a confirmed return endpoint', async (t) => {
  const { world, memory, ctx, sight, batches } = fixture();
  t.after(() => memory.close());
  const pos = { x: 3, y: 64, z: 0 }, arrival = { x: 100, y: 64, z: 100 }, portal = { ...arrival, x: 102 };
  world.setBlock(pos, 'nether_portal'); world.setBlock(portal, 'nether_portal');
  world.portalDestinations.set(`${world.worldId}:overworld:3,64,0`, { dim: 'the_nether', pos: arrival, arrivalPortal: false });
  const source = travelStore(memory).observe(world.state(), pos, 'nether_portal'); sight.visible = true;
  assert.equal((await travelPortal.run(ctx, { portalId: source.id })).status, 'succeeded');
  const destination = travelStore(memory).snapshot(world.worldId).endpoints.find((endpoint) => endpoint.dim === 'the_nether');
  assert.deepEqual(destination?.pos, portal);
  assert.equal(destination?.portalObserved, true);
  assert.ok(batches.every((size) => size <= 32));
});

test('gateway implicit discovery and the far arrival require fresh portal sight', async (t) => {
  const { world, memory, ctx, batches } = fixture();
  t.after(() => memory.close());
  world.dim = 'the_end'; world.inv.set('ender_pearl', 2);
  const pos = { x: 3, y: 64, z: 0 }, arrival = { x: 1000, y: 64, z: 0 };
  world.setBlock(pos, 'end_gateway'); world.setBlock({ ...arrival, x: 1002 }, 'end_gateway');
  const hidden = await useEndGateway.run(ctx, {});
  assert.equal(hidden.failureCode, 'NOT_FOUND');
  assert.equal(world.actions.length, 0);
  const source = travelStore(memory).observe(world.state(), pos, 'end_gateway');
  world.useItem = async (item) => {
    world.inv.set(item, (world.inv.get(item) ?? 0) - 1);
    world.pos = { ...arrival };
    return { ok: true };
  };
  const result = await useEndGateway.run(ctx, { portalId: source.id });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.returnPortalObserved, false);
  const destination = travelStore(memory).snapshot(world.worldId).endpoints.find((endpoint) => endpoint.id !== source.id);
  assert.equal(destination?.portalObserved, false);
  assert.deepEqual(destination?.pos, arrival);
  assert.ok(batches.length >= 8);
  assert.ok(batches.every((size) => size <= 32));
});
