import { chestHint } from './chest-hint.ts';
import type { ConstructionResult } from '../building/engine.ts';
import { materialPlan } from '../methods/shortfall.ts';
import { findStation, rememberStation } from './stations.ts';
import { checkSiteAt, describeSiteFailure, projectRect, surveyBuildSite, type SiteRect } from '../building/site.ts';
import { ownStationsAt } from '../building/engine.ts';
import type { BuildingProject } from '../building/archive.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { BuildingArchive } from '../building/archive.ts';
import { activeDrafts } from '../building/drafts.ts';
import { constructBuilding } from '../building/engine.ts';
import { compileBuilding, DEFAULT_SPEC, materialCost, normalizeSpec, rotatePosition, type BuildingSpec, type Rotation } from '../building/spec.ts';
import type { WorldMemory } from '../memory/store.ts';
import { sleep as delay, throwIfAborted } from '../util.ts';
import { canSleepAt } from '../perception/perception.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { compileDesign, DESIGN_EXAMPLE, DESIGN_EXAMPLE_RICH } from '../building/design.ts';

export const BLUEPRINTS = {
  hut: { description: '5×5 带木门、玻璃窗和阶梯坡顶的小屋' },
  big_hut: { description: '7×7 带木门、玻璃窗和阶梯坡顶的小屋' },
  pillar: { description: '3 格高的柱子' },
  wall: { description: '5 格宽、2 格高的墙' },
};
const archives = new WeakMap<WorldMemory, BuildingArchive>();
export function buildingArchiveFor(memory: WorldMemory): BuildingArchive {
  let archive = archives.get(memory);
  if (!archive) { archive = new BuildingArchive(memory.dataDirectory); archives.set(memory, archive); }
  return archive;
}
/**
 * 这一格是不是自己盖的房子的一部分（图纸上要有方块、而且现场确实是那种方块；脚手架、地基下面的土不算）。
 * 缺料时把自家墙拆下来当料，build 回头又报缺这一格去补——拆东墙补西墙的死循环。采集/拆除动作先问一下这里。
 */
const footprints = new Map<string, Map<string, string>>();
export function ownBuildingAt(memory: WorldMemory, state: { worldId: string; dim: string }, pos: Vec3Like, blockName?: string | null): { id: string; name: string } | null {
  const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  let projects: readonly BuildingProject[];
  try { projects = buildingArchiveFor(memory).listRef(); } catch { return null; }
  for (const project of projects) {
    if (project.worldId !== state.worldId || project.dimension !== state.dim) continue;
    const spec = project.versions.at(-1)?.spec;
    if (!spec) continue;
    const reach = Math.max(spec.width ?? 16, spec.depth ?? 16, 8) + 2;
    if (Math.abs(p.x - project.origin.x) > reach || Math.abs(p.z - project.origin.z) > reach || p.y < project.origin.y - 1 || p.y > project.origin.y + (spec.height ?? 16) + 4) continue;
    const key = `${project.id}@${project.versions.length}@${project.origin.x},${project.origin.y},${project.origin.z}@${project.rotation}`;
    let cells = footprints.get(key);
    if (!cells) {
      cells = new Map();
      try {
        for (const c of compileBuilding(spec).cells) {
          if (!c.name || /air$/.test(c.name)) continue;
          const w = rotatePosition(c.pos, project.origin, project.rotation);
          cells.set(`${w.x},${w.y},${w.z}`, c.name);
        }
      } catch { /* 图纸坏了就不管 */ }
      footprints.set(key, cells);
      if (footprints.size > 64) footprints.delete(footprints.keys().next().value!);
    }
    const want = cells.get(`${p.x},${p.y},${p.z}`);
    if (!want) continue;
    if (project.temporaryBlocks?.some((t) => t.pos.x === p.x && t.pos.y === p.y && t.pos.z === p.z)) continue;
    // 现场是图纸上的那种方块（门、床这种按名字前缀也认）才算；被换成了别的（掉下来的沙子、长进来的草）不算
    if (blockName && blockName !== want && blockName.replace(/^.*?_/, '') !== want.replace(/^.*?_/, '')) continue;
    return { id: project.id, name: spec.name ?? project.id.slice(0, 8) };
  }
  return null;
}

/** 记得里面存着东西的箱子：挖掉它东西会洒一地（还常被岩浆、水冲走）。返回给心智看的说明，不是就 null */
export function storedChestAt(memory: WorldMemory, state: { dim: string }, pos: Vec3Like, blockName?: string | null): string | null {
  if (blockName && !/chest|barrel/.test(blockName)) return null;
  const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  const rec = memory.chests(state.dim).find((c) => c.pos.x === p.x && c.pos.y === p.y && c.pos.z === p.z);
  if (!rec) return null;
  const remembered = [...new Set(rec.contents.items.map((i) => i.name))];
  const what = remembered.length ? `存着 ${remembered.slice(0, 4).join('、')}${remembered.length > 4 ? ' 等' : ''} ` : '自己用过、里面可能还有东西';
  return `(${p.x},${p.y},${p.z}) 是${what}的箱子，没拆。要拿东西可用 take_items 指定这个箱子，或 use_gui 查看；打不开时返回实际原因，不会自行挖盖。真要搬箱子写 "own":true，东西会洒一地`;
}

export const OWN_BUILDING_HINT = '拆了拿料，build 回头还会报缺这一格，又去补——拆东墙补西墙。缺料就去采（collect）或从箱子里拿；真要拆（开个门、困在里面出不去、改建）写 "own":true';

/** 自己别的作品占着的地（没盖完的、放弃的、盖好的都算）：新工地不和它们重叠；except 是正在续建的那座 */
export function ownFootprints(archive: BuildingArchive, worldId: string, dim: string, except?: string): SiteRect[] {
  return archive.listRef().filter((p) => p.worldId === worldId && p.dimension === dim && p.id !== except && p.versions.length)
    .map((p) => { const r = projectRect(p.origin, p.rotation, p.versions.at(-1)!.spec); return { minX: r.minX - 1, maxX: r.maxX + 1, minZ: r.minZ - 1, maxZ: r.maxZ + 1 }; });
}

