import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durabilityText } from '../src/mind/prompt.ts';
import { holdItem } from '../src/skills/hands.ts';

test('背包里同名工具：每件的耐久都说，不只报最旧那把', () => {
  const picks = { count: 11, durability: { left: 2, max: 131 }, durabilities: [131, 131, 131, 131, 131, 131, 131, 131, 60, 2, 2] };
  const t = durabilityText(picks);
  assert.match(t, /131\/131×8、60\/131、2\/131×2/);
  assert.match(t, /快坏的 2 件用完会自动换下一件，还有 9 件好的/);
  assert.doesNotMatch(t, /全都快坏了/);
  assert.match(durabilityText({ count: 3, durability: { left: 1, max: 131 }, durabilities: [5, 3, 1] }), /全都快坏了/);
  assert.equal(durabilityText({ count: 1, durability: { left: 2, max: 131 }, durabilities: [2] }), '（耐久 2/131，快坏了）');
  assert.equal(durabilityText({ count: 64 }), '');
});

function handCtx(state: any) {
  const calls: string[] = [];
  const adapter = {
    state: () => state,
    equipItem: async (name: string) => { calls.push(name); state.heldDurability = { left: state.inventory[0].durabilities[0], max: 131 }; return { ok: true }; },
  };
  return { ctx: { adapter, signal: new AbortController().signal } as any, calls };
}

test('hold_item：手里同名那把快坏了、背包里有更好的，就真的换上；没有更好的才说“已经在主手”', async () => {
  const worn = { held: 'stone_pickaxe', heldDurability: { left: 2, max: 131 }, equipment: [],
    inventory: [{ name: 'stone_pickaxe', count: 3, durability: { left: 2, max: 131 }, durabilities: [131, 60, 2] }] };
  const a = handCtx(worn);
  const r = await holdItem.run(a.ctx, { item: 'stone_pickaxe', to: 'hand' });
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(a.calls, ['stone_pickaxe']);
  assert.match(r.summary, /耐久 131\/131/);

  const best = { held: 'stone_pickaxe', heldDurability: { left: 131, max: 131 }, equipment: [],
    inventory: [{ name: 'stone_pickaxe', count: 2, durability: { left: 60, max: 131 }, durabilities: [131, 60] }] };
  const b = handCtx(best);
  const r2 = await holdItem.run(b.ctx, { item: 'stone_pickaxe', to: 'hand' });
  assert.equal(r2.status, 'succeeded');
  assert.deepEqual(b.calls, []);
  assert.match(r2.summary, /已经在主手/);
});
