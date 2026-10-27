import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSurfaceSpot } from '../src/observer/rescue.ts';

/** 简单世界：y<=63 是石头、64 是草地表（站 y=65）；blocks 覆盖个别格子 */
const world = (over: Record<string, string> = {}) => (p: { x: number; y: number; z: number }) => {
  const k = `${p.x},${p.y},${p.z}`;
  if (k in over) return over[k];
  return p.y < 64 ? 'stone' : p.y === 64 ? 'grass_block' : 'air';
};
const dig = (over: Record<string, string>, x: number, z: number, from: number, to: number) => { for (let y = from; y <= to; y++) over[`${x},${y},${z}`] = 'air'; };

test('卡在竖井底下：传送到井口旁边的地面上，不是井底', () => {
  const over: Record<string, string> = {};
  dig(over, 0, 0, 40, 64); // 一格宽的竖井，从地表挖到 y40
  const s = findSurfaceSpot(world(over), { x: 0.5, y: 40, z: 0.5 }, { top: 100, bottom: 0 });
  assert.ok(s);
  assert.equal(s!.y, 65);
  assert.ok(!(s!.x === 0 && s!.z === 0), '井口那一列是坑，不算平地');
  assert.ok(s!.dist <= 1.5, `应该就在井口旁边：${JSON.stringify(s)}`);
});

test('头顶是水面/树冠就往旁边找；一个能落脚的都没有返回 null', () => {
  const over: Record<string, string> = {};
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) over[`${x},64,${z}`] = 'water';
  const s = findSurfaceSpot(world(over), { x: 0.5, y: 50, z: 0.5 }, { top: 100, bottom: 0 });
  assert.ok(s && Math.max(Math.abs(s.x), Math.abs(s.z)) >= 4, JSON.stringify(s));
  const sea = (p: { x: number; y: number; z: number }) => (p.y <= 64 ? 'water' : 'air');
  assert.equal(findSurfaceSpot(sea, { x: 0, y: 70, z: 0 }, { radius: 6, top: 100, bottom: 0 }), null);
});

test('区块没加载的列跳过；本来就站在露天平地上会挪到旁边', () => {
  const unloaded = (p: { x: number; y: number; z: number }) => (p.x <= 1 ? null : world()(p));
  const s = findSurfaceSpot(unloaded, { x: 0.5, y: 65, z: 0.5 }, { top: 100, bottom: 0 });
  assert.ok(s && s.x >= 2, JSON.stringify(s));
  const t = findSurfaceSpot(world(), { x: 0.5, y: 65, z: 0.5 }, { top: 100, bottom: 0 });
  assert.ok(t && t.dist >= 1, JSON.stringify(t));
});
