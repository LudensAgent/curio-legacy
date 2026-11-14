import {
  SECTION_SIZE,
} from 'curio-minecraft-3d-memory';
import type {
  ContainerAnchorFact,
  FactLocation,
  FactPage,
  FactQuery,
  PlaceFact,
  PruneSectionsResult,
  ResourceAnchorFact,
  ResourceFactQuery,
  SectionKey,
  SectionResidency,
  VoxelDirectoryEntry,
  VoxelDirectoryPage,
  VoxelDirectorySummary,
} from 'curio-minecraft-3d-memory';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { ChunkVisitRecord, PlacedBlockRecord, PruneRejectionReason } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { EventBus } from '../events.ts';
import { planRetention, retentionTriggered, sectionKeyId, type RetentionAnchor, type RetentionLimits, type RetentionPlan } from './retention.ts';

/**
 * checkpoint 成功后的空间记忆保留调度。
 *
 * 只在 manual 模式、超过水位且没有其他持久化操作时运行：读取已提交目录、事实、账本和
 * 宿主地标，交给纯选择器决定这一轮忘哪些列，再调用 `pruneSections`。删除成功后把
 * “忘了哪一维、多少 Section/格、这些区域回到未记录”作为事实发布；它不选择玩法目标。
 */

export type RetentionSettings = {
  enabled: boolean;
  trigger: number;
  target: number;
  maxSectionsPerPass: number;
  maxCellsPerPass: number;
  keepHalo: number;
  keepVisits: number;
  cooldownMs: number;
};

/** 本模块实际使用的会话表面（真实 SpatialSession 结构上满足；测试可用桩）。 */
export type RetentionSession = {
  readonly voxelLoading: 'eager' | 'manual';
  readonly busy: boolean;
  voxelDirectoryStats(): VoxelDirectorySummary;
  directoryPage(options?: { after?: number; limit?: number }): Promise<VoxelDirectoryPage>;
  sectionResidency(key: SectionKey): { residency: SectionResidency };
  pruneSections(keys: readonly SectionKey[]): Promise<PruneSectionsResult>;
  facts: {
    places(query?: FactQuery): FactPage<PlaceFact>;
    resources(query?: ResourceFactQuery): FactPage<ResourceAnchorFact>;
    containers(query?: FactQuery): FactPage<ContainerAnchorFact>;
  };
  ledger: {
    placedBlocks(dim?: string | null): PlacedBlockRecord[];
    chunkVisits(dim?: string): ChunkVisitRecord[];
  };
};

export type RetentionMemory = {
  base(dim?: string): { dim: string; pos: { x: number; y: number; z: number } } | undefined;
  landmarks(): readonly { dim: string; pos: { x: number; y: number; z: number } }[];
};

export type RetentionRunnerDeps = {
  worldId: string;
  session: RetentionSession;
  settings: RetentionSettings;
  limits: RetentionLimits;
  memory: RetentionMemory;
  bus: Pick<EventBus, 'publish'>;
  current: () => { dim: string; pos: { x: number; y: number; z: number } };
};

export type RetentionRun = {
  status: 'disabled' | 'eager' | 'cooling' | 'busy' | 'below_trigger' | 'nothing' | 'pruned';
  plan?: RetentionPlan;
  deleted?: number;
};

const PAGE = 512;

export class RetentionRunner {
  private lastAttemptAt = Number.NEGATIVE_INFINITY;

  constructor(private deps: RetentionRunnerDeps) {}

