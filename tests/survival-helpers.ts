import type { BlockHit, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Senses, SkillCtx } from '../src/skills/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 在 FakeAdapter 之上加几个测试便利：直接改方块、瞬移式寻路、可设 onGround */
export class TestWorld extends FakeAdapter {
  onGround = true;
  constructor() { super(); this.speed = 100000; }
  setBlock(pos: Vec3Like, name: string) {
    this.blocks = this.blocks.filter((b) => b.pos.x !== pos.x || b.pos.y !== pos.y || b.pos.z !== pos.z);
    if (name === 'air') this.removed.add(`${pos.x},${pos.y},${pos.z}`);
    else { this.removed.delete(`${pos.x},${pos.y},${pos.z}`); this.blocks.push({ pos: { ...pos }, name }); }
  }
  override state() { return { ...super.state(), onGround: this.onGround }; }
}

/** 建筑测试用：寻路瞬移到目标旁边，挖/放立即生效 */
export class InstantBuildWorld extends TestWorld {
  override async moveTo(target: any, opts: any) {
    throwIfAborted(opts.signal);
    if (target.pos) this.pos = { x: target.pos.x - 1, y: 64, z: target.pos.z };
    this.actions.push('move');
  }
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    throwIfAborted(signal);
    const name = this.blockAt(pos);
    this.actions.push(`dig:${name}`);
    this.setBlock(pos, 'air');
    if (name === 'crafting_table' || name === 'furnace') this.inv.set(name, (this.inv.get(name) ?? 0) + 1);
    return { ok: true };
  }
  override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
    throwIfAborted(signal);
    const name = names.find((n) => (this.inv.get(n) ?? 0) > 0);
    if (!name) return { ok: false, reason: 'NO_ITEM' };
    if (this.blockAt(pos) !== 'air') return { ok: true };
    this.setBlock(pos, name);
    this.inv.set(name, this.inv.get(name)! - 1);
    this.actions.push(`place:${name}`);
    return { ok: true };
  }
}

/** 无遮挡的模拟观察：把每个已加载格（含默认地面/石头/空气）都当作当前看得见，供需要真实支撑/净空的 step 用例。 */
export const observeAllBlocks = (adapter: FakeAdapter) => (positions: Vec3Like[]) => positions
  .filter((pos) => adapter.blockAt(pos) !== null)
  .map((pos) => ({ pos, name: adapter.blockAt(pos)!, properties: adapter.blockStateAt?.(pos)?.properties ?? {}, worldId: adapter.worldId, sessionId: adapter.sessionId, dimension: adapter.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const }));

export function stubSenses(adapter: FakeAdapter, extra: Partial<Senses> = {}): Senses {
  const placed = () => new Set(adapter.blocks.map((b) => `${b.pos.x},${b.pos.y},${b.pos.z}`));
  return {
    perceivedEntities: (r) => adapter.nearbyEntities(r),
    // “看得见的”方块 = 测试里显式放下的方块（地面默认的草/石头不算）
    knownBlocks: (names, maxDist): BlockHit[] => adapter.findBlocks(names, maxDist, 256),
    // 测试里显式放下的方块视为“看得见”，让 dig_at/place_at 能走到确认这一步；要模拟遮挡，测试自己传 observeBlocks
    observeBlocks: (positions) => {
      const seen = placed();
      return positions.filter((pos) => seen.has(`${pos.x},${pos.y},${pos.z}`))
        .map((pos) => ({ pos, name: adapter.blockAt(pos) ?? 'air', properties: adapter.blockStateAt?.(pos)?.properties ?? {}, worldId: adapter.worldId, sessionId: adapter.sessionId, dimension: adapter.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const }));
    },
    refresh() {}, markSweep() {},
    nearestLand: () => null,
    ...extra,
  };
}

export function makeCtx(adapter: FakeAdapter, opts: { memory?: WorldMemory; senses?: Partial<Senses>; deadlineMs?: number } = {}): SkillCtx {
  return {
    adapter, memory: opts.memory ?? new WorldMemory(null), bus: new EventBus(), signal: new AbortController().signal,
    deadline: Date.now() + (opts.deadlineMs ?? 60000), taskId: 'test', progress() {}, senses: stubSenses(adapter, opts.senses),
  };
}
