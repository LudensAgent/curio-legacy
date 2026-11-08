import type { Vec3Like } from '../../adapter/types.ts';
import {
  bodyProbe, footSurfaceY, isReplaceable, supportTop,
  type ObservedState, type StateAt,
} from '../../perception/geometry.ts';
import { isSoftBlock, LIQUID_BLOCKS } from '../../perception/surroundings.ts';

/**
 * 基础动作共用的只读几何/库存事实。
 * 这里不移动、不挖、不放、不写记忆，也不替调用者选目标或落点。
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 当前已加载方块的几何状态；只用于碰撞/支撑判断，不用于给未观察方块起名。 */
export function stateAt(
  adapter: { blockAt(pos: Vec3Like): string | null; blockStateAt?(pos: Vec3Like): { properties: Record<string, string | number | boolean> } | null },
  pos: Vec3Like,
): ObservedState | null {
  const name = adapter.blockAt(pos);
  if (name === null) return null;
  const state = adapter.blockStateAt?.(pos);
  // 属性读取器不可用时只保留名字，不把空对象冒充完整 blockstate。
  return state ? { name, properties: state.properties } : { name };
}

/** 把已加载方块读取器固定成一个 StateAt，供多个纯几何函数共用同一快照口径。 */
export const stateReader = (adapter: Parameters<typeof stateAt>[0]): StateAt => (pos) => stateAt(adapter, pos);

/** 目标格的支撑事实：格子本身的状态、该格顶面、以及整列的实际脚高。 */
export function inspectSupport(at: StateAt, cell: Vec3Like) {
  const state = at(cell);
  return {
    cell: { ...cell },
    state,
    top: state === null ? null : supportTop(state.name, state.properties ?? {}),
    foot: footSurfaceY(cell, at),
  };
}

/** 身体 AABB 在 footY/列 (cx,cz) 的阻挡格与未观察格；两者都不能当成“可通行”。 */
export function inspectBody(at: StateAt, footY: number, cx: number, cz: number) {
  const probe = bodyProbe(footY, cx, cz, at);
  return {
    blockers: probe.blockers.map((b) => ({ cell: b.cell, name: b.state.name, state: b.state })),
    unknown: probe.unknown,
  };
}

export interface StandableBelow {
  /** 脚所在的格（可能是空气格，脚面来自它下方那一格）。 */
  footCell: Vec3Like;
  state: ObservedState;
  foot: number;
  drop: number;
}

/**
 * 从 cell 下方逐格找最近的可站立脚面。未知格立即返回 unknown，
 * 不越过未加载区域推断更下面的落点。
 */
export function inspectStandableBelow(at: StateAt, cell: Vec3Like, fromFoot: number, maxDepth = 16): { landing: StandableBelow | null; unknown: boolean } {
  for (let d = 1; d <= maxDepth; d++) {
    const below = { x: cell.x, y: cell.y - d, z: cell.z };
    const state = at(below);
    if (state === null) return { landing: null, unknown: true };
    const foot = footSurfaceY(below, at);
    if (foot !== null) return { landing: { footCell: below, state, foot, drop: fromFoot - foot }, unknown: false };
  }
  return { landing: null, unknown: false };
}

export interface SupportDigLanding {
  cell: Vec3Like;
  state: ObservedState;
  drop: number;
  liquid: boolean;
}

/**
 * 挖脚下支撑格后最先遇到的实心/液体落点。软方块和空气继续向下；
 * 3 格内遇到未知立即标 unknown，不推断下面是否安全。
 */
export function inspectSupportDigRisk(at: StateAt, cell: Vec3Like, maxDepth = 3): { landing: SupportDigLanding | null; unknown: boolean } {
  for (let d = 1; d <= maxDepth; d++) {
    const below = { x: cell.x, y: cell.y - d, z: cell.z };
    const state = at(below);
    if (state === null) return { landing: null, unknown: true };
    if (LIQUID_BLOCKS.has(state.name)) return { landing: { cell: below, state, drop: d, liquid: true }, unknown: false };
    if (!AIR.has(state.name) && !isSoftBlock(state.name)) return { landing: { cell: below, state, drop: d, liquid: false }, unknown: false };
  }
  return { landing: null, unknown: false };
}

export type ObservedKind = 'unknown' | 'air' | 'replaceable' | 'support' | 'solid';

/** 把一个已观察状态归成回执需要的稳定类别；不猜未观察格。 */
export function classifyObserved(state: ObservedState | null): ObservedKind {
  if (state === null) return 'unknown';
  if (AIR.has(state.name)) return 'air';
  if (supportTop(state.name, state.properties ?? {}) !== null) return 'support';
  if (isReplaceable(state.name)) return 'replaceable';
  return 'solid';
}

/** 读取目标格并按调用者的期望判断是否已达成；kind 给失败回执分类。 */
export function reconcileBlockMutation(at: StateAt, cell: Vec3Like, accepts: (state: ObservedState) => boolean) {
  const state = at(cell);
  return { state, kind: classifyObserved(state), matched: state !== null && accepts(state) };
}

/** 把净消耗/同步状态写成回执摘要；库存反而增加时不能说成零消耗。 */
export function consumptionText(receipt: { consumed: number; inventoryDelta: number; inventorySync: string; consumptionPending?: boolean }): string {
  if (receipt.inventorySync === 'conflicted') return `库存差值为 ${receipt.inventoryDelta}（反而增加），无法归因本次消耗`;
  if (receipt.consumptionPending) return '材料消耗未确认（库存尚未反映，不能写成 0）';
  return `净消耗 ${receipt.consumed} 块`;
}

/** 背包里这些物品的总数；放置/垫高的净消耗统一从这里取同一口径。 */
export function countItems(
  adapter: { state(): { inventory: { name: string; count: number }[] } },
  names: string[],
): number {
  return adapter.state().inventory.filter((i) => names.includes(i.name)).reduce((n, i) => n + i.count, 0);
}

/**
 * 放置/垫高后的材料净消耗。看到净减少才算 verified；
 * effectExpected 但暂时没看到减少时标 pending，不把“没观察到”写成真实零消耗。
 * 库存差值只能证明库存变化，不能单独证明来自本次动作；inventorySync 明确这一点：
 * confirmed = 看见净减少；conflicted = 反而增加（同步/并发异常）；pending = 应消耗但尚未反映。
 */
export function consumptionReceipt(
  adapter: { state(): { inventory: { name: string; count: number }[] } },
  names: string[],
  before: number,
  opts: { pendingWhenZero?: boolean } = {},
) {
  const after = countItems(adapter, names);
  const raw = before - after;
  return {
    before, after, consumed: Math.max(0, raw), inventoryDelta: raw, consumptionVerified: raw > 0,
    inventorySync: raw > 0 ? 'confirmed' as const : raw < 0 ? 'conflicted' as const : opts.pendingWhenZero ? 'pending' as const : 'unchanged' as const,
    ...(opts.pendingWhenZero && raw === 0 ? { consumptionPending: true } : {}),
  };
}
