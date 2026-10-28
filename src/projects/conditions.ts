import type { AgentState, BlockObservation, GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import type { Senses } from '../skills/types.ts';
import { dist3 } from '../util.ts';
import { buildingArchiveFor } from '../skills/build.ts';
import { activeDrafts } from '../building/drafts.ts';
import type { Condition, ConditionResult } from './types.ts';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const validPos = (p: unknown): p is Vec3Like => object(p) && finite(p.x, -29_999_984, 29_999_984) && finite(p.z, -29_999_984, 29_999_984) && finite(p.y, -2048, 2048);

export type ConditionPerception = Pick<Percept, 'ts' | 'observation' | 'self' | 'light'>;

export function observationReady(state: AgentState): boolean {
  return state.connected && state.alive && state.observationReady === true && !!state.sessionId &&
    state.observationId !== undefined && !!state.worldId && validPos(state.pos) && !!state.dim;
}

/** Coordinates in block predicates grant no read access: evaluation requires a fresh Vision receipt. */
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
    // 记得的地标、自己的作品工地、建筑师选好的位置，附近（半径以内）都算可信：真人会说“走到工地那儿”
    const near = (p: Vec3Like) => dist3(p, raw.pos) <= Math.max(1, Math.min(16, raw.radius + 2));
    const known = memory.landmarks().some((l) =>
      (!raw.landmarkId || l.id === raw.landmarkId) && l.dim === raw.dimension &&
      (l.kind !== 'resource' || Date.now() - l.ts <= 15 * 60_000) && (raw.landmarkId ? dist3(l.pos, raw.pos) <= 1 : near(l.pos)),
    ) || (!raw.landmarkId && (() => {
      try { return buildingArchiveFor(memory).list().some((p) => p.dimension === raw.dimension && near(p.origin)); } catch { return false; }
    })()) || (!raw.landmarkId && (activeDrafts()?.list(8) ?? []).some((d) => !!d.site && near(d.site)));
    const observed = observationReady(state) && state.worldId === memory.worldId && state.dim === raw.dimension && dist3(state.pos, raw.pos) <= 1;
    if (!known && !observed) throw new Error('位置必须来自当前观测或同一世界内已有的可信记忆');
    return { type: 'location_near', dimension: raw.dimension, pos: { x: raw.pos.x, y: raw.pos.y, z: raw.pos.z }, radius: raw.radius, ...(raw.landmarkId ? { landmarkId: String(raw.landmarkId) } : {}) };
  }
  if (raw.type === 'inventory_full') {
    const free = raw.free_slots ?? raw.freeSlots ?? 0;
    if (!finite(free, 0, 35) || !Number.isInteger(free)) throw new Error('inventory_full 的 free_slots 须为 0–35 的整数');
    return { type: 'inventory_full', free_slots: free };
  }
  if (raw.type === 'all_of' || raw.type === 'any_of') {
    if (!Array.isArray(raw.conditions) || !raw.conditions.length || raw.conditions.length > 16) throw new Error(`${raw.type} 须包含 1–16 个条件`);
    const condition: Condition = { type: raw.type, conditions: raw.conditions.map((c: unknown) => validateCondition(c, adapter, memory, state, depth + 1)) };
    if (JSON.stringify(condition).length > 12_000) throw new Error('验收条件过大');
    return condition;
  }
  if (raw.type === 'self_state') {
    if (raw.field === 'sky_visible' || raw.field === 'underground') return validateCondition({ type: raw.field, equals: raw.equals }, adapter, memory, state, depth);
    if (['inWater', 'inLava', 'onGround'].includes(raw.field) && typeof raw.equals === 'boolean') return { type: 'self_state', field: raw.field, equals: raw.equals };
    if (['held', 'riding'].includes(raw.field) && (raw.equals === null || typeof raw.equals === 'string' && /^[a-z0-9_:-]{1,80}$/.test(raw.equals))) {
      if (raw.field === 'held' && raw.equals !== null && !adapter.isKnownItem(raw.equals)) throw new Error('手持验收包含未知物品');
      return { type: 'self_state', field: raw.field, equals: raw.equals };
    }
    throw new Error('self_state 只支持 held/riding 的具体名称或 null，及 inWater/inLava/onGround 的布尔值');
  }
  if (raw.type === 'sky_visible' || raw.type === 'underground') {
    if (typeof raw.equals !== 'boolean') throw new Error(`${raw.type} 验收条件的 equals 必须是布尔值`);
    return { type: raw.type, equals: raw.equals };
  }
  if (raw.type === 'position_y') {
    if ((raw.min === undefined && raw.max === undefined) || (raw.min !== undefined && !finite(raw.min, -2048, 2048)) ||
      (raw.max !== undefined && !finite(raw.max, -2048, 2048)) || (raw.min !== undefined && raw.max !== undefined && raw.min > raw.max)) {
      throw new Error('position_y 需要有效的 min 或 max，且 min 不能大于 max');
    }
    return { type: 'position_y', ...(raw.min !== undefined ? { min: raw.min } : {}), ...(raw.max !== undefined ? { max: raw.max } : {}) };
  }
  if (raw.type === 'equipment') {
    if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(raw.slot) || !(raw.item === null || typeof raw.item === 'string' && adapter.isKnownItem(raw.item))) throw new Error('装备验收需要有效槽位和具体物品或 null');
    return { type: 'equipment', slot: raw.slot, item: raw.item };
  }
  if (raw.type === 'block_state') {
    if (typeof raw.dimension !== 'string' || !raw.dimension || raw.dimension.length > 100 || !validPos(raw.pos) || !Object.values(raw.pos).every(Number.isInteger)) throw new Error('方块验收需要有效维度和整数坐标');
    if (raw.name !== undefined && (typeof raw.name !== 'string' || !/^[a-z0-9_]{1,80}$/.test(raw.name))) throw new Error('方块名称无效');
    if (raw.properties !== undefined && (!object(raw.properties) || Object.keys(raw.properties).length > 8 || Object.entries(raw.properties).some(([key, value]) =>
      !/^[a-z][a-z0-9_]{0,40}$/.test(key) || !(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 80)))) throw new Error('方块状态最多 8 个有限的属性');
    if (!raw.name && (!raw.properties || !Object.keys(raw.properties).length)) throw new Error('方块验收至少指定 name 或 properties');
    return { type: 'block_state', dimension: raw.dimension, pos: { x: raw.pos.x, y: raw.pos.y, z: raw.pos.z }, ...(raw.name ? { name: raw.name } : {}), ...(raw.properties ? { properties: { ...raw.properties } } : {}) };
  }
  throw new Error(`不支持的事实验收类型: ${String(raw.type)}`);
}

