import { DIRS } from '../perception/perception.ts';
import { DIR_OFFSETS, isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { dirOfYaw, interactiveName } from '../perception/vision.ts';
import { isContainerLandmark } from '../memory/chest-memory.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { hasPlaceable } from './survival.ts';
import { ensureToolFor } from './work.ts';
import { findStation, forgetStationAt } from './stations.ts';
import { OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from './build.ts';
import { noteEdit } from '../mind/edits.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { dist3, throwIfAborted } from '../util.ts';

/**
 * 身体的基本动作：对着某个方向挖（玩家按住左键）、原地垫方块往上爬（跳起来往脚下放方块）。
 * 程序执行指定动作；液体邻接默认停下，Agent 可分别允许进水或进岩浆。
 */

const floor = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** 挖开这一格会不会让液体流进来（它的邻格有水/岩浆） */
const liquidNeighbours = (ctx: SkillCtx, c: Vec3Like) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
  .map(([dx, dy, dz]) => ctx.adapter.blockAt({ x: c.x + dx, y: c.y + dy, z: c.z + dz }))
  .filter((name): name is string => name !== null && LIQUID_BLOCKS.has(name));

export async function breakCell(ctx: SkillCtx, c: Vec3Like, exact = false, info?: { noDrop?: boolean; ms?: number }, opts: { allowWater?: boolean; allowLava?: boolean } = {}): Promise<string | null> {
  const name = ctx.adapter.blockAt(c);
  if (!exact && isSoftBlock(name)) return null;
  if (name && LIQUID_BLOCKS.has(name)) throw new Error(`LIQUID:${name}`);
  if (name === 'bedrock') throw new Error('BEDROCK');
  const wet = liquidNeighbours(ctx, c).find((name) => /lava/.test(name) ? !opts.allowLava : !opts.allowWater);
  if (wet) throw new Error(`LIQUID_NEAR:${wet}`);
  // 只有 make:true 才能在身边工作台准备木镐；默认直接用现有工具或空手挖。
  if (ctx.make === true && !ctx.adapter.canHarvest(c) && findStation(ctx, ['crafting_table'], 4)) await ensureToolFor(ctx, c);
  if (exact && ctx.adapter.blockAt(c) !== name) throw new Error('TARGET_CHANGED：目标方块已经改变，停止拆除');
  const origin = ctx.adapter.state();
  const affected = [c], properties = ctx.adapter.blockStateAt?.(c)?.properties ?? {};
  const facing = ({ north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as Record<string, number[]>)[String(properties.facing)];
  if (name?.endsWith('_bed') && facing && ['foot', 'head'].includes(String(properties.part))) {
    const sign = properties.part === 'head' ? -1 : 1;
    affected.push({ x: c.x + facing[0] * sign, y: c.y, z: c.z + facing[1] * sign });
  } else if (name?.endsWith('_door') && ['lower', 'upper'].includes(String(properties.half))) affected.push({ ...c, y: c.y + (properties.half === 'lower' ? 1 : -1) });
  const r = await ctx.adapter.dig(c, ctx.signal).finally(() => {
    if (!name || ctx.memory.worldId !== origin.worldId || ctx.adapter.state().dim !== origin.dim) return;
    const removed = affected.filter((pos) => { const after = ctx.adapter.blockAt(pos); return after !== null && after !== name; });
    if (removed.length) {
      forgetStationAt(ctx.memory, origin.dim, removed, name);
      removed.forEach((pos) => ctx.memory.markGone(name, origin.dim, pos, ctx.adapter.blockAt(pos)!));
    }
  });
  if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
  if (info) { info.noDrop = !!r.noDrop; info.ms = r.digMs; }
  return name;
}

export const why = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (m.startsWith('LIQUID_NEAR:')) return `再挖 ${m.slice(12)} 就会流进来，停下了`;
  if (m.startsWith('LIQUID:')) return `那边是 ${m.slice(7)}`;
  if (m === 'BEDROCK') return '碰到基岩，挖不动';
  if (m.startsWith('NEED_TOOL:')) return m.slice(10);
  if (m === 'TOOL_MISSING') return '适配器报告当前工具条件不足；检查具体方块、工具和动作时间预算';
  return m;
};

type TargetDigArgs = { target: string | Vec3Like; block?: string; own?: boolean; dir?: undefined; blocks?: undefined; wet?: boolean; lava?: boolean };
type DigArgs = ({ dir: string; blocks: number; target?: undefined; block?: undefined } | TargetDigArgs) & { wet?: boolean; lava?: boolean };
const AIR = new Set(['air', 'cave_air', 'void_air']);
const coordinates = (value: unknown): Vec3Like | null => {
  const parts = typeof value === 'string' ? value.trim().split(/[,， ]+/).map(Number) : null;
  const p = parts?.length === 3 ? { x: parts[0], y: parts[1], z: parts[2] } : typeof value === 'object' && value ? value as Vec3Like : null;
  return p && [p.x, p.y, p.z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? floor(p) : null;
};

/** Explicit targets are single-block work, never directional tunnel excavation. */
async function recoverBlock(ctx: SkillCtx, args: TargetDigArgs) {
  const { adapter, senses, memory, signal } = ctx;
  const start = adapter.state();
  senses.refresh();
  let pos = coordinates(args.target), expected = args.block, landmarkLabel: string | undefined;
  if (!pos && typeof args.target === 'string') {
    const landmark = memory.findLandmark(args.target);
    if (landmark) {
      if (landmark.dim !== start.dim || landmark.worldId && landmark.worldId !== start.worldId) return fail('WRONG_DIMENSION', '目标地标不在当前世界/维度，未拆除');
      if (landmark.radius) return fail('NOT_FOUND', `只记得 ${landmark.label} 所在区域（中心 ${landmark.pos.x},${landmark.pos.y},${landmark.pos.z}，半径约${landmark.radius}格）；具体方块需重新看见，未按隐藏坐标接近或拆除`);
      pos = floor(landmark.pos);
      landmarkLabel = landmark.label;
    } else {
      const names = adapter.resolveBlockNames(args.target);
      const known = senses.knownBlocks(names, 64).sort((a, b) => a.dist - b.dist);
      const seen = known.find((hit) => !isContainerLandmark(hit.name) || senses.observeBlocks?.([hit.pos]).some((observed) => observed.name === hit.name));
      const station = seen ? null : findStation(ctx, names, 64);
      if (station?.radius) return fail('NOT_FOUND', `只记得容器所在区域，半径约${station.radius}格；具体方块需重新看见，未拆除`);
      pos = seen ? floor(seen.pos) : station ? floor(station.pos) : null;
      expected ??= seen?.name;
      if (pos && !expected && names.includes(adapter.blockAt(pos) ?? '')) expected = adapter.blockAt(pos)!;
      if (pos && !expected && names.length === 1) expected = names[0];
    }
  }
  if (!pos) return fail('NOT_FOUND', `没有看见或记住目标 ${String(args.target)}；先 look_around 确认方块或给出坐标`);
  const inReach = () => dist3(adapter.eye() ?? { ...adapter.state().pos, y: adapter.state().pos.y + 1.62 }, { x: pos!.x + 0.5, y: pos!.y + 0.5, z: pos!.z + 0.5 }) <= 4.5;
  try {
    throwIfAborted(signal);
    if (!inReach()) {
      try { await adapter.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: Math.min(15000, Math.max(1, ctx.deadline - Date.now() - 4000)), constructionSafe: true }); }
      catch (e) {
        if (isAbort(e)) throw e;
        // 走不到“能看见它一面、伸手够得着”的位置：多半埋在墙里或隔着东西，不是挖得慢
        if (!inReach()) return fail('PATH_NOT_FOUND', `走不到能够着 (${pos.x},${pos.y},${pos.z}) 的位置（${why(e).slice(0, 60)}）：它可能四面都被别的方块挡着、或在走不过去的地方；先挖开挡在前面的，或者换个看得见它的位置`, { target: expected ?? null, pos });
      }
    }
    throwIfAborted(signal);
    if (!inReach()) return fail('PATH_NOT_FOUND', '未能走到目标伸手可及的位置，未拆除');
    const name = adapter.blockAt(pos);
    if (!name || AIR.has(name)) return fail('TARGET_GONE', '目标位置已经没有方块，未拆除');
    if (expected && name !== expected) return fail('TARGET_GONE', `目标应为 ${expected}，当前位置是 ${name}，未拆除`);
    if (landmarkLabel && !expected && landmarkLabel !== name && landmarkLabel.replace(/^我的/, '') !== interactiveName(name)) return fail('TARGET_GONE', `地标 ${landmarkLabel} 的当前位置是 ${name}；请用 block 明确目标类型，未拆除`);
    // Multi-part blocks disappear together. Protect support beneath either part.
    const affected = [pos], properties = adapter.blockStateAt?.(pos)?.properties ?? {};
    const facing = ({ north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as Record<string, number[]>)[String(properties.facing)];
    if (facing && ['foot', 'head'].includes(String(properties.part))) {
      const sign = properties.part === 'head' ? -1 : 1;
      affected.push({ x: pos.x + facing[0] * sign, y: pos.y, z: pos.z + facing[1] * sign });
    } else if (properties.half === 'lower' || properties.half === 'upper') affected.push({ ...pos, y: pos.y + (properties.half === 'lower' ? 1 : -1) });
    const supportsMe = () => {
      const p = adapter.state().pos;
      return affected.some((c) => c.y >= p.y - 1.05 && c.y <= p.y + 0.01 && c.x < p.x + 0.3 && c.x + 1 > p.x - 0.3 && c.z < p.z + 0.3 && c.z + 1 > p.z - 0.3);
    };
    if (supportsMe()) {
      const me = floor(adapter.state().pos);
      const landing = Object.values(DIR_OFFSETS).map(([dx, dz]) => ({ x: me.x + dx, y: me.y, z: me.z + dz })).find((c) => {
        const below = adapter.blockAt({ ...c, y: c.y - 1 });
        return [c, { ...c, y: c.y + 1 }].every((q) => { const n = adapter.blockAt(q); return n !== null && isSoftBlock(n) && !/sweet_berry_bush|powder_snow|fire/.test(n); })
          && below !== null && !isSoftBlock(below) && !LIQUID_BLOCKS.has(below) && !/slab|stairs|fence|wall|bed|door|cactus|magma|campfire|powder_snow/.test(below)
          && !affected.some((q) => q.x === c.x && q.z === c.z && q.y === c.y - 1);
      });
      if (!landing) return fail('BAD_ARGS', '目标正在支撑身体，旁边没有可确认安全的落脚处；先离开再拆');
      await adapter.moveTo({ kind: 'xyz', ...landing }, { signal, timeoutMs: 3000, constructionSafe: true });
      throwIfAborted(signal);
      if (supportsMe() || !adapter.state().onGround) return fail('BAD_ARGS', '尚未离开目标并站稳，未拆除脚下支撑');
    }
    if (adapter.blockAt(pos) !== name) return fail('TARGET_GONE', '目标方块已经改变，未拆除');
    const mine = args.own ? null : ownBuildingAt(memory, adapter.state(), pos, name);
    if (mine) return fail('BAD_ARGS', `(${pos.x},${pos.y},${pos.z}) 的 ${name} 是自己盖的「${mine.name}」的一部分，未拆除；${OWN_BUILDING_HINT}`, { target: name, pos, own: mine });
    const stash = args.own ? null : storedChestAt(memory, adapter.state(), pos, name);
    if (stash) return fail('BAD_ARGS', stash, { target: name, pos });
    const before = new Map(adapter.state().inventory.map((item) => [item.name, item.count]));
    await breakCell(ctx, pos, true, undefined, { allowWater: args.wet, allowLava: args.lava });
    throwIfAborted(signal);
    if (!AIR.has(adapter.blockAt(pos) ?? '')) return fail('ERROR', `尚未确认 ${name} 已被拆掉`, { target: name, pos, broken: false });
    noteEdit(ctx.taskId, 'dig', pos);
    // 拆掉的是记得的床/箱子/工作台：它已经不在那儿了，记忆里也要忘掉，免得以后还说“我有张床在那儿”
    forgetStationAt(ctx.memory, adapter.state().dim, affected, name);
    await adapter.collectNearbyDrops(signal, 3, Math.max(1, Math.min(3500, ctx.deadline - Date.now())));
    throwIfAborted(signal);
    // 床、门、工作台这类“拆下来就是它自己”的：掉落物会弹到旁边、掉进屋里或坑底。像人一样低头看看刚拆的地方，看见了再走过去捡
    // （只用眼睛看得到的：技能不能透视实体列表）
    if (/_(bed|door)$/.test(name) || ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest'].includes(name)) {
      const had = before.get(name) ?? 0;
      for (let i = 0; i < 2 && (adapter.state().inventory.filter((it) => it.name === name).reduce((n, it) => n + it.count, 0) <= had) && Date.now() < ctx.deadline - 3000; i++) {
        const eye = adapter.eye();
        if (eye) {
          const vx = pos.x + 0.5 - eye.x, vz = pos.z + 0.5 - eye.z, vy = pos.y + 0.2 - eye.y;
          try { await adapter.look(Math.hypot(vx, vz) > 0.2 ? Math.atan2(-vx, -vz) : eye.yaw, Math.atan2(vy, Math.max(0.3, Math.hypot(vx, vz))), signal); } catch (e) { if (isAbort(e)) throw e; }
        }
        ctx.senses.refresh();
        const drop = ctx.senses.perceivedEntities(10).filter((e) => e.kind === 'item' && e.name.replace(/^item:/, '') === name).sort((a, b) => dist3(a.pos, pos) - dist3(b.pos, pos))[0];
        if (!drop) break;
        try { await adapter.moveTo({ kind: 'near', pos: drop.pos, range: 1 }, { signal, timeoutMs: Math.min(6000, Math.max(1000, ctx.deadline - Date.now() - 2000)) }); } catch (e) { if (isAbort(e)) throw e; }
        await adapter.collectNearbyDrops(signal, 2, 1500);
      }
    }
    const gained = adapter.state().inventory.map((item) => ({ name: item.name, count: item.count - (before.get(item.name) ?? 0) })).filter((item) => item.count > 0);
    const data = { target: name, pos, broken: true, gained };
    if (!gained.length) return fail('ERROR', `已拆下 ${name}，但背包没有新增物品；${whereDropsWent(ctx, pos)}`, { ...data, drops: dropsNear(ctx, pos) });
    const dropsItself = /_(bed|door)$/.test(name) || ['crafting_table', 'furnace', 'blast_furnace', 'smoker'].includes(name);
    if (dropsItself && !gained.some((item) => item.name === name)) return fail('ERROR', `已拆下 ${name}，但背包没有新增 ${name}；顺带拾取了 ${gained.map((item) => `${item.name}×${item.count}`).join('、')}，目标掉落物尚未拿到；${whereDropsWent(ctx, pos)}`, data);
    return ok(`已拆下 ${name}；背包新增 ${gained.map((item) => `${item.name}×${item.count}`).join('、')}`, data);
  } catch (error) {
    if (isAbort(error)) throw error;
    return fail(codeFromError(error), `拆除目标失败：${why(error)}`);
  }
}

// ------------------------------------------------------------------ dig
export const dig: Skill<DigArgs> = {
  name: 'dig',
  description: '定点拆除并拾取，或按 dir 开挖短通道；默认不制造工具，不挖开液体邻格。wet:true 接受进水，lava:true 接受进岩浆，分别显式选择。',
  argsDoc: '{"target"?: "<方块ID|x,y,z|地标ID>" | {"x":0,"y":64,"z":0}, "block"?: "<目标方块类型约束>", "own"?: true, "dir"?: "up|down|N|E|S|W|forward", "blocks"?: 1-6, "wet"?:true, "lava"?:true}（target 与 dir 二选一）',
  timeoutMs: 60000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const target = a.target ?? a.at ?? a.pos;
    if (target !== undefined) {
      if (a.dir !== undefined || a.direction !== undefined || a.blocks !== undefined || a.count !== undefined) return { ok: false, error: '定点 target 只拆一个目标，不能同时指定 dir/blocks' };
      const point = coordinates(target);
      if (!point && (typeof target !== 'string' || !target.trim() || target.length > 160 || /[,，]/.test(target))) return { ok: false, error: 'target 必须是方块ID、地标ID或有效的 x,y,z 坐标' };
      const block = typeof a.block === 'string' && a.block.trim() ? a.block.trim().replace(/^minecraft:/, '') : undefined;
      return { ok: true, args: { target: point ?? String(target).trim().replace(/^minecraft:/, ''), ...(block ? { block } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}) } };
    }
    let dir = String(a.dir ?? a.direction ?? '').trim();
    dir = /^(up|down|forward)$/i.test(dir) ? dir.toLowerCase() : dir.toUpperCase();
    if (!['up', 'down', 'forward', ...Object.keys(DIR_OFFSETS)].includes(dir)) return { ok: false, error: 'dir 必须是 up/down/forward/N/E/S/W' };
    return { ok: true, args: { dir, blocks: clampInt(a.blocks ?? a.count, 1, 6, dir === 'up' ? 2 : 1), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}) } };
  },
  async run(ctx, args) {
    if (args.target !== undefined) return recoverBlock(ctx, args);
    const { adapter, signal } = ctx;
    const dug: string[] = [];
    try {
      if (args.dir === 'up') {
        const me = floor(adapter.state().pos);
        for (let i = 0; i < args.blocks; i++) {
          const n = await breakCell(ctx, { x: me.x, y: me.y + 2 + i, z: me.z }, false, undefined, { allowWater: args.wet, allowLava: args.lava });
          if (n) dug.push(n);
        }
        return ok(`挖开了头顶 ${dug.length ? dug.join('、') : '（本来就空着）'}`, { dug });
      }
      if (args.dir === 'down') {
        for (let i = 0; i < args.blocks; i++) {
          const me = floor(adapter.state().pos);
          const c = { x: me.x, y: me.y - 1, z: me.z };
          const under = adapter.blockAt({ x: c.x, y: c.y - 1, z: c.z });
          if (isSoftBlock(under) || (under && LIQUID_BLOCKS.has(under))) return dug.length ? ok(`往下挖了 ${dug.length} 格，再下面是 ${under ?? '空的'}，停下`, { dug }) : fail('BAD_ARGS', `脚下再往下是 ${under ?? '空的'}，往下挖会掉下去`);
          const n = await breakCell(ctx, c, false, undefined, { allowWater: args.wet, allowLava: args.lava });
          if (n) dug.push(n);
          await adapter.moveTo({ kind: 'xyz', x: c.x, y: c.y, z: c.z }, { signal, timeoutMs: 4000 }).catch((e) => { if (isAbort(e)) throw e; });
        }
        return ok(`往下挖了 ${dug.length} 格（${dug.join('、')}）`, { dug });
      }
      const dirKey = args.dir === 'forward' ? dirOfYaw(adapter.eye()?.yaw ?? 0).replace(/^(N|S)[EW]$/, '$1') : args.dir;
      const [dx, dz] = DIR_OFFSETS[dirKey] ?? DIRS[dirKey] ?? [0, -1];
      let walked = 0;
      for (let i = 0; i < args.blocks; i++) {
        const me = floor(adapter.state().pos);
        const feet = { x: me.x + dx, y: me.y, z: me.z + dz };
        for (const c of [{ ...feet, y: feet.y + 1 }, feet]) {
          const n = await breakCell(ctx, c, false, undefined, { allowWater: args.wet, allowLava: args.lava });
          if (n) dug.push(n);
        }
        await adapter.moveTo({ kind: 'xyz', ...feet }, { signal, timeoutMs: 5000 });
        walked++;
      }
      return ok(`往 ${dirKey} 挖了 ${walked} 格（${dug.length ? dug.join('、') : '本来就通'}）`, { dug, walked });
    } catch (e) {
      if (isAbort(e)) throw e;
      const msg = why(e);
      return dug.length ? ok(`挖了 ${dug.join('、')}，然后${msg}`, { dug }) : fail(msg.includes('流进来') || msg.includes('基岩') || msg.startsWith('那边是') ? 'BAD_ARGS' : codeFromError(e), msg);
    }
  },
};

