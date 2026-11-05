import { DIRS } from '../perception/perception.ts';
import { supportCell } from '../perception/local.ts';
import { DIR_OFFSETS, dropBelow, isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { footSurfaceY, supportTop, type StateAt } from '../perception/geometry.ts';
import { dirOfYaw, interactiveName } from '../perception/vision.ts';
import { isContainerLandmark } from '../memory/chest-memory.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { hasPlaceable, PLACEABLE } from './survival.ts';
import { ensureToolFor } from './work.ts';
import { findStation, forgetStationAt } from './stations.ts';
import { classifyBlock, MAN_MADE_NOTE, OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from './build.ts';
import { noteEdit } from '../mind/edits.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { dist3, sleep, throwIfAborted } from '../util.ts';

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

type TargetDigArgs = { target: string | Vec3Like; block?: string; own?: boolean; dir?: undefined; blocks?: undefined; wet?: boolean; lava?: boolean; deadlineMs?: number };
type DigArgs = ({ dir: string; blocks: number; target?: undefined; block?: undefined } | TargetDigArgs) & { wet?: boolean; lava?: boolean; deadlineMs?: number };
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
    // 低方块（床、下半砖、地毯、雪层、耕地……）按碰撞顶面判断：站在上面拆掉只是往下落不到一格，不会摔伤；
    // 别再走“先离开再拆”那一套（那一步在窄平台上常常走不动，导致一直拆不掉）。
    const supportFace = supportTop(name, adapter.blockStateAt?.(pos)?.properties ?? {});
    if (supportsMe() && (supportFace === null || supportFace >= 1 - 1e-6)) {
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
    // 不是自己的房子/矿道，但看起来是人造建材（村庄/别人家）：只报事实，拆不拆由它定
    const structure = classifyBlock(memory, adapter.state(), pos, name);
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
      const stillMissing = () => adapter.state().inventory.filter((it) => it.name === name).reduce((n, it) => n + it.count, 0) <= had;
      // 掉落物会弹到旁边、掉进屋里或坑底：先走到被拆的那格旁（掉落物多半就在 ±1 格）用身体扫一圈捡（不靠眼睛），
      // 再低头环顾用眼睛找（不透视实体列表）。多试几轮，别拆完就当作已经拿到。
      for (let i = 0; i < 3 && stillMissing() && Date.now() < ctx.deadline - 3000; i++) {
        try { await adapter.moveTo({ kind: 'near', pos, range: 1 }, { signal, timeoutMs: Math.min(6000, Math.max(1000, ctx.deadline - Date.now() - 2000)) }); } catch (e) { if (isAbort(e)) throw e; }
        await adapter.collectNearbyDrops(signal, 5, 2000);
        throwIfAborted(signal);
        if (!stillMissing()) break;
        const eye = adapter.eye();
        if (eye) {
          const vx = pos.x + 0.5 - eye.x, vz = pos.z + 0.5 - eye.z, vy = pos.y - 0.6 - eye.y;
          try { await adapter.look(Math.hypot(vx, vz) > 0.2 ? Math.atan2(-vx, -vz) : eye.yaw, Math.atan2(vy, Math.max(0.3, Math.hypot(vx, vz))), signal); } catch (e) { if (isAbort(e)) throw e; }
        }
        ctx.senses.refresh();
        const drop = ctx.senses.perceivedEntities(12).filter((e) => e.kind === 'item' && e.name.replace(/^item:/, '') === name).sort((a, b) => dist3(a.pos, pos) - dist3(b.pos, pos))[0];
        if (drop) {
          try { await adapter.moveTo({ kind: 'near', pos: drop.pos, range: 1 }, { signal, timeoutMs: Math.min(6000, Math.max(1000, ctx.deadline - Date.now() - 2000)) }); } catch (e) { if (isAbort(e)) throw e; }
          await adapter.collectNearbyDrops(signal, 3, 1500);
        }
      }
    }
    const gained = adapter.state().inventory.map((item) => ({ name: item.name, count: item.count - (before.get(item.name) ?? 0) })).filter((item) => item.count > 0);
    const data = { target: name, pos, broken: true, gained };
    if (!gained.length) return fail('ERROR', `已拆下 ${name}，但背包没有新增物品；${whereDropsWent(ctx, pos)}`, { ...data, drops: dropsNear(ctx, pos) });
    const dropsItself = /_(bed|door)$/.test(name) || ['crafting_table', 'furnace', 'blast_furnace', 'smoker'].includes(name);
    if (dropsItself && !gained.some((item) => item.name === name)) return fail('ERROR', `已拆下 ${name}，但背包没有新增 ${name}；顺带拾取了 ${gained.map((item) => `${item.name}×${item.count}`).join('、')}，目标掉落物尚未拿到；${whereDropsWent(ctx, pos)}`, data);
    return ok(`已拆下 ${name}；背包新增 ${gained.map((item) => `${item.name}×${item.count}`).join('、')}${structure === 'man-made' ? `；${MAN_MADE_NOTE}` : ''}`, data, structure === 'man-made' ? MAN_MADE_NOTE : undefined);
  } catch (error) {
    if (isAbort(error)) throw error;
    return fail(codeFromError(error), `拆除目标失败：${why(error)}`);
  }
}

