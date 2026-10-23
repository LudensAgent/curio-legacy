import type { AgentState, GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { dist3 } from '../util.ts';
import type { Condition, ConditionResult } from './types.ts';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const validPos = (p: unknown): p is Vec3Like => object(p) && finite(p.x, -29_999_984, 29_999_984) && finite(p.z, -29_999_984, 29_999_984) && finite(p.y, -2048, 2048);

export function observationReady(state: AgentState): boolean {
  return state.connected && state.alive && state.observationReady === true && !!state.sessionId &&
    state.observationId !== undefined && !!state.worldId && validPos(state.pos) && !!state.dim;
}

/** Validate model specifications using the item registry and observed locations, never model coordinates alone. */
export function validateCondition(raw: unknown, adapter: Pick<GameAdapter, 'isKnownItem'>, memory: WorldMemory, state: AgentState, depth = 0): Condition {
  if (!object(raw) || depth > 4) throw new Error('验收条件必须是受支持的有限条件');
  if (raw.type === 'inventory_min') {
    if (typeof raw.item !== 'string' || !adapter.isKnownItem(raw.item)) throw new Error('验收条件包含未知物品');
    if (!finite(raw.count, 1, 2304) || !Number.isInteger(raw.count)) throw new Error('物品数量须为 1–2304 的整数');
    return { type: 'inventory_min', item: raw.item, count: raw.count };
  }
  if (raw.type === 'location_near') {
    if (typeof raw.dimension !== 'string' || !raw.dimension || raw.dimension.length > 100 || !validPos(raw.pos) || !finite(raw.radius, 0, 256)) {
      throw new Error('位置验收条件的维度、坐标或半径无效');
    }
    const known = memory.landmarks().some((l) =>
      (!raw.landmarkId || l.id === raw.landmarkId) && l.dim === raw.dimension &&
      (l.kind !== 'resource' || Date.now() - l.ts <= 15 * 60_000) && dist3(l.pos, raw.pos) <= 1,
    );
    const observed = observationReady(state) && state.worldId === memory.worldId && state.dim === raw.dimension && dist3(state.pos, raw.pos) <= 1;
    if (!known && !observed) throw new Error('位置必须来自当前观测或同一世界内已有的可信记忆');
    return { type: 'location_near', dimension: raw.dimension, pos: { x: raw.pos.x, y: raw.pos.y, z: raw.pos.z }, radius: raw.radius, ...(raw.landmarkId ? { landmarkId: String(raw.landmarkId) } : {}) };
  }
  if (raw.type === 'all_of') {
    if (!Array.isArray(raw.conditions) || !raw.conditions.length || raw.conditions.length > 16) throw new Error('all_of 须包含 1–16 个条件');
    const condition: Condition = { type: 'all_of', conditions: raw.conditions.map((c: unknown) => validateCondition(c, adapter, memory, state, depth + 1)) };
    if (JSON.stringify(condition).length > 12_000) throw new Error('验收条件过大');
    return condition;
  }
  throw new Error(`不支持的事实验收类型: ${String(raw.type)}`);
}

/** Receives one complete adapter snapshot; every branch, including all_of, uses that same snapshot. */
export function evaluateCondition(condition: Condition, state: AgentState, worldId = state.worldId): ConditionResult {
  if (!observationReady(state) || state.worldId !== worldId) return { status: 'unknown', actual: null, reason: '没有同一世界的有效存活观测' };
  if (condition.type === 'inventory_min') {
    const count = state.inventory.filter((i) => i.name === condition.item).reduce((sum, i) => sum + i.count, 0);
    if (!Number.isFinite(count) || count < 0) return { status: 'unknown', actual: null, reason: '背包数量无效' };
    return { status: count >= condition.count ? 'satisfied' : 'unsatisfied', actual: { item: condition.item, count, required: condition.count, missing: Math.max(0, condition.count - count) } };
  }
  if (condition.type === 'location_near') {
    const distance = dist3(state.pos, condition.pos);
    return { status: state.dim === condition.dimension && distance <= condition.radius ? 'satisfied' : 'unsatisfied', actual: { dimension: state.dim, pos: { ...state.pos }, distance, requiredDimension: condition.dimension, radius: condition.radius } };
  }
  const children = condition.conditions.map((c) => evaluateCondition(c, state, worldId));
  return { status: children.every((r) => r.status === 'satisfied') ? 'satisfied' : children.some((r) => r.status === 'unknown') ? 'unknown' : 'unsatisfied', actual: children };
}

/** Measured distance/quantity deficits support progress tracking without trusting skill success strings. */
export function conditionDeficit(condition: Condition, state: AgentState, worldId = state.worldId): number | null {
  if (!observationReady(state) || state.worldId !== worldId) return null;
  if (condition.type === 'inventory_min') return Math.max(0, condition.count - state.inventory.filter((i) => i.name === condition.item).reduce((n, i) => n + i.count, 0)) / condition.count;
  if (condition.type === 'location_near') return state.dim === condition.dimension ? Math.max(0, dist3(state.pos, condition.pos) - condition.radius) : null;
  const deficits = condition.conditions.map((c) => conditionDeficit(c, state, worldId));
  return deficits.some((n) => n === null) ? null : deficits.reduce<number>((sum, n) => sum + n!, 0);
}