// ------------------------------------------------------------------ climb_up
export const climbUp: Skill<{ height: number; untilSky: boolean; untilExit?: boolean }> = {
  name: 'climb_up',
  description: '原地往上爬（头顶挡着会先挖开）：脚下是梯子就沿梯子爬，否则跳起来往脚下垫方块（需要背包里有泥土/圆石等方块）；until_sky 爬到看得见天空，until_exit 爬到四周有路可走（出坑）',
  argsDoc: '{"height"?: 1-24, "until_sky"?: boolean, "until_exit"?: boolean}；兼容 untilSky/untilExit；两个停止条件同时开启时须同时满足',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const untilExit = a.until_exit ?? a.untilExit ?? false;
    const untilSky = a.until_sky ?? a.untilSky ?? (a.height === undefined && !untilExit);
    if (typeof untilExit !== 'boolean' || typeof untilSky !== 'boolean') return { ok: false, error: 'until_sky/until_exit 须为布尔值' };
    return { ok: true, args: { height: clampInt(a.height, 1, 24, untilSky || untilExit ? 16 : 3), untilSky, ...(untilExit ? { untilExit } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    throwIfAborted(signal);
    const onLadder = () => adapter.blockAt(floor(adapter.state().pos)) === 'ladder';
    if (!onLadder() && !hasPlaceable(adapter.state().inventory)) return fail('MISSING_MATERIALS', '脚下没有梯子，背包里也没有能垫脚的方块（泥土/圆石/石头/木板）');
    const start = adapter.state().pos.y;
    const reached = (around: ReturnType<typeof surroundings>) => (!args.untilSky || around.sky) && (!args.untilExit || around.exits.length > 0);
    const finish = (stopped?: string) => {
      const state = adapter.state(), around = surroundings(adapter);
      const climbed = Math.max(0, Math.floor(state.pos.y + 0.05) - Math.floor(start + 0.05));
      const goalReached = args.untilSky || args.untilExit ? reached(around) : climbed >= args.height;
      const facts = { climbed, sky: around.sky, exits: around.exits, goalReached, position: { ...state.pos },
        effectEvidence: { verified: true, changed: state.pos.y > start + 0.05, reasons: [`实际高度 ${start} → ${state.pos.y}`] } };
      if (!climbed) return fail('STUCK', `未实际爬升${stopped ? `：${stopped}` : '，没有完成垫高'}`, facts);
      if (stopped || !goalReached) return fail('STUCK', `往上爬了 ${climbed} 格后停下：${stopped ?? '已到本次高度或时间上限，仍未满足停止条件'}`, facts);
      return ok(`往上爬了 ${climbed} 格${args.untilExit ? '，四周有路了' : args.untilSky ? '，看得见天空了' : ''}`, facts);
    };
    const initial = surroundings(adapter);
    if ((args.untilSky || args.untilExit) && reached(initial)) {
      // 已经满足停止条件：没有垫高是对的，但要说清楚，免得以为“爬不上去”
      return ok(`${args.untilExit ? '四周已经有路可走' : '已经看得见天空'}，所以没有垫高；如果是想站上坑沿，用 {"height":2} 这样直接指定格数`,
        { climbed: 0, alreadySatisfied: true, sky: initial.sky, exits: initial.exits });
    }
    for (let i = 0; i < args.height && Date.now() < ctx.deadline - 1000; i++) {
      throwIfAborted(signal);
      const here = surroundings(adapter);
      if ((args.untilSky || args.untilExit) && reached(here)) break;
      const before = adapter.state().pos, me = floor(before);
      try {
        // 头顶的方块先挖开（不挖液体旁边的）
        await breakCell(ctx, { x: me.x, y: me.y + 2, z: me.z });
        await adapter.moveTo({ kind: 'xyz', x: me.x, y: me.y + 1, z: me.z }, { signal, timeoutMs: Math.max(1, Math.min(8000, ctx.deadline - Date.now())), allowTerrainChanges: true });
        throwIfAborted(signal);
        const after = adapter.state().pos;
        if (Math.floor(after.y + 0.05) <= me.y || after.y <= before.y + 0.05) return finish('移动已结束，但脚下没有实际升到上一格');
      } catch (e) {
        if (isAbort(e)) throw e;
        return finish(why(e));
      }
      ctx.senses.refresh();
      if (!onLadder() && !hasPlaceable(adapter.state().inventory)) break;
    }
    throwIfAborted(signal);
    return finish();
  },
};

export const bodySkills = [dig, climbUp];

/** 拆下来的东西掉哪去了：眼睛看得到的掉落物在哪、是不是泡在水里漂着；一个也看不到就照实说 */
function dropsNear(ctx: SkillCtx, pos: Vec3Like) {
  return ctx.senses.perceivedEntities(24).filter((e) => e.kind === 'item').map((e) => {
    const cell = { x: Math.floor(e.pos.x), y: Math.floor(e.pos.y), z: Math.floor(e.pos.z) };
    const inWater = LIQUID_BLOCKS.has(ctx.adapter.blockAt(cell) ?? '');
    return { name: e.name.replace(/^item:/, ''), count: e.count ?? 1, at: cell, dist: Math.round(e.dist), fromTarget: Math.round(dist3(e.pos, pos)), inWater };
  }).filter((d) => d.fromTarget <= 16).slice(0, 5);
}

export function whereDropsWent(ctx: SkillCtx, pos: Vec3Like): string {
  const drops = dropsNear(ctx, pos);
  if (!drops.length) {
    const wet = [pos, { ...pos, y: pos.y - 1 }].some((c) => LIQUID_BLOCKS.has(ctx.adapter.blockAt(c) ?? ''));
    return `附近看不到它的掉落物${wet ? '（那里有水，多半被冲走了）' : '（可能被冲走、掉进缝里或够不着）'}；不能当作已拿到`;
  }
  return `掉落物还在地上没捡到：${drops.map((d) => `${d.name}×${d.count} 在 (${d.at.x},${d.at.y},${d.at.z})，离我 ${d.dist} 格${d.inWater ? '，泡在水里正在漂' : ''}`).join('；')}——要拿就 pickup_items {"item":"${drops[0].name}","radius":${Math.min(24, Math.max(6, drops[0].dist + 3))}}`;
}
