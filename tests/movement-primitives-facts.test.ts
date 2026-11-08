import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import {
  classifyObserved, consumptionReceipt, countItems, inspectBody, inspectStandableBelow,
  inspectSupport, inspectSupportDigRisk, reconcileBlockMutation,
} from '../src/skills/movement/facts.ts';

type Cell = { name: string; properties?: Record<string, string | number | boolean> };
const world = (cells: Record<string, Cell>) => (pos: Vec3Like) => cells[`${pos.x},${pos.y},${pos.z}`] ?? null;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

test('facts：支撑/脚高/分类都从同一观察口径计算', () => {
  const at = world({
    [key(0, 63, 0)]: { name: 'stone_slab', properties: { type: 'bottom' } },
    [key(0, 62, 0)]: { name: 'stone' },
  });
  const support = inspectSupport(at, { x: 0, y: 63, z: 0 });
  assert.equal(support.top, 0.5);
  assert.equal(support.foot, 63.5);

  assert.equal(classifyObserved(null), 'unknown');
  assert.equal(classifyObserved({ name: 'air', properties: {} }), 'air');
  assert.equal(classifyObserved({ name: 'short_grass', properties: {} }), 'replaceable');
  assert.equal(classifyObserved({ name: 'stone', properties: {} }), 'support');
  assert.equal(classifyObserved({ name: 'torch', properties: {} }), 'solid');
});

test('facts：下方扫描在未知格停下，不越过未加载区域', () => {
  const at = world({
    [key(0, 63, 0)]: { name: 'air' }, // 63 空气，62 石头：脚面 63
    [key(0, 62, 0)]: { name: 'stone' },
  });
  const seen = inspectStandableBelow(at, { x: 0, y: 64, z: 0 }, 64);
  assert.deepEqual(seen.landing && { footCell: seen.landing.footCell, foot: seen.landing.foot, drop: seen.landing.drop }, {
    footCell: { x: 0, y: 63, z: 0 }, foot: 63, drop: 1,
  });
  assert.equal(seen.unknown, false);

  const unloaded = world({
    [key(0, 62, 0)]: { name: 'stone' },
  });
  const missing = inspectStandableBelow((p) => p.y === 63 ? null : unloaded(p), { x: 0, y: 64, z: 0 }, 64);
  assert.equal(missing.landing, null);
  assert.equal(missing.unknown, true, '未加载格不能当作空气继续往下找');
});

test('facts：挖脚下支撑的风险扫描区分实心/液体/未知', () => {
  const solid = inspectSupportDigRisk(world({ [key(0, 62, 0)]: { name: 'stone' } }), { x: 0, y: 63, z: 0 });
  assert.deepEqual(solid.landing && { drop: solid.landing.drop, liquid: solid.landing.liquid }, { drop: 1, liquid: false });

  const water = inspectSupportDigRisk(world({ [key(0, 62, 0)]: { name: 'water' } }), { x: 0, y: 63, z: 0 });
  assert.deepEqual(water.landing && { drop: water.landing.drop, liquid: water.landing.liquid }, { drop: 1, liquid: true });

  const unknown = inspectSupportDigRisk(() => null, { x: 0, y: 63, z: 0 });
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.landing, null);
});

test('facts：身体净空同时报告阻挡和未知格', () => {
  const at = world({
    [key(1, 64, 0)]: { name: 'air' },
    // 1,65,0 未提供：未知
  });
  const body = inspectBody(at, 64, 1, 0);
  assert.deepEqual(body.unknown, [{ x: 1, y: 65, z: 0 }]);

  const blocked = world({ [key(1, 65, 0)]: { name: 'stone' } });
  const hit = inspectBody(blocked, 64, 1, 0);
  assert.equal(hit.blockers[0]?.name, 'stone');
});

test('facts：reconcileBlockMutation 与材料消耗使用同一分类', () => {
  const at = world({ [key(1, 64, 0)]: { name: 'cobblestone' } });
  const placed = reconcileBlockMutation(at, { x: 1, y: 64, z: 0 }, (s) => s.name === 'cobblestone');
  assert.equal(placed.matched, true);
  assert.equal(placed.kind, 'support');
  const wrong = reconcileBlockMutation(at, { x: 1, y: 64, z: 0 }, (s) => s.name === 'dirt');
  assert.equal(wrong.matched, false);

  const adapter = { state: () => ({ inventory: [{ name: 'cobblestone', count: 2 }, { name: 'dirt', count: 1 }] }) };
  assert.equal(countItems(adapter, ['cobblestone', 'dirt']), 3);
  adapter.state = () => ({ inventory: [{ name: 'cobblestone', count: 1 }, { name: 'dirt', count: 1 }] });
  const receipt = consumptionReceipt(adapter, ['cobblestone', 'dirt'], 3, { pendingWhenZero: true });
  assert.equal(receipt.after, 2);
  assert.equal(receipt.consumed, 1);
  assert.equal(receipt.consumptionVerified, true);

  adapter.state = () => ({ inventory: [{ name: 'cobblestone', count: 2 }, { name: 'dirt', count: 1 }] });
  const pending = consumptionReceipt(adapter, ['cobblestone', 'dirt'], 3, { pendingWhenZero: true });
  assert.equal(pending.consumed, 0);
  assert.equal(pending.consumptionVerified, false);
  assert.equal(pending.consumptionPending, true, '库存回执未到不能写成真实零消耗');
});
