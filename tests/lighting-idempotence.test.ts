import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState, GameAdapter, Vec3Like } from '../src/adapter/types.ts';
import { measureLight, openSky, placeTorch } from '../src/skills/light.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import { lightAround } from '../src/util.ts';

// Local observation/placement stubs only; no movement, game loop or elapsed-time simulation.
function fixture() {
  const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
  const blocks = new Map<string, string>();
  const env = { block: 0, sky: 0, roof: true, unknownAbove: false };
  const actions: string[] = [];
  const state = { pos: { x: 0.5, y: 64, z: 0.5 }, onGround: true, inWater: false, inLava: false,
    timeOfDay: 1000, isDay: true, inventory: [{ name: 'torch', count: 4 }],
  } as AgentState;
  const adapter = {
    state: () => state,
    blockAt: (pos: Vec3Like) => env.unknownAbove && pos.y >= 70 ? null : blocks.get(key(pos)) ?? (pos.y < 64 || env.roof && pos.y === 67 ? 'stone' : 'air'),
    lightAt: () => ({ block: env.block, sky: env.sky }),
    craft: async () => { actions.push('craft'); return { ok: false, crafted: 0 }; },
    placeBlockAt: async (pos: Vec3Like) => {
      actions.push('place'); blocks.set(key(pos), 'torch'); state.inventory[0].count--; env.block = 12; return { ok: true };
    },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 5000 } as SkillCtx;
  return { env, blocks, actions, state, adapter, ctx };
}

test('already effective block light finishes without crafting or consuming a torch', async () => {
  const w = fixture(); w.env.block = 12; w.state.inventory = [];
  const result = await placeTorch.run(w.ctx, { count: 1 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.placed, 0);
  assert.deepEqual(w.actions, []);
});

test('a nearby visible torch covers delayed light updates, while a torch behind a wall does not', async () => {
  const w = fixture(); w.blocks.set('2,64,0', 'torch'); w.state.inventory = [];
  let result = await placeTorch.run(w.ctx, { count: 1 });
  assert.equal(result.data?.placed, 0);
  assert.deepEqual(w.actions, []);
  w.blocks.set('1,64,0', 'stone'); w.blocks.set('1,65,0', 'stone');
  w.state.inventory = [{ name: 'torch', count: 4 }];
  result = await placeTorch.run(w.ctx, { count: 1 });
  assert.equal(result.data?.placed, 1);
  assert.deepEqual(w.actions, ['place']);
});

test('daylight alone preserves explicit lighting for the night, with auto daylight still skipped', async () => {
  const inside = fixture(); inside.env.sky = 15;
  const result = await placeTorch.run(inside.ctx, { count: 1 });
  assert.equal(result.data?.placed, 1, 'a daylight window does not provide night lighting');
  const outside = fixture(); outside.env.roof = false; outside.env.sky = 15; outside.state.inventory = [];
  const automatic = await placeTorch.run(outside.ctx, { count: 1, auto: true });
  assert.equal(automatic.data?.placed, 0);
  assert.deepEqual(outside.actions, [], 'skip before attempting to craft');
});

test('partial blocks remain readable, solid-block values and unknown roofs remain untrusted', () => {
  const w = fixture();
  w.adapter.lightAt = (_x, y) => y === 64 ? { block: 7, sky: 0 } : null;
  for (const name of ['white_bed', 'oak_slab']) {
    w.blocks.set('0,64,0', name);
    assert.equal(measureLight(w.adapter, w.state.pos, 1000, true).level, 7, name);
  }
  w.blocks.set('0,64,0', 'stone');
  assert.equal(lightAround(w.adapter, 0, 64, 0), null, 'a wall is not a body-space sample');
  w.blocks.delete('0,64,0'); w.env.roof = false; w.env.unknownAbove = true;
  assert.equal(openSky(w.adapter, 0, 66, 0), null, 'unloaded height does not prove open sky');
});

test('multiple requested torches stop once illuminated and repeated calls perform zero placements', async () => {
  const w = fixture();
  const first = await placeTorch.run(w.ctx, { count: 4 });
  assert.equal(first.data?.placed, 1);
  w.env.block = 0; // A late/stale light packet must not cause another local pile.
  const again = await placeTorch.run(w.ctx, { count: 4 });
  assert.equal(again.data?.placed, 0);
  assert.deepEqual(w.actions, ['place']);
  assert.equal(w.state.inventory[0].count, 3);
});
