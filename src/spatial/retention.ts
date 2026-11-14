import type { SectionKey, SnapshotLimits, VoxelDirectoryEntry, VoxelDirectorySummary } from 'curio-minecraft-3d-memory';

/**
 * 已提交体素的有界保留选择器（纯函数）。
 *
 * 只在总量超过水位时给出“这一轮删哪些 Section”：先构建必须保留的集合（事实/基地/自建/
 * 热点/当前现场/运行时保护），再按 chunk 列分组、按年龄与大小排序，按预算选出可删的列。
 * 它不删除、不加载、不观察、不改上限，也不选择玩法目标；真正执行由调用方在 checkpoint
 * 成功后交给 `SpatialSession.pruneSections`。
 */

/** 必须保留的地点：hard 锚点保留周围一个 halo，precise 锚点只保留所在 Section。 */
export type RetentionAnchor = {
  dim: string;
  pos: { x: number; y: number; z: number };
  /** 地点/容器/基地等需要接近路径的锚点；资源格、自己放过的方块等单位置锚点不写。 */
  halo?: boolean;
};

/** 与库的可重开校验使用同一组容量字段（库的 SnapshotLimits 必填化）。 */
export type RetentionLimits = Required<Pick<SnapshotLimits, 'maxVoxelSections' | 'maxObservedCells' | 'maxPaletteEntries' | 'maxBytes'>>;

export type RetentionPlanInput = {
  worldId: string;
  /** 已提交 Section 目录（worker 分页读出的全部条目）。 */
  entries: readonly VoxelDirectoryEntry[];
  /** 当前已提交总量（worker 或目录统计的权威值）。 */
  totals: VoxelDirectorySummary;
  limits: RetentionLimits;
  anchors: readonly RetentionAnchor[];
  /** 每维度访问次数最高的 chunk 列；整列的已提交 Section 都保留。 */
  hotChunks?: readonly { dim: string; cx: number; cz: number }[];
  /** 运行时不能删的 key（驻留/pinned/当前路线依赖），由调用方提供。 */
  protectedKeys?: readonly SectionKey[];
  trigger: number;
  target: number;
  /** 单轮最多删除的 Section 数；调用方必须保证不超过库单批上限 512（批次 3 的配置校验）。 */
  maxSectionsPerPass: number;
  /** 单轮最多释放的观测格数（默认 200k），与 Section 数一起约束一次裁剪。 */
  maxObservedCellsPerPass: number;
  keepHalo: number;
};

export type RetentionColumnPlan = {
  dim: string;
  cx: number;
  cz: number;
  /** 列内最早的提交序号（越老越先忘）。 */
  age: number;
  /** 列内最小的 section revision（最近被重写过的后忘）。 */
  revision: number;
  sections: number;
  observedCells: number;
  paletteEntries: number;
  bytes: number;
};

export type RetentionPlan = {
  /** 按列顺序展开的待删 Section key。 */
  keys: SectionKey[];
  /** 本轮选中的列及其排序依据，供审计“为什么忘了这一片”。 */
  columns: RetentionColumnPlan[];
  keepSections: number;
  keepObservedCells: number;
  projected: { sections: number; observedCells: number; paletteEntries: number; bytes: number };
  reason: 'below_trigger' | 'planned' | 'max_sections_per_pass' | 'no_eligible_columns' | 'keep_exceeds_target';
};

/** Section 的稳定身份字符串；宿主侧执行裁剪后也用它把结果对应回目录条目。 */
export const sectionKeyId = (key: SectionKey) => `${key.dim}|${key.cx}|${key.cz}|${key.sy}`;
const columnId = (dim: string, cx: number, cz: number) => `${dim}|${cx}|${cz}`;
const projected = (totals: VoxelDirectorySummary) => ({
  sections: totals.sections,
  observedCells: totals.observedCells,
  paletteEntries: totals.paletteEntries,
  bytes: totals.bytes,
});

/** Aggregate one column (or the selected prefix of one) into its plan row. */
const summarize = (first: VoxelDirectoryEntry, entries: readonly VoxelDirectoryEntry[]): RetentionColumnPlan =>
  entries.reduce<RetentionColumnPlan>((column, entry) => ({
    dim: column.dim, cx: column.cx, cz: column.cz,
    age: Math.min(column.age, entry.seq),
    revision: Math.min(column.revision, entry.revision),
    sections: column.sections + 1,
    observedCells: column.observedCells + entry.observedCells,
    paletteEntries: column.paletteEntries + entry.paletteEntries,
    bytes: column.bytes + entry.bytes,
  }), {
    dim: first.key.dim, cx: first.key.cx, cz: first.key.cz,
    age: Number.POSITIVE_INFINITY, revision: Number.POSITIVE_INFINITY,
    sections: 0, observedCells: 0, paletteEntries: 0, bytes: 0,
  });

/** 任一项容量达到 trigger 水位（含等号）；宿主调度与选择器共用这一口径。 */
export function retentionTriggered(totals: VoxelDirectorySummary, limits: RetentionLimits, trigger: number): boolean {
  return totals.sections >= trigger * limits.maxVoxelSections
    || totals.observedCells >= trigger * limits.maxObservedCells
    || totals.paletteEntries >= trigger * limits.maxPaletteEntries
    || totals.bytes >= trigger * limits.maxBytes;
}

