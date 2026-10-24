import type { ConstructionResult } from '../building/engine.ts';
import { materialPlan } from '../methods/shortfall.ts';
import { findStation, rememberStation } from './stations.ts';
import { describeSiteFailure, surveyBuildSite } from '../building/site.ts';
import { ownStationsAt } from '../building/engine.ts';
import type { BuildingProject } from '../building/archive.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { BuildingArchive } from '../building/archive.ts';
import { constructBuilding } from '../building/engine.ts';
import { compileBuilding, DEFAULT_SPEC, materialCost, normalizeSpec, rotatePosition, type BuildingSpec, type Rotation } from '../building/spec.ts';
import type { WorldMemory } from '../memory/store.ts';
import { throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

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
interface BuildArgs {
  blueprint: string;
  spec?: BuildingSpec;
  origin?: Vec3Like;
  rotation?: Rotation;
  projectId?: string;
  mode: 'build' | 'inspect' | 'repair';
  reason?: string;
  cells?: [number, number, number][];
}

const tally = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}×${c}`).join('、');

/** 把逐格缺陷归成几句人话：整地做了什么、什么东西挡着、地基哪里不行、还差多少块没放 */
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
  if (missingCells) out.push(`还有 ${missingCells} 块没放上`);
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
  description: '参数化施工：可选尺寸、材料、平顶/阶梯坡顶、门窗、工作台/熔炉/箱子/照明。先整地（清掉占地里的草、花、树和凸起的土石，填平小坑），再勘察地基、核算分材料缺口，分阶段施工；必须逐格及通行验收才算建成。返回 projectId；中断后用该 ID 重新观察并续建，inspect 只检查，repair 修复有档案的建筑。spec.components 支持精确坐标、方块状态、功能标签和施工依赖的组合设计；未提供底层状态能力时明确报错。',
  argsDoc: '{"blueprint"?:"hut|big_hut|pillar|wall|custom", "spec"?:{"name":"住宅","purpose":"庇护所","width":5,"depth":5,"height":3,"roof":"flat|gable","palette"?:{"foundation":"cobblestone","wall":"oak_planks","roof":"oak_planks","window":"glass","door":"oak_door"},"windows"?:true,"door"?:true,"facilities"?:["crafting_table","furnace","chest","torch"],"budget"?:512,"layout"?:"house|custom","components"?:[{"pos":{"x":0,"y":0,"z":0},"name":"cobblestone","properties"?:{},"phase"?:"frame","tags"?:[],"dependsOn"?:[]}]}, "projectId"?:"已有作品ID", "mode"?:"build|inspect|repair", "origin"?:{"x":0,"y":64,"z":0}, "rotation"?:0|90|180|270, "reason"?:"设计/改造原因", "cells"?:[[0,0,0]]}',
  timeoutMs: 600000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const blueprint = String(a.blueprint ?? 'hut');
    if (!Object.hasOwn(BLUEPRINTS, blueprint) && blueprint !== 'custom') return { ok: false, error: '未知蓝图；可用 hut/big_hut/pillar/wall/custom' };
    if (a.projectId !== undefined && (typeof a.projectId !== 'string' || !a.projectId.trim() || a.projectId.length > 100)) return { ok: false, error: 'projectId 需要有效作品 ID' };
    if (!['build', 'inspect', 'repair'].includes(a.mode ?? 'build')) return { ok: false, error: 'mode 支持 build/inspect/repair' };
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
      // 忘了作品 ID 也没关系：附近有没盖完的房子就接着盖（像玩家回到工地），而不是在旁边另起一座
      const near = (p: Vec3Like) => Math.hypot(p.x - (args.origin ?? state.pos).x, p.z - (args.origin ?? state.pos).z) <= (args.origin ? 6 : 16);
      const nearby = !args.projectId && args.mode === 'build' ? archive.list()
        .filter((p) => p.worldId === state.worldId && p.dimension === state.dim && p.status !== 'complete' && near(p.origin)
          && (!args.origin || (args.origin.x === p.origin.x && args.origin.y === p.origin.y && args.origin.z === p.origin.z))
          && (args.rotation === undefined || args.rotation === p.rotation))
        .sort((a, b) => b.updatedAt - a.updatedAt) : [];
      // 地形不行、或在原地反复失败都没进展的工地不自动接着盖：换地方另起（明确给了 projectId/origin 的除外）
      const notes: string[] = [];
      const abandoned = nearby.map((p) => ({ p, why: terrainProblem(p) ?? (stalledFailures(p) >= 3 ? `在原地失败了 ${stalledFailures(p)} 次没有进展` : null) }));
      const resumed = abandoned.find((x) => !x.why || args.origin)?.p;
      const skippedSite = !resumed ? abandoned.find((x) => x.why) : undefined;
      if (skippedSite && !args.origin) notes.push(`附近没盖完的「${skippedSite.p.versions.at(-1)?.spec.name ?? skippedSite.p.id.slice(0, 8)}」${skippedSite.why}，不在那里接着盖，换了块地另起`);
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
      let origin = args.origin ?? old?.origin;
      if (!origin) {
        // 没给 origin：先看看身边 24 格的地形，挑一块平整、干燥、没出过事的空地，再走过去
        const own = [...ownStationsAt(ctx).keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; });
        const survey = surveyBuildSite(ctx.adapter, ctx.memory, spec, { radius: 24, rotations: args.rotation !== undefined ? [args.rotation] : [rotation, ...([0, 90, 180, 270] as Rotation[]).filter((r) => r !== rotation)], ownStations: own });
        if (!survey.best) return fail('NOT_FOUND', describeSiteFailure(survey, spec, 24) + (notes.length ? `；${notes.join('；')}` : ''), { survey: { checked: survey.checked, rejected: survey.rejected, hint: survey.hint } });
        origin = survey.best.origin; rot = survey.best.rotation;
        notes.push(`选了 ${survey.best.dist} 格外一块${survey.best.spread ? '基本' : ''}平整、干燥的空地（${origin.x},${origin.y},${origin.z}）`);
        ctx.bus.publish('build_site', 'P3', `选址：${origin.x},${origin.y},${origin.z}（旋转 ${rot}°，比较了 ${survey.checked} 个位置）`);
        const center = rotatePosition({ x: Math.floor(spec.width / 2), y: 0, z: Math.floor(spec.depth / 2) }, origin, rot);
        const here = ctx.adapter.state().pos;
        if (Math.hypot(center.x - here.x, center.z - here.z) > 6) {
          ctx.progress(0.02, `走到选好的空地（${survey.best.dist} 格）`);
          try { await ctx.adapter.moveTo({ kind: 'near', pos: center, range: 3 }, { signal: ctx.signal, timeoutMs: Math.max(3000, Math.min(45000, ctx.deadline - Date.now() - 60000)) }); }
          catch (e) { if (isAbort(e)) throw e; return fail(codeFromError(e), `选好的空地（${origin.x},${origin.y},${origin.z}）走不过去：${(e as Error).message}；换个方向再试或直接给 origin`); }
        }
      }
      const blueprint = compileBuilding(spec);
      const project = archive.design({ id: old?.id, worldId: state.worldId, dimension: state.dim, origin, rotation: rot, spec, materials: materialCost(blueprint.cells), reason: args.reason });
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
      const noteText = notes.length ? `${notes.join('；')}。` : '';
      if (!result.inspection.complete) {
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
        return fail(failureCode, `${noteText}${spec.name} 尚未验收（${result.inspection.defects.length} 个缺陷）${missing ? `；缺少 ${missing}${rawText ? `（折算成原材料：${rawText}，可用 gather 的 for 按缺口采）` : ''}` : ''}。${describeBuildProblems(result)}作品 ID ${project.id}；可补料后续建/repair/inspect。${result.failures[0] ? ` ${result.failures[0].reason}` : ''}`, data);
      }
      if (blueprint.home && args.mode !== 'inspect') {
        const home = rotatePosition(blueprint.home, project.origin, project.rotation);
        ctx.memory.setBase(state.dim, home, spec.name);
        ctx.memory.addLandmark('discovery', `我的${spec.name}`, state.dim, home, 4);
        ctx.bus.publish('built', 'P2', `${spec.name} 逐格及通行检查通过；作品 ${project.id}`);
      }
      return ok(`${spec.name} 验收通过；本次放置 ${result.placed} 块。${noteText}${describeBuildProblems(result)}作品 ID ${project.id}`, data);
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
      if (args.operation === 'read') return ok('作品档案（历史检查不代表当前世界仍然完好）', { project: archive.get(args.projectId!) });
      if (args.operation === 'compare') return ok('作品候选比较', archive.compare(args.projectId!, args.otherId!));
      if (args.operation === 'compare_versions') return ok('同一作品的设计版本比较', archive.compareVersions(args.projectId!, args.version!, args.otherVersion!));
      if (args.operation === 'rollback') return ok('已创建回退设计版本；实际改造需另用 build 的 repair，并重新验收', { project: archive.rollback(args.projectId!, args.version!, args.text!) });
      archive.feedback(args.projectId!, { source: 'agent', text: args.text!, category: args.category ?? 'use' });
      return ok('已记录主观反馈；结构事实以 inspect 为准');
    } catch (e) { if (isAbort(e)) throw e; return fail('ERROR', (e as Error).message); }
  },
};

export const sleepSkill: Skill<{}> = {
  name: 'sleep',
  description: '主世界夜里睡在身边的床上（没有就放下背包里的床），跳过黑夜并设置重生点。下界和末地禁止尝试睡床。',
  argsDoc: '{}', timeoutMs: 120000, movement: false,
  validate() { return { ok: true, args: {} }; },
  async run(ctx) {
    const s = ctx.adapter.state();
    if (s.dim !== 'overworld') return fail('WRONG_DIMENSION', '只能在主世界睡床；当前维度的床会爆炸');
    if (s.isDay) return fail('ERROR', '只能在夜里睡觉');
    try {
      // 先去自己的床或看见过的床（昨晚放下的那张），附近没有才放背包里的床
      const BEDS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((c) => `${c}_bed`);
      const bed = findStation(ctx, BEDS, 64);
      if (bed && bed.dist > 3) {
        ctx.progress(0.2, `走向 ${bed.dist} 格外${bed.from === 'memory' ? '记得' : '看到'}的床`);
        await ctx.adapter.moveTo({ kind: 'near', pos: bed.pos, range: 2 }, { signal: ctx.signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now() - 30000) });
      }
      const r = await ctx.adapter.sleepInBed(ctx.signal);
      if (!r.ok) return fail(r.reason === 'NO_BED' ? 'MISSING_MATERIALS' : 'ERROR', `睡不了：${r.reason}`);
      if (r.bedPos) { ctx.memory.setBase(s.dim, r.bedPos); ctx.memory.addLandmark('discovery', '我的床', s.dim, r.bedPos, 4); }
      return ok('睡了一觉，天亮了（重生点已设在床边）');
    } catch (e) { if (isAbort(e)) throw e; return fail(codeFromError(e), `睡觉出错：${(e as Error).message}`); }
  },
};
