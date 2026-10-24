import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { forage } from '../src/skills/forage.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

/** 右键熟浆果丛掉浆果；打树叶按给定顺序决定掉不掉苹果 */
class Orchard extends TestWorld {
  appleOnLeaf = new Set<number>();
  leavesBroken = 0;
  override async useBlockAt(pos: Vec3Like, item: string, signal: AbortSignal) {
    const r = await super.useBlockAt(pos, item, signal);
    if (this.blockAt(pos) === 'sweet_berry_bush' && Number(this.blockStateAt(pos).properties.age ?? 0) >= 2) {
      this.inv.set('sweet_berries', (this.inv.get('sweet_berries') ?? 0) + 2);
      this.blockProperties.set(`${pos.x},${pos.y},${pos.z}`, { age: 1 });
    }
    return r;
  }
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    const name = this.blockAt(pos);
    const r = await super.dig(pos, signal);
    if (name.endsWith('_leaves')) {
      this.inv.delete(name);
      if (this.appleOnLeaf.has(++this.leavesBroken)) this.inv.set('apple', (this.inv.get('apple') ?? 0) + 1);
    }
    if (name === 'melon') { this.inv.delete('melon'); this.inv.set('melon_slice', (this.inv.get('melon_slice') ?? 0) + 4); }
    return r;
  }
}

test('forage：先摘熟浆果（生的不摘），再打西瓜', async () => {
  const w = new Orchard();
  w.setBlock({ x: 3, y: 64, z: 0 }, 'sweet_berry_bush'); w.blockProperties.set('3,64,0', { age: 3 });
  w.setBlock({ x: 2, y: 64, z: 2 }, 'sweet_berry_bush'); w.blockProperties.set('2,64,2', { age: 0 });
  w.setBlock({ x: 6, y: 64, z: 0 }, 'melon');
  const ctx = makeCtx(w);
  try {
    const r = await forage.run(ctx, { count: 6 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /sweet_berries×2/); assert.match(r.summary, /melon_slice×4/);
    assert.equal(w.actions.filter((a) => a.startsWith('useBlock')).length, 1, '没熟的浆果丛不碰');
  } finally { ctx.memory.close(); }
});

test('forage：只有橡树叶时多打几片碰运气掉苹果', async () => {
  const w = new Orchard();
  w.appleOnLeaf.add(3);
  for (let x = 2; x <= 6; x++) w.setBlock({ x, y: 66, z: 0 }, 'oak_leaves');
  w.setBlock({ x: 0, y: 75, z: 0 }, 'oak_leaves'); // 太高，不为它搭柱子
  const ctx = makeCtx(w);
  try {
    const r = await forage.run(ctx, { count: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /apple×1/);
    assert.equal(w.leavesBroken, 3);
    assert.equal(w.blockAt({ x: 0, y: 75, z: 0 }), 'oak_leaves');
  } finally { ctx.memory.close(); }
});

test('forage：什么都看不见时说清楚并给出别的办法', async () => {
  const w = new Orchard();
  const ctx = makeCtx(w);
  try {
    const r = await forage.run(ctx, { count: 2 });
    assert.equal(r.failureCode, 'NOT_FOUND');
    assert.match(r.summary, /视野里没有能采的野果/);
  } finally { ctx.memory.close(); }
});