/** 选择这一轮要遗忘的已提交 Section；不满足水位时返回空计划。 */
export function planRetention(input: RetentionPlanInput): RetentionPlan {
  const current = projected(input.totals);
  const target = {
    sections: input.target * input.limits.maxVoxelSections,
    observedCells: input.target * input.limits.maxObservedCells,
    paletteEntries: input.target * input.limits.maxPaletteEntries,
    bytes: input.target * input.limits.maxBytes,
  };
  // 达到水位就触发（等号也算），不是“超过”才触发。
  if (!retentionTriggered(input.totals, input.limits, input.trigger)) {
    return { keys: [], columns: [], keepSections: 0, keepObservedCells: 0, projected: current, reason: 'below_trigger' };
  }

  const keep = new Set<string>();
  const keepSection = (dim: string, cx: number, cz: number, sy: number) =>
    keep.add(sectionKeyId({ worldId: input.worldId, dim, cx, cz, sy }));
  for (const anchor of input.anchors) {
    const cx = Math.floor(anchor.pos.x / 16), cz = Math.floor(anchor.pos.z / 16), sy = Math.floor(anchor.pos.y / 16);
    const halo = anchor.halo === true ? input.keepHalo : 0;
    const offsets = Array.from({ length: 2 * halo + 1 }, (_, i) => i - halo);
    offsets
      .flatMap((dx) => offsets.flatMap((dz) => offsets.map((dy) => ({ cx: cx + dx, cz: cz + dz, sy: sy + dy }))))
      .forEach((cell) => keepSection(anchor.dim, cell.cx, cell.cz, cell.sy));
  }
  const hotColumns = new Set((input.hotChunks ?? []).map((chunk) => columnId(chunk.dim, chunk.cx, chunk.cz)));
  input.entries
    .filter((entry) => hotColumns.has(columnId(entry.key.dim, entry.key.cx, entry.key.cz)))
    .forEach((entry) => keep.add(sectionKeyId(entry.key)));
  for (const key of input.protectedKeys ?? []) keep.add(sectionKeyId(key));

  const columns = input.entries.reduce((map, entry) => {
    const id = columnId(entry.key.dim, entry.key.cx, entry.key.cz);
    const list = map.get(id);
    if (list === undefined) map.set(id, [entry]);
    else list.push(entry);
    return map;
  }, new Map<string, VoxelDirectoryEntry[]>());
  const kept = input.entries.filter((entry) => keep.has(sectionKeyId(entry.key)));
  const keepSections = kept.length;
  const keepObservedCells = kept.reduce((sum, entry) => sum + entry.observedCells, 0);
  const keepPaletteEntries = kept.reduce((sum, entry) => sum + entry.paletteEntries, 0);
  const keepBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  const keepExceedsTarget = keepSections > target.sections || keepObservedCells > target.observedCells
    || keepPaletteEntries > target.paletteEntries || keepBytes > target.bytes;

  const eligible = [...columns.values()].flatMap((entries): RetentionColumnPlan[] => {
    if (entries.some((entry) => keep.has(sectionKeyId(entry.key)))) return [];
    const [first] = entries;
    if (first === undefined) return [];
    return [summarize(first, entries)];
  });
  // 老列先忘；同龄时先忘观测格多的列（同样代价释放更多预算）；再按最近重写时间后忘。
  eligible.sort((a, b) => a.age - b.age || b.observedCells - a.observedCells || a.revision - b.revision);

  const projectedTotals = projected(input.totals);
  const chosen: RetentionColumnPlan[] = [];
  const keys: SectionKey[] = [];
  let limited = false;
  const met = () => projectedTotals.sections <= target.sections && projectedTotals.observedCells <= target.observedCells
    && projectedTotals.paletteEntries <= target.paletteEntries && projectedTotals.bytes <= target.bytes;
  const take = (column: RetentionColumnPlan, columnKeys: readonly SectionKey[]) => {
    chosen.push(column);
    keys.push(...columnKeys);
    projectedTotals.sections = Math.max(0, projectedTotals.sections - column.sections);
    projectedTotals.observedCells = Math.max(0, projectedTotals.observedCells - column.observedCells);
    projectedTotals.paletteEntries = Math.max(0, projectedTotals.paletteEntries - column.paletteEntries);
    projectedTotals.bytes = Math.max(0, projectedTotals.bytes - column.bytes);
  };
  // 早停循环：达到目标就停止扫描；改成 reduce 也只能提前 break 一次，不会更可读。
  for (const column of eligible) {
    if (met()) break;
    const columnEntries = columns.get(columnId(column.dim, column.cx, column.cz)) ?? [];
    const sectionRoom = input.maxSectionsPerPass - keys.length;
    const cellRoom = input.maxObservedCellsPerPass - (input.totals.observedCells - projectedTotals.observedCells);
    if (sectionRoom <= 0 || cellRoom <= 0) { limited = true; break; }
    if (column.sections <= sectionRoom && column.observedCells <= cellRoom) {
      take(column, columnEntries.map((entry) => ({ ...entry.key })));
      continue;
    }
    // 预算只够这一列的一部分：按 seq 从老到新截断到 Section 粒度（设计允许的最后一刀）。
    // 严格前缀：一旦某一格放不进就停，不跳过老的去挑更小的。
    const prefixEntries: VoxelDirectoryEntry[] = [];
    let prefixCells = 0;
    for (const entry of [...columnEntries].sort((a, b) => a.seq - b.seq)) {
      if (prefixEntries.length >= sectionRoom || prefixCells + entry.observedCells > cellRoom) break;
      prefixEntries.push(entry);
      prefixCells += entry.observedCells;
    }
    const [firstPrefix] = prefixEntries;
    if (firstPrefix !== undefined) take(summarize(firstPrefix, prefixEntries), prefixEntries.map((entry) => ({ ...entry.key })));
    limited = true;
    break;
  }
  const reason: RetentionPlan['reason'] = met() ? 'planned'
    : keepExceedsTarget ? 'keep_exceeds_target'
      : limited ? 'max_sections_per_pass'
        : keys.length === 0 ? 'no_eligible_columns' : 'planned';
  return { keys, columns: chosen, keepSections, keepObservedCells, projected: projectedTotals, reason };
}