/** Collect a bounded synchronous observation set once, shared by all branches. */
export function observeCondition(condition: Condition, senses?: Pick<Senses, 'observeBlocks'>): BlockObservation[] {
  const targets = new Map<string, Vec3Like>();
  const visit = (c: Condition) => {
    if (c.type === 'all_of' || c.type === 'any_of') c.conditions.forEach(visit);
    else if (c.type === 'block_state' && targets.size < 32) targets.set(JSON.stringify(c.pos), c.pos);
  };
  visit(condition);
  return targets.size ? senses?.observeBlocks?.([...targets.values()]) ?? [] : [];
}

/** Receives one complete adapter snapshot; every branch, including all_of, uses that same snapshot. */
export function evaluateCondition(condition: Condition, state: AgentState, worldId = state.worldId, observations: BlockObservation[] = [], percept?: ConditionPerception): ConditionResult {
  if (!observationReady(state) || state.worldId !== worldId) return { status: 'unknown', actual: null, reason: '没有同一世界的有效存活观测' };
  if (condition.type === 'inventory_min') {
    const count = state.inventory.filter((i) => i.name === condition.item).reduce((sum, i) => sum + i.count, 0);
    if (!Number.isFinite(count) || count < 0) return { status: 'unknown', actual: null, reason: '背包数量无效' };
    return { status: count >= condition.count ? 'satisfied' : 'unsatisfied', actual: { item: condition.item, count, required: condition.count, missing: Math.max(0, condition.count - count) } };
  }
  if (condition.type === 'inventory_full') {
    const free = state.emptySlots;
    if (!Number.isFinite(free) || free < 0) return { status: 'unknown', actual: null, reason: '背包空格数无效' };
    return { status: free <= condition.free_slots ? 'satisfied' : 'unsatisfied', actual: { emptySlots: free, required: condition.free_slots } };
  }
  if (condition.type === 'location_near') {
    const distance = dist3(state.pos, condition.pos);
    return { status: state.dim === condition.dimension && distance <= condition.radius ? 'satisfied' : 'unsatisfied', actual: { dimension: state.dim, pos: { ...state.pos }, distance, requiredDimension: condition.dimension, radius: condition.radius } };
  }
  if (condition.type === 'self_state') {
    const actual = state[condition.field];
    if (actual === undefined) return { status: 'unknown', actual: null, reason: '适配器没有提供该自身状态' };
    return { status: actual === condition.equals ? 'satisfied' : 'unsatisfied', actual: { field: condition.field, value: actual, expected: condition.equals } };
  }
  if (condition.type === 'position_y') {
    const y = state.pos.y;
    return { status: (condition.min === undefined || y >= condition.min) && (condition.max === undefined || y <= condition.max) ? 'satisfied' : 'unsatisfied',
      actual: { y, ...(condition.min !== undefined ? { min: condition.min } : {}), ...(condition.max !== undefined ? { max: condition.max } : {}) } };
  }
  if (condition.type === 'sky_visible' || condition.type === 'underground') {
    const age = percept ? Date.now() - percept.ts : Infinity;
    const p = percept?.observation;
    if (!percept || !p?.ready || p.worldId !== worldId || p.sessionId !== state.sessionId || percept.self.dim !== state.dim || age < 0 || age > 1000 ||
      dist3({ x: percept.self.pos[0], y: percept.self.pos[1], z: percept.self.pos[2] }, state.pos) > .25) {
      return { status: 'unknown', actual: null, reason: '没有当前位置、同会话的新鲜环境感知' };
    }
    const value = condition.type === 'sky_visible' ? percept.self.sky_visible : percept.light?.underground;
    if (typeof value !== 'boolean') return { status: 'unknown', actual: null, reason: '当前感知无法确认天空可见性或地下状态' };
    return { status: value === condition.equals ? 'satisfied' : 'unsatisfied', actual: { field: condition.type, value, expected: condition.equals } };
  }
  if (condition.type === 'equipment') {
    if (condition.slot !== 'hand' && !state.equipment) return { status: 'unknown', actual: null, reason: '适配器没有提供装备栏' };
    const item = condition.slot === 'hand' ? state.held : state.equipment?.find((e) => e.slot === condition.slot)?.name ?? null;
    return { status: item === condition.item ? 'satisfied' : 'unsatisfied', actual: { slot: condition.slot, item, expected: condition.item } };
  }
  if (condition.type === 'block_state') {
    const observed = observations.find((o) => o.source === 'vision' && o.worldId === worldId && o.sessionId === state.sessionId && o.dimension === state.dim &&
      o.dimension === condition.dimension && o.observationId >= state.observationId && Date.now() - o.observedAt >= 0 && Date.now() - o.observedAt <= 1000 && dist3(o.pos, condition.pos) < 0.01);
    if (!observed) return { status: 'unknown', actual: null, reason: '目标没有同会话、当前视野内的有效方块观测；需靠近或转头确认' };
    const matches = (!condition.name || observed.name === condition.name) && Object.entries(condition.properties ?? {}).every(([key, value]) =>
      Object.hasOwn(observed.properties, key) && String(observed.properties[key]) === String(value));
    return { status: matches ? 'satisfied' : 'unsatisfied', actual: observed };
  }
  const children = condition.conditions.map((c) => evaluateCondition(c, state, worldId, observations, percept));
  if (condition.type === 'any_of') return { status: children.some((r) => r.status === 'satisfied') ? 'satisfied' : children.some((r) => r.status === 'unknown') ? 'unknown' : 'unsatisfied', actual: children };
  return { status: children.every((r) => r.status === 'satisfied') ? 'satisfied' : children.some((r) => r.status === 'unknown') ? 'unknown' : 'unsatisfied', actual: children };
}

