/**
 * 1.20.1 blockstate 碰撞形状提供器。只保留地/水/传送门与真实碰撞盒解析，
 * 供 land-search 空间规则和实际身体判定共用；不含旧步行执行器。
 */

import { createRequire } from 'node:module';
import { serializeBlockState, type CollisionShape, type CollisionShapeProvider } from 'curio-minecraft-3d-memory';
import { config } from '../config.ts';

const EMPTY: CollisionShape = { boxes: [], supportFaces: [] };
const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const AIR = new Set(['air', 'cave_air', 'void_air']);
/** 液体没有可站立碰撞盒；接触/淹没由判定器的 hazard 事实单独报告。 */
const LIQUIDS = new Set(['water', 'lava', 'bubble_column']);
/** 传送门不是普通步行方块：走进去会切维，必须显式走 travel_portal/observe_portal。 */
const PORTALS = new Set(['nether_portal', 'end_portal', 'end_gateway']);
const require = createRequire(import.meta.url);
interface BlockLike { shapes?: number[][]; boundingBox?: string }
const Block = require('prismarine-block')(config.mc.version) as {
  fromProperties(name: string, properties: Record<string, string>, biome?: number): BlockLike;
};
/** state → shape；同一个 name+properties 在进程内只解析一次。值是 null 表示无法从数据确认。 */
const shapeCache = new Map<string, CollisionShape | null>();

function shapeOf(state: { name: string; properties: Record<string, string> }): CollisionShape | null {
  const name = state.name.replace(/^minecraft:/, '');
  if (AIR.has(name)) return EMPTY;
  if (LIQUIDS.has(name)) return EMPTY;
  if (PORTALS.has(name)) return null;
  const properties = Object.fromEntries(Object.entries(state.properties).map(([key, value]) => [key, String(value)]));
  const cacheKey = `${name}|${Object.entries(properties).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(',')}`;
  const cached = shapeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let block: BlockLike;
  try {
    block = Block.fromProperties(name, properties, 0);
  } catch {
    shapeCache.set(cacheKey, null);
    return null;
  }
  const raw = Array.isArray(block.shapes) ? block.shapes : null;
  if (raw === null) {
    // 数据明确说是无碰撞方块（火把、花、告示牌等）时给空形状；其余不猜。
    if (block.boundingBox === 'empty') { shapeCache.set(cacheKey, EMPTY); return EMPTY; }
    shapeCache.set(cacheKey, null);
    return null;
  }
  const boxes = raw
    .filter((shape) => Array.isArray(shape) && shape.length === 6 && shape.every((n) => Number.isFinite(n)))
    .map(([minX, minY, minZ, maxX, maxY, maxZ]) => ({ minX: minX!, minY: minY!, minZ: minZ!, maxX: maxX!, maxY: maxY!, maxZ: maxZ! }));
  if (boxes.length === 0) { shapeCache.set(cacheKey, EMPTY); return EMPTY; }
  const shape: CollisionShape = boxes.length === 1
    && boxes[0]!.minX === 0 && boxes[0]!.minY === 0 && boxes[0]!.minZ === 0
    && boxes[0]!.maxX === 1 && boxes[0]!.maxY === 1 && boxes[0]!.maxZ === 1
    ? FULL_CUBE
    : {
        boxes,
        supportFaces: boxes.map((box) => ({ top: box.maxY, minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ })),
      };
  shapeCache.set(cacheKey, shape);
  return shape;
}

/** 版本明确的碰撞形状提供器：按 Minecraft 1.20.1 blockstate 解析真实碰撞盒与支撑面；未知形状返回能力缺口，不猜。 */
export const walkCollisionProvider: CollisionShapeProvider = {
  version: 'curio-1.20.1-blockstates-v1',
  resolve(state, _cell, _read) {
    const shape = shapeOf(state);
    if (shape === null) {
      return { kind: 'unsupported_shape', block: serializeBlockState(state), detail: `无法从 1.20.1 blockstate 解析碰撞形状：${state.name}` };
    }
    return { kind: 'shape', shape };
  },
};
