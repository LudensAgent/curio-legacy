import type { GameAdapter, Vec3Like } from '../adapter/types.ts';
import { compileBuilding, materialCost, PHASES, type BuildingSpec } from './spec.ts';
import { planScaffolding } from './scaffold.ts';

/**
 * 建造顺序规划（只读）：把“先放哪些、哪些格要先造临时支撑”摆成事实。
 * 它不选建筑、不施工、不消耗材料；整座小屋也可以交给 build 的简单 spec 自动完成。
 * spec 模式坐标是 blueprint 本地坐标（origin/rotation 由 build 决定）；cells 模式坐标是世界坐标。
 */
export type PlanPos = [number, number, number];
export type SupportKind = 'existing' | 'temporary' | 'placed' | 'unknown' | 'none';
export interface PlanTarget { pos: Vec3Like; name: string }
export interface PlanCell { pos: PlanPos; name: string; support: SupportKind }
export interface ConstructionPlan {
  mode: 'spec' | 'cells';
  phases?: { phase: string; cells: { pos: PlanPos; name: string }[] }[];
  order: { y: number; cells: PlanCell[] }[];
  temporary: { pos: PlanPos; name: string; why: string }[];
  materials?: Record<string, number>;
  temporaryMaterials?: Record<string, number>;
  warnings: string[];
  notes: string[];
}

const AIR = new Set(['air', 'cave_air', 'void_air']);
/** 危险/不可站的支撑面：不能当地面，但岩浆块这类仍有碰撞面可以贴。 */
const HAZARD = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow']);
/** 没有可贴实心面的方块（流体、火焰、传送门、光）。 */
const NON_FACE = new Set(['water', 'lava', 'fire', 'soul_fire', 'powder_snow', 'campfire', 'soul_campfire', 'nether_portal', 'end_portal', 'end_gateway', 'light']);
/** 薄/可穿过的方块不算可贴的实心面。 */
const THIN = /(^|_)(torch|flower|sapling|short_grass|tall_grass|fern|bush|vine|rail|carpet|button|lever|redstone_wire|door|bed|fence|pane|sign|banner)(_|$)/;
const N6: Vec3Like[] = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }];
const N4: Vec3Like[] = N6.filter((d) => d.y === 0);
const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
const tuple = (p: Vec3Like): PlanPos => [p.x, p.y, p.z];
const faceSolid = (name: string | null) => name !== null && !AIR.has(name) && !NON_FACE.has(name) && !THIN.test(name);
const count = (cells: Iterable<{ name: string }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of cells) out[c.name] = (out[c.name] ?? 0) + 1;
  return out;
};

