import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { Attention } from '../src/mind/attention.ts';

const data = (await import('minecraft-data')).default('1.20.1');
const adapter = () => { const a = new MineflayerAdapter(config, new EventBus()); a.mcData = data; return a; };
const keys = (n: string) => data.entitiesByName[n].metadataKeys as string[];
const md = (n: string, values: Record<string, unknown>) => { const k = keys(n); const out: unknown[] = []; for (const [key, v] of Object.entries(values)) out[k.indexOf(key)] = v; return out; };

test('一眼看得出的生物特征：羊毛颜色和剪没剪、幼崽、村民职业、驯服、带电', () => {
  const a = adapter() as any;
  assert.equal(a.traitsOf({ name: 'sheep', metadata: md('sheep', { wool: 15 }) }, keys('sheep')), '黑色');
  assert.equal(a.traitsOf({ name: 'sheep', metadata: md('sheep', { wool: 0x10, baby: true }) }, keys('sheep')), '幼崽、白色、已剪毛');
  assert.equal(a.traitsOf({ name: 'villager', metadata: md('villager', { villager_data: { villagerType: 0, villagerProfession: 5, level: 2 } }) }, keys('villager')), '农民 2 级');
  assert.equal(a.traitsOf({ name: 'wolf', metadata: md('wolf', { flags: 0x04 }) }, keys('wolf')), '已驯服');
  assert.equal(a.traitsOf({ name: 'creeper', metadata: md('creeper', { is_powered: true }) }, keys('creeper')), '带电（爆炸更猛）');
  assert.equal(a.traitsOf({ name: 'cow', metadata: [] }, keys('cow')), undefined);
});

test('状态效果按中文名、等级和剩余秒数给出', () => {
  const a = adapter() as any;
  const poison = Object.values<any>(data.effects).find((e) => e.name === 'Poison').id;
  assert.deepEqual(a.effectsOf({ entity: { effects: { [poison]: { id: poison, amplifier: 1, duration: 200 } } } }), [{ name: '中毒（掉血到半颗心为止）', level: 2, seconds: 10 }]);
});

test('注意到：身上多了状态效果、工具快磨坏了', () => {
  const att = new Attention();
  const p = (effects: string[], left: number) => ({ time: { timeOfDay: 3000, phase: 'day' }, self: { food: 20, hp: 20, inWater: false }, emptySlots: 5, effects,
    inventory: [{ name: 'stone_pickaxe', count: 1, durability: { left, max: 131 } }], nearby: { hostile: [], resources: [] }, light: null } as any);
  att.fromPercept(p([], 100));
  const n = att.fromPercept(p(['中毒（掉血到半颗心为止）'], 10));
  assert.ok(n.some((x) => x.key.startsWith('effect:') && x.level === 'reconsider'));
  assert.ok(n.some((x) => x.key === 'worn:stone_pickaxe'));
});

import { holdItem, tossItem } from '../src/skills/hands.ts';

const handsCtx = (inv: { name: string; count: number }[], extra: Record<string, unknown> = {}) => {
  const state: any = { pos: { x: 0, y: 64, z: 0 }, inventory: inv, held: null, equipment: [], hotbar: Array(9).fill(null) };
  const calls: unknown[][] = [];
  const adapter: any = {
    isKnownItem: (n: string) => ['gold_ingot', 'torch', 'shield', 'wheat'].includes(n),
    state: () => state,
    moveTo: async () => ({ ok: true }),
    async tossItem(name: string, count: number | null, _s: unknown, face?: unknown) {
      calls.push(['toss', name, count, face]);
      const it = state.inventory.find((i: any) => i.name === name); const n = count ?? it.count; it.count -= n; return { ok: true, tossed: n };
    },
    async equipItem(name: string, to: string) { calls.push(['equip', name, to]); if (to === 'hand') state.held = name; else state.equipment = [{ slot: to, name }]; return { ok: true }; },
    async arrangeHotbar(name: string, i: number) { calls.push(['hotbar', name, i]); state.hotbar[i] = name; state.held = name; return { ok: true }; },
    ...extra,
  };
  const piglin = { id: 7, name: 'piglin', kind: 'neutral', pos: { x: 1, y: 64, z: 1 }, dist: 1.4 };
  const senses: any = { refresh() {}, perceivedEntities: () => [piglin] };
  return { ctx: { adapter, senses, signal: new AbortController().signal, progress() {}, deadline: Date.now() + 30000 } as any, calls, state };
};

test('toss_item：朝看得见的猪灵扔金锭，按背包变化报告数量', async () => {
  const { ctx, calls } = handsCtx([{ name: 'gold_ingot', count: 5 }]);
  const v = tossItem.validate({ item: 'gold_ingot', count: 2, to: 'piglin' }, ctx.adapter);
  assert.ok(v.ok);
  const r = await tossItem.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(calls[0], ['toss', 'gold_ingot', 2, { x: 1, y: 64, z: 1 }]);
  assert.match(r.summary, /还剩 3/);
  assert.equal((await tossItem.run(ctx, { item: 'gold_ingot', count: 1, to: 'villager' })).failureCode, 'NOT_FOUND');
});

test('hold_item：副手、快捷栏格子，参数检查', async () => {
  const { ctx, calls } = handsCtx([{ name: 'torch', count: 16 }, { name: 'shield', count: 1 }]);
  assert.equal((await holdItem.run(ctx, { item: 'torch', to: 'off-hand' })).status, 'succeeded');
  assert.equal((await holdItem.run(ctx, { item: 'shield', to: 'hand', slot: 0 })).status, 'succeeded');
  assert.deepEqual(calls, [['equip', 'torch', 'off-hand'], ['hotbar', 'shield', 0]]);
  assert.equal(holdItem.validate({ item: 'torch', to: 'off-hand', slot: 1 }, ctx.adapter).ok, false);
  assert.equal(holdItem.validate({ item: 'torch', slot: 9 }, ctx.adapter).ok, false);
});