  async run(now = Date.now()): Promise<RetentionRun> {
    const { session, settings, limits } = this.deps;
    if (!settings.enabled) return { status: 'disabled' };
    if (session.voxelLoading !== 'manual') return { status: 'eager' };
    if (now - this.lastAttemptAt < settings.cooldownMs) return { status: 'cooling' };
    if (session.busy) return { status: 'busy' };
    const totals = session.voxelDirectoryStats();
    // 与 planRetention 共用触发口径；先做这个廉价判断，避免水位以下还去分页整个目录。
    if (!retentionTriggered(totals, limits, settings.trigger)) return { status: 'below_trigger' };
    // 冷却从真正开始尝试算起：准备/删除期间不会因下一次 checkpoint 再触发一轮。
    this.lastAttemptAt = now;

    const entries = await this.readDirectory();
    const protectedKeys = entries
      .filter((entry) => {
        const residency = session.sectionResidency(entry.key).residency;
        return residency === 'resident' || residency === 'loading';
      })
      .map((entry) => entry.key);
    const plan = planRetention({
      worldId: this.deps.worldId,
      entries,
      totals,
      limits,
      anchors: this.anchors(),
      hotChunks: this.hotChunks(),
      protectedKeys,
      trigger: settings.trigger,
      target: settings.target,
      maxSectionsPerPass: settings.maxSectionsPerPass,
      maxObservedCellsPerPass: settings.maxCellsPerPass,
      keepHalo: settings.keepHalo,
    });
    if (plan.keys.length === 0) {
      // 保留集本身占满目标时没有可删的列；如实报告，不让“没有事件”看起来像没超过水位。
      if (plan.reason === 'keep_exceeds_target') {
        this.deps.bus.publish('spatial_retention', 'P3',
          `空间记忆裁剪：保留集本身已达到目标水位，这一轮没有删除；保留的 ${plan.keepSections} 个 Section（约 ${plan.keepObservedCells} 格）仍然记得`,
          { deleted: 0, reason: plan.reason, keepSections: plan.keepSections, keepObservedCells: plan.keepObservedCells });
      }
      return { status: 'nothing', plan };
    }

    const result = await session.pruneSections(plan.keys).catch((error: unknown) => {
      // busy/closing 是“稍后再试”，不是裁剪失败；冷却从本次尝试算起，下一轮再压。
      if (error instanceof PersistenceError && (error.kind === 'busy' || error.kind === 'closing')) return null;
      throw error;
    });
    if (result === null) return { status: 'busy' };
    if (result.deleted.length === 0) {
      this.deps.bus.publish('spatial_retention', 'P3',
        `空间记忆裁剪：这一轮没有删除；计划删除的 ${result.rejected.length} 个 Section 都没有删除${rejectionNote(result.rejected)}，它们仍然记得`,
        { deleted: 0, rejected: result.rejected.length, ...rejectedReasons(result.rejected), reason: plan.reason });
      return { status: 'nothing', plan };
    }
    // 只按真正删除的 key 计数：库可能因驻留/pinned/dirty/已不存在拒绝一部分，
    // 那些区域仍然记得，不能把它们写进“已遗忘”的事实。
    const entryOf = new Map(entries.map((entry) => [sectionKeyId(entry.key), entry]));
    const perDimension = result.deleted.reduce((map, key) => {
      const entry = entryOf.get(sectionKeyId(key));
      if (entry === undefined) return map;
      const current = map.get(key.dim) ?? { sections: 0, observedCells: 0 };
      map.set(key.dim, { sections: current.sections + 1, observedCells: current.observedCells + entry.observedCells });
      return map;
    }, new Map<string, { sections: number; observedCells: number }>());
    const parts = [...perDimension].map(([dim, value]) => `${dim} ${value.sections} 个 Section（约 ${value.observedCells} 格）`);
    const keptNote = plan.reason === 'keep_exceeds_target' ? '；保留集本身已接近目标，这一轮只能压到这里' : '';
    const rejectedNote = result.rejected.length > 0 ? `；另有 ${result.rejected.length} 个 Section 本轮未删除${rejectionNote(result.rejected)}` : '';
    this.deps.bus.publish('spatial_retention', 'P2',
      `空间记忆裁剪：忘记了 ${parts.join('、')}${keptNote}${rejectedNote}；这些区域现在未记录（不是空气，也不代表可通行或不可通行）；保留了基地、资源点、容器、传送门、自建方块、热点区域和当前路线`,
      {
        deleted: result.deleted.length,
        rejected: result.rejected.length,
        ...rejectedReasons(result.rejected),
        observedCells: [...perDimension.values()].reduce((sum, value) => sum + value.observedCells, 0),
        dims: [...perDimension.keys()],
        perDimension: [...perDimension].map(([dim, value]) => ({ dim, ...value })),
        reason: plan.reason,
        keepSections: plan.keepSections,
      });
    return { status: 'pruned', plan, deleted: result.deleted.length };
  }

  private async readDirectory(): Promise<VoxelDirectoryEntry[]> {
    const entries: VoxelDirectoryEntry[] = [];
    let after: number | undefined;
    for (;;) {
      const page = await this.deps.session.directoryPage({ ...(after === undefined ? {} : { after }), limit: PAGE });
      entries.push(...page.items);
      if (page.nextAfter === undefined) return entries;
      after = page.nextAfter;
    }
  }

