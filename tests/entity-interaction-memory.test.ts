import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vision } from '../src/perception/vision.ts';
import { interact } from '../src/skills/actions.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const boat = (id: number, x: number) => ({ id, name: 'boat', kind: 'other' as const, perception: 'seen' as const, pos: { x, y: 64, z: 0.5 }, dist: x, height: 0.6 });

test('visual entity memory includes nonliving entities but never follows their unseen movement', () => {
  const w = new TestWorld(), vision = new Vision(w);
  w.entities = [boat(41, 3)];
  vision.scan();
  const current = vision.summary(w.pos).seen_entities[0];
  assert.equal(current.id, 41);
  assert.deepEqual(current.pos, { x: 3, y: 64, z: 0.5 });

  w.yaw = Math.PI / 2;
  w.entities = [boat(41, 8)];
  vision.scan();
  const remembered = vision.summary(w.pos).recent_sightings?.[0];
  assert.equal(vision.perceivedEntities(32).length, 0, 'history is not a currently visible entity');
  assert.equal(remembered?.id, 41);
  assert.deepEqual(remembered?.pos, current.pos, 'use the last visual position rather than the live entity position');
  assert.equal(remembered?.source, 'past_visual_observation');
  assert.equal(remembered?.currently_visible, false);

  w.yaw = -Math.PI / 2;
  vision.scan();
  assert.deepEqual(vision.summary(w.pos).seen_entities[0].pos, { x: 8, y: 64, z: 0.5 });
  assert.equal(vision.summary(w.pos).recent_sightings, undefined);
  w.sessionId = 'new-session';
  assert.equal(vision.summary(w.pos).recent_sightings, undefined, 'entity IDs and their history do not cross sessions');
});

test('interact honors an explicit entity ID and retains the name entry point', async (t) => {
  const w = new TestWorld(), ctx = makeCtx(w), clicked: number[] = [];
  t.after(() => ctx.memory.close());
  w.entities = [boat(41, 2), boat(42, 2.5)];
  w.interactEntity = async (id) => { clicked.push(id); return { ok: true, mounted: 'boat' }; };
  const parsed = interact.validate({ entityId: 42 }, w);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(interact.validate({ entity: -1 }, w).ok, false);
  assert.equal(interact.validate({ entity: 1.5 }, w).ok, false);
  const result = await interact.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.entityId, 42);
  await interact.run(ctx, { entity: 'boat' });
  assert.deepEqual(clicked, [42, 41]);
});

test('interact cannot use history or hearing as a current target and requires a new sighting', async (t) => {
  const w = new TestWorld(), vision = new Vision(w), ctx = makeCtx(w), clicked: number[] = [];
  ctx.senses = vision;
  t.after(() => ctx.memory.close());
  w.entities = [boat(41, 2)];
  w.interactEntity = async (id) => { clicked.push(id); return { ok: true, mounted: 'boat' }; };
  vision.scan();
  w.yaw = Math.PI / 2;
  vision.scan();
  assert.equal((await interact.run(ctx, { entity: 41 })).failureCode, 'NOT_FOUND');
  assert.deepEqual(clicked, []);
  ctx.senses = { ...ctx.senses, refresh() {}, perceivedEntities: () => [{ ...boat(41, 2), perception: 'heard' }] };
  assert.equal((await interact.run(ctx, { entity: 41 })).failureCode, 'NOT_FOUND');
  assert.deepEqual(clicked, []);
  ctx.senses = vision;
  w.yaw = -Math.PI / 2;
  vision.scan();
  assert.equal((await interact.run(ctx, { entity: 41 })).status, 'succeeded');
  assert.deepEqual(clicked, [41]);
});

test('interact rechecks the selected entity after walking and does not substitute a nearby entity', async (t) => {
  const w = new TestWorld(), ctx = makeCtx(w), clicked: number[] = [];
  t.after(() => ctx.memory.close());
  w.entities = [boat(41, 8)];
  w.moveTo = async () => { w.pos = { x: 6, y: 64, z: 0 }; w.entities = [boat(42, 8)]; };
  w.interactEntity = async (id) => { clicked.push(id); return { ok: true }; };
  const result = await interact.run(ctx, { entity: 41 });
  assert.equal(result.failureCode, 'TARGET_GONE');
  assert.deepEqual(clicked, []);
});