/**
 * 认定一座作品“这样就行了”（accept）或“不要了”（abandon）。
 * 真人盖房不会为屋顶一块台阶放成木板就一直补下去：能进门、能挡怪，觉得够了就收工；地方选错了、烂尾了就放下。
 * 由心智自己（或听了操作者、观众的话）决定，程序只记下这个决定，并把家设在收了工的房子里。
 */
export function settleBuild(memory: WorldMemory, projectId: string, how: 'accept' | 'abandon', by: 'agent' | 'operator' | 'audience', note: string): { ok: true; project: BuildingProject; text: string } | { ok: false; error: string } {
  const archive = buildingArchiveFor(memory);
  const old = archive.get(projectId);
  if (!old) return { ok: false, error: `没有建筑档案 ${projectId}` };
  const name = old.versions.at(-1)?.spec.name ?? old.id.slice(0, 8);
  const left = old.inspections.at(-1)?.defects.length ?? 0;
  if (how === 'abandon') {
    const project = archive.abandon(old.id, note);
    return { ok: true, project, text: `「${name}」不要了：不再续建、不再惦记（占着的地新工地会避开；想重拾就 build {"projectId":"${old.id}"}）` };
  }
  const project = archive.accept(old.id, by, note);
  try {
    const blueprint = compileBuilding(normalizeSpec(structuredClone(project.versions.at(-1)!.spec)));
    if (blueprint.home) {
      const home = rotatePosition(blueprint.home, project.origin, project.rotation);
      memory.setBase(project.dimension, home, name);
      memory.addLandmark('discovery', `我的${name}`, project.dimension, home, 4);
    }
  } catch { /* 图纸编译不了就只记状态 */ }
  return { ok: true, project, text: `「${name}」按能住收工了${left ? `（逐格看还差 ${left} 处，不再惦记；以后想补写 build {"projectId":"${old.id}","mode":"repair"}）` : ''}` };
}

interface BuildArgs {
  blueprint: string;
  spec?: BuildingSpec;
  origin?: Vec3Like;
  rotation?: Rotation;
  projectId?: string;
  mode: 'build' | 'inspect' | 'repair' | 'accept' | 'abandon';
  reason?: string;
  cells?: [number, number, number][];
}