// ------------------------------------------------------------------ dig
export const dig: Skill<DigArgs> = {
  name: 'dig',
  description: '定点拆除并拾取，或按 dir 挖通道（dir:down 挖脚下的方块并落到下一级，下面最多 3 格落差内会继续往下、不掉血；N/E/S/W 挖水平通道；up 挖头顶）；默认不制造工具，不挖开液体邻格。wet:true 接受进水，lava:true 接受进岩浆，分别显式选择。',
  argsDoc: '{"target"?: "<方块ID|x,y,z|地标ID>" | {"x":0,"y":64,"z":0}, "block"?: "<目标方块类型约束>", "own"?: true, "dir"?: "up|down|N|E|S|W|forward", "blocks"?: 1-6, "wet"?:true, "lava"?:true, "deadlineMs"?: 可选绝对 epoch 毫秒（只能缩短本次执行期限）}（target 与 dir 二选一）',
  timeoutMs: 60000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const deadlineMs = a.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    const target = a.target ?? a.at ?? a.pos;
    if (target !== undefined) {
      if (a.dir !== undefined || a.direction !== undefined || a.blocks !== undefined || a.count !== undefined) return { ok: false, error: '定点 target 只拆一个目标，不能同时指定 dir/blocks' };
      const point = coordinates(target);
      if (!point && (typeof target !== 'string' || !target.trim() || target.length > 160 || /[,，]/.test(target))) return { ok: false, error: 'target 必须是方块ID、地标ID或有效的 x,y,z 坐标' };
      const block = typeof a.block === 'string' && a.block.trim() ? a.block.trim().replace(/^minecraft:/, '') : undefined;
      return { ok: true, args: { target: point ?? String(target).trim().replace(/^minecraft:/, ''), ...(block ? { block } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
    }
    let dir = String(a.dir ?? a.direction ?? '').trim();
    dir = /^(up|down|forward)$/i.test(dir) ? dir.toLowerCase() : dir.toUpperCase();
    if (!['up', 'down', 'forward', ...Object.keys(DIR_OFFSETS)].includes(dir)) return { ok: false, error: 'dir 必须是 up/down/forward/N/E/S/W' };
    return { ok: true, args: { dir, blocks: clampInt(a.blocks ?? a.count, 1, 6, dir === 'up' ? 2 : 1), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    // 自动续跑沿用原动作期限：args.deadlineMs 只能缩短父任务的 deadline，不能延长。
    const deadline = Math.min(ctx.deadline, args.deadlineMs ?? Number.POSITIVE_INFINITY);
    if (args.target !== undefined) return recoverBlock({ ...ctx, deadline }, args);
    const { adapter, signal } = ctx;
    const dug: string[] = [];
    const start = adapter.state().pos;
    let walked = 0, targetCell: Vec3Like | undefined;
    const effectEvidence = (position: Vec3Like) => {
      const moved = dist3(start, position);
      const reasons = [...(dug.length ? [`已挖 ${dug.join('、')}`] : []), ...(moved > 0.01 ? [`实际位移 ${moved.toFixed(2)} 格`] : [])];
      return { verified: true, changed: reasons.length > 0, reasons };
    };
    // 落点脚高按实际观察状态算；只有名字时属性未知，不能拿默认状态冒充。
    const stateAt: StateAt = (pos) => {
      const state = adapter.blockStateAt?.(pos);
      if (state?.name) return state;
      const name = adapter.blockAt(pos);
      return name === null ? null : { name, properties: {} };
    };
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
          // 和 dig_at [0,-1,0] 一样挖“当前支撑格”：站在半砖/床这类矮方块上时，
          // 支撑就在脚所在那格（floor(y)-1 会挖到它下面的空气）。
          const c = supportCell(adapter.state().pos);
          targetCell = c;
          // 脚下这格挖空后，人往下掉多少格：向下扫最多 3 格找第一个实心落点（3 格以内不掉血）。
          // 以前只看脚下 2 格是不是实心，等于只允许掉 1 格；现在放宽到「不掉血的 3 格安全余量」。
          const { drop, landing } = dropBelow(adapter, c);
          if (drop === 0 || LIQUID_BLOCKS.has(landing ?? '')) {
            const position = adapter.state().pos;
            const peek = adapter.blockAt({ x: c.x, y: c.y - 1, z: c.z });
            const reason = drop === 0
              ? (peek === null ? '下面的落点还没加载，未知能否安全落地' : '下面有超过 3 格的落差，跳下去会掉血')
              : `下面 ${drop} 格是 ${landing}，往下挖会掉进去`;
            const partialStop = { pos: c, below: landing ?? peek, drop, completed: walked, requested: args.blocks };
            const data = { dug, walked, partialStop, targetCell: c, position: { ...position }, effectEvidence: effectEvidence(position) };
            return walked || dug.length ? ok(`挖掉 ${dug.length} 格，确认到达下一级 ${walked} 次；${reason}，停下`, data) : fail('BAD_ARGS', `${reason}，没有往下挖`, data);
          }
          const n = await breakCell(ctx, c, false, undefined, { allowWater: args.wet, allowLava: args.lava });
          if (n) dug.push(n);
          // 落到 drop 格下方第一个实心落点：脚高按落点脚格的实际支撑顶面算。
          // 落点脚格可能还铺着地毯/雪/压力板等薄层（dropBelow 会跳过它们），
          // 不能只用更下方实心块的顶面，否则会把 62.06 的实际脚高误判成 62.00。
          const footCell = { x: c.x, y: c.y - drop + 1, z: c.z };
          const surface = footSurfaceY(footCell, stateAt);
          if (surface === null) {
            const position = adapter.state().pos;
            return fail('NOT_FOUND', `已挖掉 ${dug.length} 格，确认到达下一级 ${walked} 次；落点脚格 (${footCell.x},${footCell.y},${footCell.z}) 的支撑面未确认，未继续移动`,
              { dug, walked, targetCell: c, drop, position: { ...position }, effectEvidence: effectEvidence(position) });
          }
          const expectedFoot = surface;
          let moveError: unknown;
          try { await adapter.moveTo({ kind: 'xyz', x: c.x, y: expectedFoot, z: c.z }, { signal, timeoutMs: 4000 }); }
          catch (e) { if (isAbort(e)) throw e; moveError = e; }
          throwIfAborted(signal);
          const position = adapter.state().pos;
          if (Math.floor(position.x) !== c.x || Math.abs(position.y - expectedFoot) > 0.05 || Math.floor(position.z) !== c.z) {
            return fail(moveError ? codeFromError(moveError) : 'PATH_NOT_FOUND', `已挖掉 ${dug.length} 格，确认到达下一级 ${walked} 次；没有落到 (${c.x},${expectedFoot.toFixed(2)},${c.z})，实际位置 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})${moveError ? `；${why(moveError)}` : ''}`,
              { dug, walked, targetCell: c, drop, expectedFoot, position: { ...position }, effectEvidence: effectEvidence(position) });
          }
          walked++;
        }
        const position = adapter.state().pos;
        return ok(`挖掉 ${dug.length} 格（${dug.join('、') || '本来就空'}），确认到达下一级 ${walked} 次`, { dug, walked, position: { ...position }, effectEvidence: effectEvidence(position) });
      }
      const dirKey = args.dir === 'forward' ? dirOfYaw(adapter.eye()?.yaw ?? 0).replace(/^(N|S)[EW]$/, '$1') : args.dir;
      const [dx, dz] = DIR_OFFSETS[dirKey] ?? DIRS[dirKey] ?? [0, -1];
      for (let i = 0; i < args.blocks; i++) {
        const me = floor(adapter.state().pos);
        const feet = { x: me.x + dx, y: me.y, z: me.z + dz };
        targetCell = feet;
        for (const c of [{ ...feet, y: feet.y + 1 }, feet]) {
          const n = await breakCell(ctx, c, false, undefined, { allowWater: args.wet, allowLava: args.lava });
          if (n) dug.push(n);
        }
        let moveError: unknown;
        try { await adapter.moveTo({ kind: 'xyz', ...feet }, { signal, timeoutMs: 5000 }); }
        catch (e) { if (isAbort(e)) throw e; moveError = e; }
        throwIfAborted(signal);
        const position = adapter.state().pos;
        if (Math.floor(position.x) !== feet.x || Math.floor(position.y + 0.05) !== feet.y || Math.floor(position.z) !== feet.z) {
          return fail(moveError ? codeFromError(moveError) : 'PATH_NOT_FOUND', `往 ${dirKey} 已前进 ${walked} 格${dug.length ? `，挖了 ${dug.join('、')}` : ''}；没有进入目标格 (${feet.x},${feet.y},${feet.z})，实际位置 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})${moveError ? `；${why(moveError)}` : ''}`,
            { dug, walked, targetCell: feet, position: { ...position }, effectEvidence: effectEvidence(position) });
        }
        walked++;
      }
      return ok(`往 ${dirKey} 挖了 ${walked} 格（${dug.length ? dug.join('、') : '本来就通'}）`, { dug, walked });
    } catch (e) {
      if (isAbort(e)) throw e;
      const msg = why(e);
      if (args.dir === 'down') {
        const position = adapter.state().pos;
        const code = msg.includes('流进来') || msg.includes('基岩') || msg.startsWith('那边是') ? 'BAD_ARGS' : codeFromError(e);
        return fail(code, `已挖掉 ${dug.length} 格，确认到达下一级 ${walked} 次；${msg}`, { dug, walked, ...(targetCell ? { targetCell } : {}), position: { ...position }, effectEvidence: effectEvidence(position) });
      }
      if (args.dir !== 'up' && args.dir !== 'down') {
        const position = adapter.state().pos;
        const code = msg.includes('流进来') || msg.includes('基岩') || msg.startsWith('那边是') ? 'BAD_ARGS' : codeFromError(e);
        return fail(code, `往 ${args.dir} 已前进 ${walked} 格${dug.length ? `，挖了 ${dug.join('、')}` : ''}；${msg}`, { dug, walked, ...(targetCell ? { targetCell } : {}), position: { ...position }, effectEvidence: effectEvidence(position) });
      }
      return dug.length ? ok(`挖了 ${dug.join('、')}，然后${msg}`, { dug }) : fail(msg.includes('流进来') || msg.includes('基岩') || msg.startsWith('那边是') ? 'BAD_ARGS' : codeFromError(e), msg);
    }
  },
};

// ------------------------------------------------------------------ climb_up
export const climbUp: Skill<{ height: number; untilSky: boolean; untilExit?: boolean; deadlineMs?: number }> = {
  name: 'climb_up',
  description: '原地往上爬（头顶挡着会先挖开）：脚下是梯子就沿梯子爬，否则跳起来往脚下垫方块（需要背包里有泥土/圆石等方块）；until_sky 爬到看得见天空，until_exit 爬到四周有路可走（出坑）',
  argsDoc: '{"height"?: 1-24, "until_sky"?: boolean, "until_exit"?: boolean, "deadlineMs"?: 可选绝对 epoch 毫秒（只能缩短本次执行期限）}；兼容 untilSky/untilExit；两个停止条件同时开启时须同时满足',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const untilExit = a.until_exit ?? a.untilExit ?? false;
    const untilSky = a.until_sky ?? a.untilSky ?? (a.height === undefined && !untilExit);
    if (typeof untilExit !== 'boolean' || typeof untilSky !== 'boolean') return { ok: false, error: 'until_sky/until_exit 须为布尔值' };
    const deadlineMs = a.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { height: clampInt(a.height, 1, 24, untilSky || untilExit ? 16 : 3), untilSky, ...(untilExit ? { untilExit } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    // 自动续跑沿用原动作期限；args.deadlineMs 只能缩短，不能延长父任务预算。
    const deadline = Math.min(ctx.deadline, args.deadlineMs ?? Number.POSITIVE_INFINITY);
    throwIfAborted(signal);
    const onLadder = () => adapter.blockAt(floor(adapter.state().pos)) === 'ladder';
    const start = adapter.state().pos.y;
    // 同一逻辑动作的共享额度账本：跨顶层/重试/恢复共享，确认爬升才入账，取消/失败也保留。
    const budget = ctx.climb;
    // 首次派发时记录逻辑起点；父委托目标 = 从逻辑起点净升高 height。
    if (budget && !Number.isFinite(budget.startY)) budget.startY = Math.floor(start);
    const remainingSpend = budget ? Math.max(0, budget.height - budget.spent) : args.height;
    const effectiveHeight = Math.min(args.height, remainingSpend);
    // 父动作续跑（经仲裁器派发、无恢复上下文）按父目标验收；恢复子动作按自身 args.height 验收。
    const isParentContinuation = !!budget && ctx.recovery === undefined;
    const netFromStart = () => Math.max(0, Math.floor(adapter.state().pos.y + 0.05) - Math.floor((budget ? budget.startY : start) + 0.05));
    // 身体是否在有效支撑上：站立（onGround）或贴着梯子（梯子上的有效攀爬可以 onGround=false）。
    const landed = () => {
      const state = adapter.state();
      const feet = Math.floor(state.pos.y + 0.05);
      return state.onGround || adapter.blockAt({ x: Math.floor(state.pos.x), y: feet, z: Math.floor(state.pos.z) }) === 'ladder';
    };
    // 确认一次单级转换真正完成：身体在有效支撑上且净高度确实升高，不把空中的瞬时高度当落点。
    const confirmedAscent = (fromY: number) => landed() && Math.floor(adapter.state().pos.y + 0.05) > Math.floor(fromY) && adapter.state().pos.y > fromY + 0.05;
    // moveTo 可能在上跳过程中返回（甚至报 no path）；此时身体还在空中，不能立即判失败。
    // 有界等待真实落地，再按“是否站高”结算；超时仍未落地则如实失败。
    const waitForLanding = async (fromY: number, timeoutMs = 1500) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        throwIfAborted(signal);
        if (confirmedAscent(fromY)) return true;
        if (adapter.state().onGround) return false;
        await sleep(50, signal);
      }
      return confirmedAscent(fromY);
    };
    // Pathfinder only towers with a placeable block in hand. A preceding dig may
    // leave a tool selected, so switch back before each ascent attempt.
    const ensureScaffoldHeld = async () => {
      if (onLadder()) return true;
      const held = adapter.state().held;
      if (held !== null && PLACEABLE.includes(held)) return true;
      const block = adapter.state().inventory.find((item) => item.count > 0 && PLACEABLE.includes(item.name));
      if (block === undefined) return false;
      // Adapters without an explicit equip surface let Pathfinder select the
      // scaffold item itself; do not turn that capability gap into a hard stop.
      if (typeof adapter.equipItem !== 'function') return true;
      const equipped = await adapter.equipItem(block.name, 'hand', signal);
      return equipped.ok;
    };
    // Pathfinder 报错或只是返回却没真正站高时，改用适配器显式的跳起垫块一次；
    // 它报告真实的净空与放置事实，避免把“寻路结束”当成已经爬上去。
    const tryPillarUp = async (fromY: number) => {
      const names = adapter.state().inventory.filter((item) => item.count > 0 && PLACEABLE.includes(item.name)).map((item) => item.name);
      if (names.length === 0 || typeof adapter.pillarUp !== 'function') return false;
      const fallback = await adapter.pillarUp(names, signal);
      return fallback.ok === true && await waitForLanding(fromY);
    };
    let climbedThisRun = 0;
    const total = () => (budget ? budget.spent : climbedThisRun);
    const reached = (around: ReturnType<typeof surroundings>) => (!args.untilSky || around.sky) && (!args.untilExit || around.exits.length > 0);
    // 结构化效果回执：区分本次/净进展（climbed）、累计消耗（spent）与目标是否达成（goalReached），成功/失败/取消共用。
    const currentFacts = (failureCause?: 'PILLAR_CLEARANCE') => {
      const state = adapter.state(), around = surroundings(adapter);
      // 父动作续跑时按净高度报进展；但取消/超时可能停在半空，未站稳时不能把瞬时高度
      // 算成已确认爬升——以累计确认额度为上界，避免伪造未发生的效果。
      const climbed = !isParentContinuation ? climbedThisRun
        : landed() ? netFromStart() : Math.min(netFromStart(), budget!.spent);
      const goalReached = args.untilSky || args.untilExit ? reached(around) : isParentContinuation ? landed() && netFromStart() >= budget!.height : climbedThisRun >= args.height;
      return { climbed, spent: total(), height: budget?.height ?? args.height, sky: around.sky, exits: around.exits, goalReached, position: { ...state.pos }, ...(failureCause ? { failureCause } : {}),
        effectEvidence: { verified: true, changed: climbedThisRun > 0, reasons: [`实际高度 ${start} → ${state.pos.y}`] } };
    };
    const finish = (stopped?: string, failureCause?: 'PILLAR_CLEARANCE') => {
      const facts = currentFacts(failureCause);
      if (facts.goalReached) return ok(`往上爬了 ${facts.climbed} 格${args.untilExit ? '，四周有路了' : args.untilSky ? '，看得见天空了' : ''}`, facts);
      if (!facts.climbed) return fail('STUCK', `未实际爬升${stopped ? `：${stopped}` : '，没有完成垫高'}`, facts);
      return fail('STUCK', `往上爬了 ${facts.climbed} 格后停下：${stopped ?? '已到本次高度或时间上限，仍未满足停止条件'}`, facts);
    };
    const initial = surroundings(adapter);
    if ((args.untilSky || args.untilExit) && reached(initial)) {
      // 已经满足停止条件：没有垫高是对的，但要说清楚，免得以为“爬不上去”
      return ok(`${args.untilExit ? '四周已经有路可走' : '已经看得见天空'}，所以没有垫高；如果是想站上坑沿，用 {"height":2} 这样直接指定格数`,
        { climbed: 0, alreadySatisfied: true, sky: initial.sky, exits: initial.exits });
    }
    // 父委托额度已用完：无需材料，直接按目标验收（达成则完成，未达成则交回）。
    if (effectiveHeight <= 0) return finish('本次授权的高度额度已用完');
    // 只有确实要继续爬时才需要材料。
    if (!onLadder() && !hasPlaceable(adapter.state().inventory)) return fail('MISSING_MATERIALS', '脚下没有梯子，背包里也没有能垫脚的方块（泥土/圆石/石头/木板）');
    let lastBeforeY: number | undefined;
    // 单级转换的成功、失败、取消及清障重试共用一次结算：身体已在有效支撑上站高才算入账。
    // 实际效果始终结算（无论有无预算）；只有累计预算的更新依赖预算对象存在。
    const settlePending = () => {
      if (lastBeforeY !== undefined && confirmedAscent(lastBeforeY)) {
        climbedThisRun++;
        if (budget) budget.spent++;
        lastBeforeY = undefined;
      }
    };
    try {
      for (let i = 0; i < effectiveHeight && Date.now() < deadline - 1000; i++) {
        throwIfAborted(signal);
        const here = surroundings(adapter);
        if ((args.untilSky || args.untilExit) && reached(here)) break;
        const before = adapter.state().pos, me = floor(before);
        lastBeforeY = before.y;
        const moveUp = () => adapter.moveTo({ kind: 'xyz', x: me.x, y: me.y + 1, z: me.z }, { signal, timeoutMs: Math.max(1, Math.min(8000, deadline - Date.now())), allowTerrainChanges: true });
        // 头顶的方块先挖开（不挖液体旁边的）
        try {
          await breakCell(ctx, { x: me.x, y: me.y + 2, z: me.z });
        } catch (e) {
          if (isAbort(e)) throw e;
          return finish(why(e));
        }
        if (!(await ensureScaffoldHeld())) {
          return finish('背包里没有可垫脚方块，或无法切换到手持方块');
        }
        try {
          await moveUp();
        } catch (e) {
          if (isAbort(e)) throw e;
          const name = e instanceof Error ? e.name : undefined;
          if (name !== 'PillarClearanceError') {
            // The pathfinder can return while the jump/placement is still settling.
            const climbedBefore = climbedThisRun;
            await waitForLanding(before.y);
            settlePending();
            if (climbedThisRun > climbedBefore) return finish(why(e));
            // 寻路确实报错、身体也没有升高：先用显式垫高尝试一次，再决定失败。
            if (!(await tryPillarUp(before.y))) return finish(why(e));
            settlePending();
            ctx.senses.refresh();
            continue;
          }
          // 搭柱被头顶/侧上方挡住：适配器报告具体那一格，把它挖开再垫一次；挖不动（基岩、近液体）由 breakCell 抛错如实停下
          const blocked = (e as { block?: { pos: Vec3Like } }).block?.pos;
          if (!blocked) return finish(why(e), 'PILLAR_CLEARANCE');
          try {
            await breakCell(ctx, blocked);
          } catch (e2) {
            if (isAbort(e2)) throw e2;
            return finish(why(e2), 'PILLAR_CLEARANCE');
          }
          if (!(await ensureScaffoldHeld())) {
            return finish('背包里没有可垫脚方块，或无法切换到手持方块', 'PILLAR_CLEARANCE');
          }
          try {
            await moveUp();
          } catch (e2) {
            if (isAbort(e2)) throw e2;
            await waitForLanding(before.y);
            settlePending();
            return finish(why(e2), e2 instanceof Error && e2.name === 'PillarClearanceError' ? 'PILLAR_CLEARANCE' : undefined);
          }
        }
        throwIfAborted(signal);
        // Pathfinder can resolve mid-jump without placing a block. Fall back to
        // the adapter's explicit jump-and-place once; it reports real clearance
        // and placement facts instead of assuming a path result is a climb.
        if (!(await waitForLanding(before.y)) && !(await tryPillarUp(before.y))) {
          return finish('移动已结束，但脚下没有实际站高');
        }
        climbedThisRun++;
        if (budget) budget.spent++;
        lastBeforeY = undefined;
        ctx.senses.refresh();
        if (!onLadder() && !hasPlaceable(adapter.state().inventory)) break;
      }
      throwIfAborted(signal);
      return finish();
    } catch (e) {
      settlePending();
      if (isAbort(e)) (e as Error & { partial?: Record<string, unknown> }).partial = currentFacts();
      throw e;
    }
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