/** Measured distance/quantity deficits support progress tracking without trusting skill success strings. */
export function conditionDeficit(condition: Condition, state: AgentState, worldId = state.worldId, observations: BlockObservation[] = [], percept?: ConditionPerception): number | null {
  if (!observationReady(state) || state.worldId !== worldId) return null;
  if (condition.type === 'inventory_min') return Math.max(0, condition.count - state.inventory.filter((i) => i.name === condition.item).reduce((n, i) => n + i.count, 0)) / condition.count;
  if (condition.type === 'location_near') return state.dim === condition.dimension ? Math.max(0, dist3(state.pos, condition.pos) - condition.radius) : null;
  if (condition.type === 'inventory_full') return Number.isFinite(state.emptySlots) ? Math.max(0, state.emptySlots - condition.free_slots) / 36 : null;
  if (condition.type === 'any_of') {
    const deficits = condition.conditions.map((c) => conditionDeficit(c, state, worldId, observations, percept)).filter((n): n is number => n !== null);
    return deficits.length ? Math.min(...deficits) : null;
  }
  if (condition.type !== 'all_of') {
    const result = evaluateCondition(condition, state, worldId, observations, percept);
    return result.status === 'unknown' ? null : result.status === 'satisfied' ? 0 : 1;
  }
  const deficits = condition.conditions.map((c) => conditionDeficit(c, state, worldId, observations, percept));
  return deficits.some((n) => n === null) ? null : deficits.reduce<number>((sum, n) => sum + n!, 0);
}