export function planConstruction(
  adapter: GameAdapter,
  input: { spec?: BuildingSpec; cells?: PlanTarget[]; keepClear?: Vec3Like[]; maxSupport?: number },
): ConstructionPlan {
  if (input.spec) {
    const blueprint = compileBuilding(input.spec);
    const scaffold = planScaffolding(blueprint);
    return {
      mode: 'spec',
      phases: PHASES.map((phase) => ({
        phase,
        cells: blueprint.cells.filter((c) => c.phase === phase)
          .sort((a, b) => a.pos.y - b.pos.y || a.pos.z - b.pos.z || a.pos.x - b.pos.x)
          .map((c) => ({ pos: tuple(c.pos), name: c.name })),
      })).filter((p) => p.cells.length > 0),
      order: [],
      temporary: scaffold.map((c) => ({ pos: tuple(c.pos), name: c.name, why: 'house 脚手架' })),
      materials: materialCost(blueprint.cells),
      temporaryMaterials: count(scaffold),
      warnings: input.spec.layout === 'house' ? [] : ['custom 布局没有自动脚手架；按 cells 规划或自己决定临时支撑'],
      notes: [
        'phases 按 foundation → frame → enclosure → roof → openings → facilities；每阶段内按 y 从下往上。',
        input.spec.layout === 'house'
          ? 'house 的 build 会规划并放置脚手架，完工后按记录拆除；脚手架材料不足时会停在够不到的格。'
          : 'custom 布局的 build 不规划脚手架。',
        '这里的坐标是 blueprint 本地坐标（origin、rotation 由 build 决定）；cells 模式才是世界坐标。',
      ],
    };
  }

  const targets = dedupeTargets(input.cells ?? []);
  if (!targets.length) return { mode: 'cells', order: [], temporary: [], warnings: ['没有可规划的 cells'], notes: [] };
  const targetKeys = new Set(targets.map((c) => key(c.pos)));
  const keepClear = new Set((input.keepClear ?? []).map(key));
  const maxSupport = input.maxSupport ?? 6;
  const placed = new Set<string>();
  const temporary = new Map<string, { pos: Vec3Like; why: string }>();
  const unknown = new Map<string, Vec3Like>();
  const warnings: string[] = [];
  const order: { y: number; cells: PlanCell[] }[] = [];
  const seen = new Map<string, string | null>();
  const worldName = (p: Vec3Like) => {
    const k = key(p);
    if (!seen.has(k)) seen.set(k, adapter.blockAt(p));
    const name = seen.get(k)!;
    if (name === null) unknown.set(k, { ...p });
    return name;
  };
  const neighbor = (p: Vec3Like, d: Vec3Like) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
  const hasFace = (p: Vec3Like) => N6.some((d) => {
    const n = neighbor(p, d), k = key(n);
    return temporary.has(k) || placed.has(k) || faceSolid(worldName(n));
  });
  const supportKind = (p: Vec3Like): SupportKind => {
    const rank: Record<SupportKind, number> = { none: 0, unknown: 1, temporary: 2, placed: 3, existing: 4 };
    let kind: SupportKind = 'none';
    const see = (next: SupportKind) => { if (rank[next] > rank[kind]) kind = next; };
    for (const d of N6) {
      const n = neighbor(p, d), k = key(n);
      if (temporary.has(k)) see('temporary');
      else if (placed.has(k)) see('placed');
      else if (worldName(n) === null) see('unknown');
      else if (faceSolid(worldName(n))) see('existing');
    }
    return kind;
  };
  const free = (p: Vec3Like) => !targetKeys.has(key(p)) && !keepClear.has(key(p)) && !temporary.has(key(p));
  const findGround = (p: Vec3Like): Vec3Like | 'unknown' | null => {
    for (let d = 1; d <= maxSupport; d++) {
      const n = { x: p.x, y: p.y - d, z: p.z }, name = worldName(n);
      if (name === null) return 'unknown';
      if (HAZARD.has(name)) return null;
      if (faceSolid(name)) return n;
    }
    return null;
  };
  /** 从 ground 上方垫到 top（含 top）的整列临时支撑；中途被占就换一面，不放弃其它方向。 */
  const column = (ground: Vec3Like, top: Vec3Like): Vec3Like[] | 'blocked' => {
    const cells: Vec3Like[] = [];
    for (let y = ground.y + 1; y <= top.y; y++) {
      const p = { x: top.x, y, z: top.z };
      if (!free(p)) return 'blocked';
      cells.push(p);
    }
    return cells;
  };
  const planSupport = (target: Vec3Like): { pos: Vec3Like; why: string } | 'unknown' | null => {
    const options: { n: Vec3Like; why: string }[] = [];
    // 先找同一层旁边能直接贴的格：已贴面或已放目标都算；没有就试从地面垫柱。
    for (const d of N4) options.push({ n: neighbor(target, d), why: '旁边垫柱' });
    options.push({ n: { x: target.x, y: target.y - 1, z: target.z }, why: '下方垫柱' });
    let sawUnknown = false;
    for (const { n, why } of options) {
      if (!free(n)) continue;
      if (hasFace(n)) {
        temporary.set(key(n), { pos: { ...n }, why: '旁边贴面' });
        return { pos: n, why: '旁边贴面' };
      }
      const ground = findGround(n);
      if (ground === 'unknown') { sawUnknown = true; continue; }
      if (ground === null) continue;
      const cells = column(ground, n);
      if (cells === 'blocked') continue;
      for (const p of cells) temporary.set(key(p), { pos: p, why });
      return { pos: n, why };
    }
    return sawUnknown ? 'unknown' : null;
  };

  const layers = [...new Set(targets.map((c) => c.pos.y))].sort((a, b) => a - b);
  for (const y of layers) {
    const pending = targets.filter((c) => c.pos.y === y);
    const layerCells: PlanCell[] = [];
    let guard = 0;
    while (pending.length && guard++ < targets.length * 4) {
      const ready = pending.filter((c) => hasFace(c.pos));
      if (ready.length) {
        for (const c of ready) {
          layerCells.push({ pos: tuple(c.pos), name: c.name, support: supportKind(c.pos) });
          placed.add(key(c.pos));
        }
        for (const c of ready) pending.splice(pending.indexOf(c), 1);
        continue;
      }
      const c = pending[0]!;
      const support = planSupport(c.pos);
      if (support === 'unknown') {
        warnings.push(`(${c.pos.x},${c.pos.y},${c.pos.z}) 周围有未加载/看不清的格，无法确认贴面或支撑；先靠近看清`);
        layerCells.push({ pos: tuple(c.pos), name: c.name, support: 'unknown' });
        pending.shift();
        continue;
      }
      if (support === null) {
        warnings.push(`(${c.pos.x},${c.pos.y},${c.pos.z}) 周围和下方 ${maxSupport} 格内没有确认的实心面（可能是未加载）；需要先垫参照或换个位置`);
        layerCells.push({ pos: tuple(c.pos), name: c.name, support: supportKind(c.pos) });
        pending.shift();
        continue;
      }
      // 临时支撑加入后，下一轮循环会把它当作可贴面。
    }
    if (layerCells.length) order.push({ y, cells: layerCells });
  }
  if (unknown.size) {
    const sample = [...unknown.values()].slice(0, 6).map((p) => `(${p.x},${p.y},${p.z})`).join('、');
    warnings.push(`${unknown.size} 处格未加载/看不清：${sample}${unknown.size > 6 ? ' 等' : ''}；这些格按未知处理，既不能当空气也不能当实心面`);
  }
  return {
    mode: 'cells',
    order,
    temporary: [...temporary.values()].sort((a, b) => a.pos.y - b.pos.y || a.pos.z - b.pos.z || a.pos.x - b.pos.x)
      .map((t) => ({ pos: tuple(t.pos), name: 'any_solid', why: t.why })),
    materials: count(targets),
    temporaryMaterials: { any_solid: temporary.size },
    warnings,
    notes: [
      'order 按层从下往上，同一层按可贴面排先后；support 的 existing=现有方块、placed=本计划里先放的目标、temporary=先放的临时支撑、unknown=看不清、none=没有确认的贴面。',
      'temporary 是不在 order 里的格子：要给邻近目标提供贴面得先垫上，材料是任意实心方块（any_solid），不是必须某一种；放不放、用哪种由你决定。',
      '有面可贴不等于站得到：实际还要站到目标 4.4 格内、视线可达。',
      '整座小屋/屋顶也可以用 build 简单 spec（程序带脚手架和逐格验收）。',
    ],
  };
}

function dedupeTargets(cells: readonly PlanTarget[]): PlanTarget[] {
  const out = new Map<string, PlanTarget>();
  for (const c of cells) {
    if (!out.has(key(c.pos))) out.set(key(c.pos), { pos: { ...c.pos }, name: c.name });
  }
  return [...out.values()];
}