  /** 事实、账本、宿主地标与当前身体位置：全部是“不能忘”的锚点。 */
  private anchors(): RetentionAnchor[] {
    const { session, memory } = this.deps;
    const current = this.deps.current();
    const base = memory.base(current.dim);
    const facts = <T>(read: (query: { limit: number; after?: string }) => FactPage<T>) =>
      readAll((after) => read({ limit: PAGE, ...(after === undefined ? {} : { after }) }));
    return [
      ...facts((query) => session.facts.places(query))
        .flatMap((place): RetentionAnchor[] => place.location.kind === 'exact'
          ? [{ dim: place.dim, pos: place.location.pos, halo: true }]
          : areaAnchors(place.dim, place.location)),
      ...facts((query) => session.facts.resources(query))
        .map((resource) => ({ dim: resource.dim, pos: resource.sourceCell })),
      ...facts((query) => session.facts.containers(query))
        .map((container) => ({ dim: container.dim, pos: container.pos, halo: true })),
      ...session.ledger.placedBlocks()
        .flatMap((placed): RetentionAnchor[] => placed.dim === null ? [] : [{ dim: placed.dim, pos: placed.pos }]),
      ...memory.landmarks().map((landmark) => ({ dim: landmark.dim, pos: landmark.pos })),
      ...(base === undefined ? [] : [{ dim: base.dim, pos: base.pos, halo: true }]),
      { dim: current.dim, pos: current.pos, halo: true },
    ];
  }

  /** 每维度访问次数最高的 chunk 列。 */
  private hotChunks(): { dim: string; cx: number; cz: number }[] {
    const byDim = this.deps.session.ledger.chunkVisits().reduce((map, visit) => {
      const list = map.get(visit.dim);
      if (list === undefined) map.set(visit.dim, [visit]);
      else list.push(visit);
      return map;
    }, new Map<string, ChunkVisitRecord[]>());
    return [...byDim].flatMap(([dim, visits]) => [...visits]
      .sort((a, b) => b.count - a.count)
      .slice(0, this.deps.settings.keepVisits)
      .map((visit) => ({ dim, cx: visit.cx, cz: visit.cz })));
  }
}

const REJECTION_LABELS: Record<PruneRejectionReason, string> = {
  resident: '驻留中', dirty: '未保存', pinned: '被路线占用', not_found: '已不存在',
};

/** 把库的逐 key 拒绝原因压成事实计数；消息与 data 使用同一份结果。 */
const rejectedReasons = (rejected: readonly { reason: PruneRejectionReason }[]) =>
  rejected.reduce<Partial<Record<PruneRejectionReason, number>>>((counts, { reason }) => {
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});

const rejectionNote = (rejected: readonly { reason: PruneRejectionReason }[]): string => {
  const counts = rejectedReasons(rejected);
  return rejected.length === 0 ? '' : `（${Object.entries(counts).map(([reason, count]) => `${REJECTION_LABELS[reason as PruneRejectionReason]} ${count}`).join('、')}）`;
};

/** 区域事实（如多格工作站/农场）：把覆盖半径内的每个 Section 都锚定（halo 仍由选择器统一扩）。 */
function areaAnchors(dim: string, location: Extract<FactLocation, { kind: 'area' }>): RetentionAnchor[] {
  const { center, radius } = location;
  const sections = (value: number) => {
    const low = Math.floor((value - radius) / SECTION_SIZE);
    const high = Math.floor((value + radius) / SECTION_SIZE);
    return Array.from({ length: high - low + 1 }, (_, index) => (low + index) * SECTION_SIZE + SECTION_SIZE / 2);
  };
  return sections(center.x).flatMap((x) => sections(center.y).flatMap((y) =>
    sections(center.z).map((z) => ({ dim, halo: true, pos: { x, y, z } }))));
}

/** 有界分页读取事实；`nextAfter` 是库提供的互斥游标。 */
function readAll<T>(page: (after: string | undefined) => FactPage<T>): T[] {
  const items: T[] = [];
  let after: string | undefined;
  for (;;) {
    const result = page(after);
    items.push(...result.items);
    if (result.nextAfter === undefined) return items;
    after = result.nextAfter;
  }
}