const tally = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}×${c}`).join('、');

/** 把逐格缺陷归成几句人话：整地做了什么、什么东西挡着、地基哪里不行、还差多少块没放 */
/** 家具和灯：不影响房子能不能住，缺了以后再摆 */
const FURNISHING = /^(furnace|blast_furnace|smoker|chest|barrel|crafting_table|lantern|soul_lantern|torch|wall_torch|[a-z_]+_bed|bookshelf|flower_pot|[a-z_]+_carpet|anvil|cartography_table|loom|composter)$/;

export function describeBuildProblems(result: ConstructionResult): string {
  const out: string[] = [];
  const site = result.site;
  if (site && (Object.keys(site.cleared).length || site.filled)) out.push(`整地清掉了 ${tally(site.cleared) || '0 块'}${site.filled ? `，填了 ${site.filled} 个坑` : ''}`);
  if (site && Object.keys(site.blocked).length) out.push(`场地里有 ${tally(site.blocked)} 挡着（不是自然方块，没有动它）`);
  const d = result.inspection.defects;
  const terrain: Record<string, number> = {}, obstruct: Record<string, number> = {}, unknown = d.filter((x) => x.kind === 'unknown').length;
  let missingCells = 0;
  for (const x of d) {
    if (x.kind === 'terrain') terrain[String(x.actual ?? '?')] = (terrain[String(x.actual ?? '?')] ?? 0) + 1;
    else if ((x.kind === 'obstruction' || x.kind === 'wrong_block') && x.actual) obstruct[x.actual] = (obstruct[x.actual] ?? 0) + 1;
    else if (x.kind === 'missing') missingCells++;
  }
  if (Object.keys(terrain).length) out.push(`地基不行：${tally(terrain).replace('void_or_unsupported', '下面悬空太深')}——换一块更平、没有水和岩浆的地方（换 origin）`);
  if (Object.keys(obstruct).length) out.push(`还有 ${tally(obstruct)} 占着房子的位置`);
  if (unknown) out.push(`${unknown} 处还看不清/区块没加载，走近再来`);
  if (missingCells) {
    // 缺的块集中在高处：多半是站在地上够不着（施工不会自己搭脚手架），说清楚在哪一层，好让它先垫脚或搭台阶上去
    const missing = d.filter((x) => x.kind === 'missing');
    const ys = missing.map((x) => x.pos.y), low = Math.min(...ys), high = Math.max(...ys);
    const top = missing.filter((x) => x.pos.y >= high - 1).length;
    // 只给事实：哪几格、要放什么、施工时为什么没放上（够不着、没路……）。怎么上去由它自己想、自己学
    const why = new Map((result.failures ?? []).map((f) => [f.cellId, String(f.reason ?? '')]));
    const highCells = missing.filter((x) => x.pos.y >= high - 1).slice(0, 8)
      .map((x) => `(${x.pos.x},${x.pos.y},${x.pos.z}) ${x.expected}${why.get(x.cellId) ? `：${why.get(x.cellId)!.slice(0, 40)}` : ''}`);
    const reachNote = high - low >= 3 && top >= missing.length / 2
      ? `，其中 ${top} 块在最高的 y=${high - 1}~${high}（比最低的缺口高 ${high - low} 格；施工时人站在地上、不搭柱子）：${highCells.join('；')}。这些格子也可以自己用 place_at 放（放的人得站在离它 4 格以内），放好后 mode:"inspect" 验收`
      : '';
    out.push(`还有 ${missingCells} 块没放上${reachNote}`);
  }
  if (d.length) out.push(`具体缺陷：${d.slice(0, 3).map((x) => `${x.kind} @ (${x.pos.x},${x.pos.y},${x.pos.z}) expected=${x.expected}, actual=${x.actual ?? 'unknown'}`).join('；')}${d.length > 3 ? `；其余 ${d.length - 3} 处见 inspection.defects` : ''}`);
  if (d.some((x) => x.kind === 'obstruction')) out.push('占位先按上述绝对坐标确认方块及归属，再定点处理；goto 只到附近，随后按方位 dig 可能挖到别的墙；处理后用 mode:"inspect" 复验');
  if (d.some((x) => ['missing', 'wrong_block', 'wrong_state'].includes(x.kind))) out.push('缺块/结构错位用 mode:"repair" 按原档案修补；改变布局需同时提交新 spec');
  if (unknown) out.push('走近上述坐标加载区块后，用 mode:"inspect" 重新检查');
  return out.length ? `${out.join('；')}。` : '';
}

/** 上次验收是不是地形问题（水、岩浆、悬空、地基不承重）——这种工地接着盖也是白盖 */
export function terrainProblem(project: BuildingProject): string | null {
  const last = project.inspections.at(-1);
  if (!last || last.complete) return null;
  const bad = last.defects.filter((d) => d.kind === 'terrain');
  if (!bad.length) return null;
  const names = [...new Set(bad.map((d) => d.actual === 'void_or_unsupported' ? '下面悬空' : String(d.actual ?? '?')))].slice(0, 3).join('、');
  return `地基不行（${names}）`;
}
/** 在同一个 origin 连着施工停滞（动了手、不缺料、缺陷没减少）的次数；纯缺料的失败不算 */
export function stalledFailures(project: BuildingProject): number {
  return project.stalls ?? 0;
}

/** 盖完后把收起来的工作台/熔炉放回房子外边（一圈里找下面有实地的空位） */
async function restoreStations(ctx: Parameters<Skill['run']>[0], project: BuildingProject, spec: BuildingSpec, kinds: string[]): Promise<string[]> {
  const placed: string[] = [];
  const spots: Vec3Like[] = [];
  for (let k = 0; k < spec.depth; k++) spots.push({ x: spec.width + 1, y: 0, z: k });
  for (let k = 0; k < spec.width; k++) spots.push({ x: k, y: 0, z: spec.depth + 1 });
  for (const kind of kinds) {
    if (!ctx.adapter.state().inventory.some((i) => i.name === kind && i.count > 0)) continue;
    for (const local of spots) {
      const pos = rotatePosition(local, project.origin, project.rotation);
      const below = ctx.adapter.blockAt({ ...pos, y: pos.y - 1 });
      if (ctx.adapter.blockAt(pos) !== 'air' || !below || ['air', 'cave_air', 'water', 'lava'].includes(below)) continue;
      try {
        await ctx.adapter.moveTo({ kind: 'place_block', pos }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(10000, ctx.deadline - Date.now())), constructionSafe: true });
        const r = await ctx.adapter.placeBlockAt(pos, [kind], ctx.signal);
        if (r.ok && ctx.adapter.blockAt(pos) === kind) { rememberStation(ctx, kind, pos); placed.push(kind); break; }
      } catch (e) { if (isAbort(e)) throw e; }
    }
  }
  return placed;
}

export const build: Skill<BuildArgs> = {
  name: 'build',
  description: '照图施工：有建筑师画好的图纸就写 draft（推荐）；也可以自己设计：spec.design 用字符画分层画出每格放什么（legend 字符→方块，layers 从地板往上，"." 留空，门写下半格），想要什么样就画什么样。程序负责选址（不给 origin 会在附近找干燥平地并整平；给的地方不合适会就近换）、分阶段施工、逐格验收；料不全也照样开工，手上有的先盖（墙基墙身先起来），缺的报给你，补齐后用 projectId 接着盖；返回作品 ID，中断后用 projectId 续建，inspect 检查、repair 修补；觉得够住了就 accept 收工，不想要了就 abandon（是不是“够了”自己判断，不必逐格完美）。',
  argsDoc: '{"draft":"dr_…"}（新房子：照建筑师的图纸盖）｜{"projectId":"作品ID","mode"?:"build|inspect|repair"}（接着盖、检查、修补已有作品）｜{"mode":"accept|abandon"}（够住了收工 / 不要了）；可选 "origin":{"x":0,"y":64,"z":0}、"rotation":0|90|180|270。图纸先用 {"kind":"design"} 请建筑师画，不要自己写 spec',
  timeoutMs: 600000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    // 把图纸 ID 当成作品 ID 写进 projectId（记混了）：图纸已经开工的换成它的作品，还没开工的当作照图施工
    if (typeof a.projectId === 'string' && /^dr_/i.test(a.projectId.trim())) {
      const d = activeDrafts()?.get(a.projectId.trim());
      if (!d) return { ok: false, error: `${a.projectId} 是图纸 ID 的写法，但没有这张图纸；作品 ID 是 build 返回的那串（不带 dr_）` };
      if (d.usedBy) a.projectId = d.usedBy;
      else { a.draft = d.id; delete a.projectId; }
    }
    // 建筑师画好的图纸：只给 draft ID 就照图施工
    if (typeof a.draft === 'string' && !a.spec && !a.projectId) {
      const draft = activeDrafts()?.get(a.draft);
      if (!draft) return { ok: false, error: `没有图纸 ${a.draft}；先用建筑师设计（{"kind":"design","brief":"…"}），或者直接给 spec` };
      a.spec = draft.spec; a.reason ??= `按图纸 ${draft.id}（${draft.name}）施工`;
      // 建筑师看过地形挑了位置：照着那儿、按图纸的朝向盖（不合适 build 会就近另找）
      if (draft.site && a.origin === undefined) { a.origin = { ...draft.site }; a.rotation ??= 0; }
    }
    const blueprint = String(a.blueprint ?? (a.spec ? 'custom' : 'hut'));
    // 房子由自己设计（spec.design 字符画），不再从预制蓝图里挑；prefab 只给兼容规则模式和测试用
    if (!a.spec && !a.projectId && ['hut', 'big_hut'].includes(blueprint) && a.prefab !== true && (a.mode ?? 'build') === 'build')
      return { ok: false, error: `房子要自己设计（最好先请建筑师画图纸：思考时输出 {"kind":"design","brief":"…"}，再 build {"draft":"dr_…"}）；或者直接写 spec={"name":"…","design":{legend,layers}}。layers 从下往上（第 0 层地板），每层的行从前（北）到后，一个字符一个方块，"." 留空、空格不管，门只写下半格。例如 spec.design=${DESIGN_EXAMPLE_RICH}` };
    if (!Object.hasOwn(BLUEPRINTS, blueprint) && blueprint !== 'custom') return { ok: false, error: '未知蓝图；可用 hut/big_hut/pillar/wall/custom' };
    if (a.projectId !== undefined && (typeof a.projectId !== 'string' || !a.projectId.trim() || a.projectId.length > 100)) return { ok: false, error: 'projectId 需要有效作品 ID' };
    if (!['build', 'inspect', 'repair', 'accept', 'abandon'].includes(a.mode ?? 'build')) return { ok: false, error: 'mode 支持 build/inspect/repair/accept/abandon' };
    if (a.rotation !== undefined && ![0, 90, 180, 270].includes(a.rotation)) return { ok: false, error: 'rotation 支持 0/90/180/270' };
    if (a.origin !== undefined && (!a.origin || typeof a.origin !== 'object' || [a.origin.x, a.origin.y, a.origin.z].some((n) => !Number.isInteger(n) || Math.abs(n) > 30000000))) return { ok: false, error: 'origin 需要合法整数坐标' };
    if (a.reason !== undefined && (typeof a.reason !== 'string' || a.reason.length > 1000)) return { ok: false, error: 'reason 最多 1000 字符' };
    let spec: BuildingSpec | undefined;
    try {
      if (a.spec !== undefined) { spec = normalizeSpec(a.spec); compileBuilding(spec); }
      if (spec && adapter && Object.keys(materialCost(compileBuilding(spec).cells)).some((name) => !adapter.isKnownItem(name))) return { ok: false, error: '设计包含当前游戏版本不存在的物品' };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    let cells: [number, number, number][] | undefined;
    if (blueprint === 'custom' && !spec && !a.projectId) {
      if (!Array.isArray(a.cells) || !a.cells.length || a.cells.length > 150 || a.cells.some((c: any) => !Array.isArray(c) || c.length !== 3 || c.some((v: any) => !Number.isInteger(v) || Math.abs(v) > 12))) return { ok: false, error: 'custom 需要 1-150 个绝对值 ≤12 的 [dx,dy,dz]，或完整 spec' };
      cells = a.cells.map((c: number[]) => [c[0], c[1], c[2]]);
      if (new Set(cells!.map((c) => c.join(','))).size !== cells!.length) return { ok: false, error: 'cells 坐标不能重复' };
    }
    return { ok: true, args: { blueprint, spec, origin: a.origin, rotation: a.rotation, projectId: a.projectId, mode: a.mode ?? 'build', reason: a.reason, cells } };
  },
  async run(ctx, args) {
    try {
      throwIfAborted(ctx.signal);
      const state = ctx.adapter.state();
      if (!state.connected || !state.alive || !ctx.adapter.eye()) return fail('NOT_CONNECTED', '未连接或尚未存活');
      const archive = buildingArchiveFor(ctx.memory);
      if (args.mode === 'accept' || args.mode === 'abandon') {
        // 没给 projectId：最近一座没盖完的
        const id = args.projectId
          ? archive.list().find((p) => p.id === args.projectId || p.id.startsWith(args.projectId!))?.id
          : archive.list().filter((p) => p.worldId === state.worldId && p.dimension === state.dim && p.status !== 'complete' && p.status !== 'abandoned')
            .sort((a, b) => Math.hypot(a.origin.x - state.pos.x, a.origin.z - state.pos.z) - Math.hypot(b.origin.x - state.pos.x, b.origin.z - state.pos.z))[0]?.id;
        if (!id) return fail('NOT_FOUND', args.projectId ? `没有建筑档案 ${args.projectId}` : '附近没有没盖完的作品');
        const r = settleBuild(ctx.memory, id, args.mode, 'agent', args.reason ?? (args.mode === 'accept' ? '觉得能住了' : '不想要了'));
        if (!r.ok) return fail('NOT_FOUND', r.error);
        ctx.bus.publish(args.mode === 'accept' ? 'build_accepted' : 'build_abandoned', 'P2', r.text, { projectId: id, by: 'agent' });
        return ok(r.text, { projectId: id, status: r.project.status });
      }
      // 忘了作品 ID 也没关系：附近有没盖完的房子就接着盖（像玩家回到工地），而不是在旁边另起一座
      const near = (p: Vec3Like) => Math.hypot(p.x - (args.origin ?? state.pos).x, p.z - (args.origin ?? state.pos).z) <= (args.origin ? 6 : 16);
      const nearby = !args.projectId && args.mode === 'build' ? archive.list()
        .filter((p) => p.worldId === state.worldId && p.dimension === state.dim && p.status !== 'complete' && p.status !== 'abandoned' && near(p.origin)
          && (!args.origin || (args.origin.x === p.origin.x && args.origin.y === p.origin.y && args.origin.z === p.origin.z))
          && (args.rotation === undefined || args.rotation === p.rotation))
        .sort((a, b) => b.updatedAt - a.updatedAt) : [];
      // 地形不行、或在原地反复失败都没进展的工地不自动接着盖：换地方另起（明确给了 projectId/origin 的除外）
      const notes: string[] = [];
      // 地基有地形问题的工地永远不自动续建（给了同一个 origin 也不续）；原地停滞的只在明确给了 origin 时续
      const abandoned = nearby.map((p) => {
        const terrain = terrainProblem(p);
        return { p, terrain: !!terrain, why: terrain ?? (stalledFailures(p) >= 3 ? `在原地失败了 ${stalledFailures(p)} 次没有进展` : null) };
      });
      const resumed = abandoned.find((x) => !x.why || (args.origin && !x.terrain))?.p;
      const skippedSite = !resumed ? abandoned.find((x) => x.why) : undefined;
      // 不再接着盖的旧工地：标成放弃，免得它一直挂在“没盖完”里、和新工地互相打架（位置会被新选址避开）
      if (skippedSite) { try { archive.abandon(skippedSite.p.id, skippedSite.why ?? '不在那里接着盖'); } catch { /* 档案写不进去不影响施工 */ } }
      if (skippedSite) notes.push(`附近没盖完的「${skippedSite.p.versions.at(-1)?.spec.name ?? skippedSite.p.id.slice(0, 8)}」${skippedSite.why}，不在那里接着盖，换了块地另起`);
      const projectId = args.projectId ?? resumed?.id;
      const old = projectId ? archive.get(projectId.length < 36 ? archive.list().find((p) => p.id.startsWith(projectId))?.id ?? projectId : projectId) : undefined;
      if (resumed) ctx.bus.publish('build_resume', 'P3', `附近有没盖完的「${resumed.versions.at(-1)?.spec.name ?? resumed.id.slice(0, 8)}」，接着盖它`);
      if (projectId && !old) return fail('NOT_FOUND', `没有建筑档案 ${projectId}`);
      if ((args.mode === 'inspect' || args.mode === 'repair') && !old) return fail('BAD_ARGS', `${args.mode} 需要已有 projectId`);
      if (old && old.dimension !== state.dim) return fail('WRONG_DIMENSION', `建筑位于 ${old.dimension}，当前为 ${state.dim}`);
      if (old && old.worldId !== state.worldId) return fail('WRONG_DIMENSION', '作品属于另一个世界，当前不能施工或验收');
      let spec = args.spec ?? old?.versions.at(-1)?.spec;
      if (!spec) {
        if (args.blueprint === 'pillar' || args.blueprint === 'wall' || args.blueprint === 'custom') {
          const positions = args.blueprint === 'pillar' ? [[0, 0, 0], [0, 1, 0], [0, 2, 0]] : args.blueprint === 'wall' ? Array.from({ length: 10 }, (_, i) => [i % 5 - 2, Math.floor(i / 5), 0]) : args.cells!;
          const material = state.inventory.find((i) => /^(cobblestone|stone|dirt|[a-z_]+_planks)$/.test(i.name) && i.count > 0)?.name ?? 'cobblestone';
          spec = normalizeSpec({ name: args.blueprint, purpose: '自定义建筑', layout: 'custom', components: positions.map(([x, y, z]) => ({ pos: { x, y, z }, name: material, phase: 'frame' })) });
        } else spec = normalizeSpec({ ...DEFAULT_SPEC, ...(args.blueprint === 'big_hut' ? { name: 'hut_7x7', width: 7, depth: 7, budget: 1024 } : {}) });
      }
      const rotation = args.rotation ?? old?.rotation ?? ((Math.round(ctx.adapter.eye()!.yaw / (Math.PI / 2)) * 90 + 360) % 360) as Rotation;
      let rot = rotation;
      let origin = old ? old.origin : args.origin;
      // 已有作品的位置不能改：同时给了 projectId 和不同的 origin 时照原位置施工，并说清楚
      if (old && args.origin && (args.origin.x !== old.origin.x || args.origin.y !== old.origin.y || args.origin.z !== old.origin.z)) {
        notes.push(`作品 ${old.id.slice(0, 8)} 的位置固定在 (${old.origin.x},${old.origin.y},${old.origin.z})，忽略了给的 origin (${args.origin.x},${args.origin.y},${args.origin.z})；想换地方就不写 projectId 另起一座`);
      }
      // 只勘察站在附近看得见的地形：给的 origin 离得远就先走过去再看（不隔着老远读地形）
      if (origin && !old && args.mode === 'build' && spec.layout === 'house') {
        const here = ctx.adapter.state().pos;
        const far = Math.hypot(origin.x - here.x, origin.z - here.z);
        if (far > 24) {
          ctx.progress(0.02, `先走到给的 origin 附近（${Math.round(far)} 格）看看地形`);
          try { await ctx.adapter.moveTo({ kind: 'near', pos: origin, range: 6 }, { signal: ctx.signal, timeoutMs: Math.max(3000, Math.min(90000, ctx.deadline - Date.now() - 60000)) }); }
          catch (e) { if (isAbort(e)) throw e; return fail(codeFromError(e), `给的 origin (${origin.x},${origin.y},${origin.z}) 在 ${Math.round(far)} 格外，走不过去：${(e as Error).message}；先 goto 到那附近再 build`); }
        }
      }
      const own = [...ownStationsAt(ctx).keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; });
      const rotations = args.rotation !== undefined ? [args.rotation] : [rotation, ...([0, 90, 180, 270] as Rotation[]).filter((r) => r !== rotation)];
      let surveyFrom: { center?: Vec3Like; radius: number; why?: string } | null = origin ? null : { radius: 24 };
      // 模型给了 origin（新工地）：先按同样的标准看一眼那块地，不合适就在它附近 16 格内另找
      if (origin && !old && args.mode === 'build' && spec.layout === 'house') {
        const check = checkSiteAt(ctx.adapter, ctx.memory, spec, origin, rotation, own, ownFootprints(archive, state.worldId, state.dim));
        if (check.ok) {
          if (check.origin.y !== origin.y) notes.push(`origin 的 y 按地面校正为 ${check.origin.y}`);
          origin = check.origin;
        } else surveyFrom = { center: origin, radius: 16, why: check.why };
      }
      if (surveyFrom) {
        // 先看看附近的地形，挑一块平整、干燥、没出过事的空地，再走过去
        const survey = surveyBuildSite(ctx.adapter, ctx.memory, spec, { radius: surveyFrom.radius, rotations, ownStations: own, avoid: ownFootprints(archive, state.worldId, state.dim), ...(surveyFrom.center ? { center: surveyFrom.center } : {}) });
        const given = surveyFrom.center;
        if (!survey.best) return fail('NOT_FOUND', `${given ? `原定位置（${given.x},${given.y},${given.z}）不合适（${surveyFrom.why}）；` : ''}${describeSiteFailure(survey, spec, surveyFrom.radius)}${notes.length ? `；${notes.join('；')}` : ''}`, { survey: { checked: survey.checked, rejected: survey.rejected, hint: survey.hint } });
        origin = survey.best.origin; rot = survey.best.rotation;
        const lv = survey.best.cut + survey.best.fill ? `；附近没有现成的平地，这块要先整地：铲掉约 ${survey.best.cut} 块、填约 ${survey.best.fill} 块` : '';
        notes.push((given
          ? `原定位置不合适（${surveyFrom.why}），改在 (${origin.x},${origin.y},${origin.z})`
          : `选了 ${survey.best.dist} 格外一块${survey.best.cut + survey.best.fill ? '坡地' : `${survey.best.spread ? '基本' : ''}平整、干燥的空地`}（${origin.x},${origin.y},${origin.z}）`) + lv);
        ctx.bus.publish('build_site', 'P3', `选址：${origin.x},${origin.y},${origin.z}（旋转 ${rot}°，比较了 ${survey.checked} 个位置）`);
        const center = rotatePosition({ x: Math.floor(spec.width / 2), y: 0, z: Math.floor(spec.depth / 2) }, origin, rot);
        const here = ctx.adapter.state().pos;
        if (Math.hypot(center.x - here.x, center.z - here.z) > 6) {
          ctx.progress(0.02, `走到选好的空地（${survey.best.dist} 格）`);
          try { await ctx.adapter.moveTo({ kind: 'near', pos: center, range: 3 }, { signal: ctx.signal, timeoutMs: Math.max(3000, Math.min(45000, ctx.deadline - Date.now() - 60000)) }); }
          catch (e) { if (isAbort(e)) throw e; return fail(codeFromError(e), `选好的空地（${origin.x},${origin.y},${origin.z}）走不过去：${(e as Error).message}；换个方向再试或直接给 origin`); }
        }
      }
      if (!origin) return fail('ERROR', '没有确定施工位置');
      const blueprint = compileBuilding(spec);
      const project = archive.design({ id: old?.id, worldId: state.worldId, dimension: state.dim, origin, rotation: rot, spec, materials: materialCost(blueprint.cells), reason: args.reason });
      const draftId = args.reason?.match(/图纸 (dr_[a-z0-9]+)/)?.[1];
      if (draftId) activeDrafts()?.markUsed(draftId, project.id);
      const before = project.inspections.at(-1)?.defects.length;
      const result = await constructBuilding(ctx, archive, project, blueprint, args.mode);
      throwIfAborted(ctx.signal);
      {
        // 停滞判定：动了手（放了或试着放了方块）、不是缺料、缺陷却没比上次少
        const attempted = result.placed > 0 || result.failures.length > 0;
        const missing = Object.keys(result.missingMaterials).length > 0;
        const defectsBefore = before ?? Infinity;
        archive.noteAttempt(project.id, result.inspection.complete ? false : missing || !attempted ? null : result.inspection.defects.length >= defectsBefore);
      }
      const data = { ...result, designVersion: project.versions.at(-1)!.version, origin: project.origin, rotation: project.rotation };
      const stowed = result.site?.stowed ?? [];
      if (stowed.length) {
        const back = result.inspection.complete ? await restoreStations(ctx, archive.get(project.id) ?? project, spec, stowed) : [];
        const left = stowed.filter((k) => !back.includes(k));
        notes.push(`占地里自己的 ${stowed.join('、')} 先收进了背包${back.length ? `，盖完放回了房子旁边（${back.join('、')}）` : ''}${left.length ? `，${left.join('、')} 还在背包里，要用时会再放下` : ''}`);
      }
      // 自己设计的房子：把设计上的问题告诉模型（不影响验收），下一版可以画得更好
      if (spec.design) { try { const w = compileDesign(spec.design).warnings; if (w.length) notes.push(`设计提示：${w.join('；')}`); } catch { /* 已经编译过，不会到这里 */ } }
      const noteText = notes.length ? `${notes.join('；')}。` : '';
      // 主体都盖好了、只差家具（熔炉、箱子、灯笼……）：房子已经能住，家具有了再摆
      const left = result.inspection.defects;
      const furnishingOnly = !result.inspection.complete && left.length > 0 && left.every((d) => typeof d.expected === 'string' && FURNISHING.test(d.expected));
      if (furnishingOnly) {
        const want = [...new Set(left.map((d) => String(d.expected)))].join('、');
        notes.push(`主体盖好了，还差家具：${want}——有了用 build {"projectId":"${project.id}","mode":"repair"} 摆上`);
      }
      if (!result.inspection.complete && !furnishingOnly) {
        const missing = Object.entries(result.missingMaterials).map(([name, count]) => `${name}×${count}`).join('，');
        const failureCode = missing ? 'MISSING_MATERIALS' : result.failures.some((f) => f.reason === 'WRONG_DIMENSION') ? 'WRONG_DIMENSION' : 'ERROR';
        // 缺料折算成要去采的原材料（像玩家心算：73 块木板 ≈ 19 根原木）
        const rawNeed = new Map<string, number>();
        let pool = ctx.adapter.state().inventory;
        for (const [name, count] of Object.entries(result.missingMaterials)) {
          const p = materialPlan(name, count, pool);
          pool = p.leftover; // 同一批原木不能同时算给木板和门
          for (const r of p.raw) rawNeed.set(r.item, (rawNeed.get(r.item) ?? 0) + r.count);
        }
        const sameAsMissing = rawNeed.size === Object.keys(result.missingMaterials).length && [...rawNeed].every(([n, c]) => result.missingMaterials[n] === c);
        const rawText = sameAsMissing ? '' : [...rawNeed].map(([n, c]) => `${n}×${c}`).join('、');
        // 缺的成品和折算出的原材料，记得的箱子里有没有（玻璃板、原木常常就存在旁边的箱子里）
        const inChest = missing ? chestHint(ctx.memory, ctx.adapter.state(), [...Object.entries(result.missingMaterials), ...rawNeed].map(([item, count]) => ({ item, count }))) : '';
        return fail(failureCode, `${noteText}${result.placed ? `这次先盖了 ${result.placed} 块；` : ''}${spec.name} 尚未验收（还差 ${result.inspection.defects.length} 处）${missing ? `；缺少 ${missing}${rawText ? `（折算成原材料：${rawText}，可用 gather 的 for 按缺口采）` : ''}${inChest}；补齐后用 mode:"repair"` : ''}。${describeBuildProblems(result)}作品 ID ${project.id}。${result.failures[0] ? ` ${result.failures[0].reason}` : ''}`, data);
      }
      if (blueprint.home && args.mode !== 'inspect') {
        const home = rotatePosition(blueprint.home, project.origin, project.rotation);
        ctx.memory.setBase(state.dim, home, spec.name);
        ctx.memory.addLandmark('discovery', `我的${spec.name}`, state.dim, home, 4);
        ctx.bus.publish('built', 'P2', `${spec.name} 逐格及通行检查通过；作品 ${project.id}`);
      }
      return ok(`${spec.name} ${furnishingOnly ? '主体完工' : '验收通过'}；本次放置 ${result.placed} 块。${noteText}${describeBuildProblems(result)}作品 ID ${project.id}`, data);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `建筑工程失败：${(e as Error).message}`);
    }
  },
};

/** A real archive tool: choices and subjective use feedback remain visible to future planning. */
export const buildingArchive: Skill<{ operation: string; projectId?: string; otherId?: string; text?: string; version?: number; otherVersion?: number; source?: 'user' | 'agent'; category?: 'appearance' | 'use' | 'pathing' | 'raid' | 'preference' }> = {
  name: 'building_archive',
  description: '查询作品、设计版本、逐格缺陷、成本及使用反馈；比较候选的材料差异，记录主观审美/使用感受。改造由 build 指定 projectId 和新 spec 完成，程序不替你决定喜好。',
  argsDoc: '{"operation":"list|read|compare|compare_versions|rollback|feedback","projectId"?:"作品 ID","otherId"?:"比较作品 ID","version"?:1,"otherVersion"?:2,"text"?:"反馈/回退原因","source"?:"agent","category"?:"appearance|use|pathing|raid|preference"}',
  timeoutMs: 10000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    if (!['list', 'read', 'compare', 'compare_versions', 'rollback', 'feedback'].includes(a.operation)) return { ok: false, error: 'operation 需要 list/read/compare/compare_versions/rollback/feedback' };
    if (a.operation !== 'list' && (typeof a.projectId !== 'string' || a.projectId.length > 100)) return { ok: false, error: '需要 projectId' };
    if (a.operation === 'compare' && (typeof a.otherId !== 'string' || a.otherId.length > 100)) return { ok: false, error: 'compare 需要 otherId' };
    if (['feedback', 'rollback'].includes(a.operation) && (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 2000)) return { ok: false, error: 'feedback/rollback 需要 1-2000 字符 text' };
    if (['rollback', 'compare_versions'].includes(a.operation) && (!Number.isInteger(a.version) || a.version < 1)) return { ok: false, error: '需要实际存在的正整数 version' };
    if (a.operation === 'compare_versions' && (!Number.isInteger(a.otherVersion) || a.otherVersion < 1)) return { ok: false, error: '需要实际存在的正整数 otherVersion' };
    if (a.source !== undefined && a.source !== 'agent') return { ok: false, error: '模型反馈只能标为 agent；用户明确反馈由用户命令入口记录' };
    if (a.category !== undefined && !['appearance', 'use', 'pathing', 'raid', 'preference'].includes(a.category)) return { ok: false, error: '无效反馈 category' };
    return { ok: true, args: { operation: a.operation, projectId: a.projectId, otherId: a.otherId, text: a.text, version: a.version, otherVersion: a.otherVersion, source: 'agent', category: a.category ?? 'use' } };
  },
  async run(ctx, args) {
    try {
      throwIfAborted(ctx.signal);
      const archive = buildingArchiveFor(ctx.memory);
      if (args.operation === 'list') return ok('作品目录', { projects: archive.list().filter((p) => p.worldId === ctx.adapter.state().worldId).map((p) => ({ id: p.id, worldId: p.worldId, dimension: p.dimension, origin: p.origin, status: p.status, name: p.versions.at(-1)?.spec.name, version: p.versions.at(-1)?.version, latestFeedback: p.feedback.slice(-3) })) });
      if (!archive.get(args.projectId!)) return fail('NOT_FOUND', '作品不存在');
      if (args.operation === 'read') {
        const project = archive.get(args.projectId!)!, inspection = project.inspections.at(-1);
        const details = inspection ? describeBuildProblems({ projectId: project.id, placed: 0, cleared: 0, inspection, missingMaterials: {}, failures: [] }) : '';
        return ok(`作品 ${project.id}「${project.versions.at(-1)?.spec.name ?? ''}」档案；${inspection ? `上次验收${inspection.complete ? '通过' : `未通过（${inspection.defects.length} 个缺陷）`}` : '尚无验收记录'}。${details}以上是历史记录；现场复查用 build {projectId:"${project.id}",mode:"inspect"}。`, { project });
      }
      if (args.operation === 'compare') return ok('作品候选比较', archive.compare(args.projectId!, args.otherId!));
      if (args.operation === 'compare_versions') return ok('同一作品的设计版本比较', archive.compareVersions(args.projectId!, args.version!, args.otherVersion!));
      if (args.operation === 'rollback') return ok('已创建回退设计版本；实际改造需另用 build 的 repair，并重新验收', { project: archive.rollback(args.projectId!, args.version!, args.text!) });
      archive.feedback(args.projectId!, { source: 'agent', text: args.text!, category: args.category ?? 'use' });
      return ok('已记录主观反馈；结构事实以 inspect 为准');
    } catch (e) { if (isAbort(e)) throw e; return fail('ERROR', (e as Error).message); }
  },
};

/** 把 mineflayer / 服务器的睡觉失败原因翻成人话，并说明该怎么办 */
export function sleepReason(reason?: string): string {
  const r = String(reason ?? '');
  if (r === 'NO_BED') return '背包里没有床，附近也没有床（3 块羊毛 + 3 块木板可以做一张）';
  if (r === 'NO_SPACE' || r === 'PLACE_FAILED') return '身边没有能放床的平地（床要两格平整空地）：换块平地再睡';
  if (/monster/i.test(r)) return '附近有怪物，不能睡：先打掉或躲开它们，或者用 shelter 围起来再睡';
  if (/not night|day/i.test(r)) return '还没到能睡的时候';
  if (/occupied/i.test(r)) return '这张床被占着，点了一下床也没空出来（村民一般会被叫醒，叫不醒的多半是别的玩家）：换一张床（sleep {"at":…}）或者 sleep {"place":true} 放自己的床';
  if (/far/i.test(r)) return '离床太远';
  return r || '未知原因';
}

export const sleepSkill: Skill<{ at?: Vec3Like; place?: boolean }> = {
  name: 'sleep',
  description: '天黑后睡床跳过黑夜、设重生点（黄昏会在床边等）。{} 睡手边的床；at 走去那张床睡；place 放下背包里的床睡（挑附近有顶的地方）。床拆下来（dig）会掉成床物品，捡起来就在背包里。只限主世界。',
  argsDoc: '{}｜{"at":{x,y,z}}｜{"place":true}',
  timeoutMs: 120000, movement: false,
  validate(raw) {
    const a = obj(raw);
    const at = a.at ?? a.bed;
    if (at !== undefined && (!at || typeof at !== 'object' || [at.x, at.y, at.z].some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)))) return { ok: false, error: 'at 需要床的坐标 {"x","y","z"}' };
    return { ok: true, args: { ...(at ? { at: { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) } } : {}), ...(a.place === true ? { place: true } : {}) } };
  },
  async run(ctx, args = {}) {
    const s = ctx.adapter.state();
    if (s.dim !== 'overworld') return fail('WRONG_DIMENSION', '只能在主世界睡床；当前维度的床会爆炸');
    // 能不能上床看的是“可睡时段”（12542–23459 刻），不是 isDay：黄昏时 isDay 仍为真但马上就能睡
    const tod = ((s.timeOfDay % 24000) + 24000) % 24000;
    if (!canSleepAt(tod, s.weather)) {
      const waitTicks = 12542 - tod;
      // 离能睡的时间还远：不给钟点/倒计时（时间感知已改成模糊的太阳位置），只说现在还不能睡
      if (waitTicks < 0 || waitTicks > 1600) {
        return fail('ERROR', `现在还不能睡，先做别的事，等天黑（太阳落山）后再 sleep`);
      }
    }
    try {
      // 睡哪张床是模型的决定：给了 at 就走过去；没给就只睡手边的；要放背包里的床得明说 place
      const BEDS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((c) => `${c}_bed`);
      if (args.at) {
        const d = Math.round(Math.hypot(args.at.x - s.pos.x, args.at.y - s.pos.y, args.at.z - s.pos.z));
        if (d > 3) {
          ctx.progress(0.2, `走向 ${d} 格外的床`);
          // 床常常在自己挖的洞里、封好的小屋里：走不过去就像人一样挖开挡路的土石过去
          try {
            await ctx.adapter.moveTo({ kind: 'near', pos: args.at, range: 2 }, { signal: ctx.signal, timeoutMs: Math.max(5000, Math.min(60000, ctx.deadline - Date.now() - 30000)) });
          } catch (e) {
            if (isAbort(e)) throw e;
            await ctx.adapter.moveTo({ kind: 'near', pos: args.at, range: 2 }, { signal: ctx.signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now() - 30000), allowTerrainChanges: true });
          }
        }
      }
      const handy = findStation(ctx, BEDS, 4);
      if (!handy && !args.place) {
        const known = findStation(ctx, BEDS, 2000);
        const bag = ctx.adapter.state().inventory.some((i) => i.name.endsWith('_bed'));
        const options = [known ? `记得的床在 ${known.dist} 格外：sleep {"at":{"x":${Math.round(known.pos.x)},"y":${Math.round(known.pos.y)},"z":${Math.round(known.pos.z)}}}` : '', bag ? '背包里有床：sleep {"place":true} 就地放下' : ''].filter(Boolean);
        return fail(options.length ? 'NOT_FOUND' : 'MISSING_MATERIALS', `手边没有床${args.at ? '（给的位置附近也没有）' : ''}${options.length ? `；${options.join('；')}` : '；3 块同色羊毛 + 3 块木板可以做一张'}`);
      }
      const bed = handy;
      // 黄昏：像玩家一样先站在床边（需要时先把床放下），等天黑那一刻躺上去
      let waited = 0;
      while (!canSleepAt(ctx.adapter.state().timeOfDay, ctx.adapter.state().weather) && Date.now() < ctx.deadline - 15000) {
        throwIfAborted(ctx.signal);
        const now = ctx.adapter.state();
        if (now.hp < s.hp - 2) return fail('ERROR', `等天黑时受到伤害（生命 ${Math.round(now.hp)}），先处理威胁再睡`);
        ctx.progress(0.4, '在床边等天黑');
        await delay(1000, ctx.signal);
        waited++;
      }
      if (!canSleepAt(ctx.adapter.state().timeOfDay, ctx.adapter.state().weather)) return fail('ERROR', `等了 ${waited} 秒还没到能睡的时候，稍后再 sleep`);
      const r = await ctx.adapter.sleepInBed(ctx.signal, args.at ? { at: args.at } : {});
      if (!r.ok) {
        const far = r.reason === 'NO_BED' && !bed ? findStation(ctx, BEDS, 2000) : null;
        return fail(r.reason === 'NO_BED' ? 'MISSING_MATERIALS' : 'ERROR', `睡不了：${sleepReason(r.reason)}${far ? `；记得的床在 ${far.dist} 格外，太远了，今晚赶不过去` : ''}`);
      }
      // 床只是重生点，不是家：只记“我的床”（床被拆、收回背包时会跟着忘掉），基地只来自自己起名定下的或盖好的房子
      if (r.bedPos) ctx.memory.addLandmark('discovery', '我的床', s.dim, r.bedPos, 4);
      return ok(`${waited ? `在床边等了 ${waited} 秒天黑，` : ''}睡了一觉，天亮了（重生点已设在床边）`);
    } catch (e) { if (isAbort(e)) throw e; return fail(codeFromError(e), `睡觉出错：${(e as Error).message}`); }
  },
};
