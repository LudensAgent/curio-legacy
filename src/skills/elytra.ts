import type { Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

/**
 * 鞘翅飞行：速度约 30 格/秒，远超 LLM 的反应窗口，所以这是一段“通用执行辅助”的连续控制
 * （起飞/巡航/避障/着陆都在一次调用内完成，中间不停下来问），而不是逐格寻路。
 * Agent 决定要不要飞、飞去哪个已知坐标、允许多少火箭；辅助只稳定执行并如实回报真实结果。
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);
const FLUID = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
/** 身体可以占据、但不能当支撑的格子（草、花、雪、火把、线、梯子…） */
const PASSABLE = new Set([...AIR, ...FLUID, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose', 'snow', 'torch', 'wall_torch', 'redstone_wire', 'rail', 'ladder', 'vine', 'cobweb']);

/** 是否实心可站立（含树叶、玻璃等有完整碰撞体的方块）；null 表示未加载，不是实心也不是空气 */
function solidAt(ctx: { blockAt: (p: Vec3Like) => string | null }, p: Vec3Like): boolean {
  const name = ctx.blockAt(p);
  return name !== null && !PASSABLE.has(name);
}

/** 目标列（x,z）自上而下找第一个“脚下实心、脚与头两格可通过”的落点；未加载或找不到返回 null */
function landingAt(blockAt: (p: Vec3Like) => string | null, x: number, z: number, fromY: number): { stand: Vec3Like; support: string } | null {
  for (let y = Math.floor(fromY); y >= Math.floor(fromY) - 24; y--) {
    const support = blockAt({ x, y: y - 1, z });
    if (support === null) return null; // 这一层还没加载，不能再往下猜
    if (AIR.has(support) || FLUID.has(support)) continue; // 继续往下找
    if (PASSABLE.has(support)) continue; // 草/雪这类不算支撑，继续往下
    const feet = blockAt({ x, y, z }), head = blockAt({ x, y: y + 1, z });
    if (feet === null || head === null) return null;
    if (!PASSABLE.has(feet) || !PASSABLE.has(head)) continue; // 身体空间被占
    return { stand: { x: x + 0.5, y, z: z + 0.5 }, support };
  }
  return null;
}

export const assessFlight: Skill<{ to: Vec3Like }> = {
  name: 'assess_flight',
  description: '只读评估用鞘翅飞到某个已知坐标的前提与落点：是否已穿鞘翅、有多少烟花火箭、当前是否站得住，以及目标列能否着陆、已加载范围内有没有挡路的实心方块；超出已加载范围如实标为未知，不替 Agent 决定是否飞行',
  argsDoc: '{"to":{"x":数值,"y":数值,"z":数值}}；只评估，不移动',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const to = obj(obj(raw).to);
    if (![to.x, to.y, to.z].every((n) => typeof n === 'number' && Number.isFinite(n))
      || Math.abs(to.x) > 29_999_984 || Math.abs(to.z) > 29_999_984 || Math.abs(to.y) > 2048) return { ok: false, error: 'to 需要目标坐标 {x,y,z} 的有限坐标' };
    return { ok: true, args: { to: { x: to.x, y: Math.floor(to.y) + 0.5, z: to.z } } };
  },
  async run(ctx, args) {
    const { adapter } = ctx;
    const state = adapter.state();
    if (!state.connected || !state.alive || !state.observationReady) return fail('NOT_CONNECTED', '没有有效的存活观测，不能评估飞行');
    const elytra = state.equipment?.find((e) => e.slot === 'torso')?.name === 'elytra';
    const rockets = state.inventory.find((i) => i.name === 'firework_rocket')?.count ?? 0;
    const from = state.pos;
    const horiz = Math.hypot(args.to.x - from.x, args.to.z - from.z);
    // 落点：目标列能否着陆
    const landing = landingAt((p) => adapter.blockAt(p), Math.floor(args.to.x), Math.floor(args.to.z), args.to.y);
    // 已加载范围内的粗直线走廊：以高于目标列地面约 10 格、以及当前高度两条线采样，实心算阻挡，未加载算未知
    const groundY = landing ? landing.stand.y : args.to.y;
    const cruise = Math.max(Math.floor(from.y) + 1, Math.floor(groundY) + 10);
    let clearUntil = horiz, blocked: Vec3Like | null = null, unknownFrom: number | null = null;
    const steps = Math.min(48, Math.ceil(horiz));
    for (let i = 0; i <= steps; i++) {
      const f = steps ? i / steps : 0;
      const px = from.x + (args.to.x - from.x) * f, pz = from.z + (args.to.z - from.z) * f;
      for (const y of [cruise, Math.floor(from.y) + 2]) {
        const name = adapter.blockAt({ x: Math.floor(px), y, z: Math.floor(pz) });
        if (name === null) { if (unknownFrom === null) unknownFrom = f * horiz; break; }
        if (!PASSABLE.has(name)) { blocked = { x: Math.floor(px), y, z: Math.floor(pz) }; clearUntil = f * horiz; break; }
      }
      if (blocked || unknownFrom !== null) break;
    }
    const facts = {
      target: args.to, from, horizontalDistance: Math.round(horiz), elytraEquipped: elytra, fireworkRockets: rockets,
      onGround: state.onGround, inWater: state.inWater, dim: state.dim, hp: state.hp,
      landing: landing ? { stand: landing.stand, support: landing.support, feasible: true } : { feasible: false },
      corridor: { cruiseY: cruise, clearUntil: Math.round(clearUntil), ...(blocked ? { blockedAt: blocked } : {}), ...(unknownFrom !== null ? { unknownFrom: Math.round(unknownFrom) } : {}) },
      gaps: [] as string[],
      effectEvidence: { verified: true, changed: false, reasons: ['只读评估穿戴、火箭、落点与已加载走廊，未移动'] },
    };
    if (!elytra) facts.gaps.push('未穿戴鞘翅（占胸甲槽）');
    if (!state.onGround) facts.gaps.push('当前不在地面（从高处起跳可直接滑翔，但落点与进近需重新判断）');
    else if (rockets === 0) facts.gaps.push('站在平地上且没有烟花火箭：没有高度来源，直接起飞会立即落地');
    if (!landing) facts.gaps.push('目标列未找到可着陆的实心落点（或未加载），需要换目标或先走近查看');
    if (blocked) facts.gaps.push(`已加载范围内 ${Math.round(clearUntil)} 格处有实心方块阻挡直线走廊（${blocked.y} 高度）`);
    if (unknownFrom !== null) facts.gaps.push(`走廊在 ${Math.round(unknownFrom)} 格后未加载，未知前方；飞行辅助会在未知时爬升，但不保证可达`);
    return ok(elytra && landing ? '已穿鞘翅，目标列可着陆；走廊与火箭情况见数据，未移动' : '飞行前提或落点不满足，缺口见数据，未移动', facts);
  },
};

export const flyTo: Skill<{ to: Vec3Like; allowRockets?: boolean; maxRockets?: number }> = {
  name: 'fly_to',
  description: '用鞘翅飞到已知坐标：起飞、巡航、避障、着陆都在这一趟里连续完成（速度约 30 格/秒，不逐格问）。允许火箭时可用烟花推进爬升；只报告真实结果——是否真正落地、是否到达目标、是否撞伤、消耗几发火箭。飞行前先 assess_flight 确认前提与落点',
  argsDoc: '{"to":{"x":数值,"y":数值,"z":数值}, "allowRockets"?:true（允许用烟花火箭推进）, "maxRockets"?:0-64}',
  timeoutMs: 90000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const to = obj(a.to);
    if (![to.x, to.y, to.z].every((n) => typeof n === 'number' && Number.isFinite(n))
      || Math.abs(to.x) > 29_999_984 || Math.abs(to.z) > 29_999_984 || Math.abs(to.y) > 2048) return { ok: false, error: 'to 需要目标坐标 {x,y,z}' };
    if (a.allowRockets !== undefined && typeof a.allowRockets !== 'boolean') return { ok: false, error: 'allowRockets 需要布尔值' };
    if (a.maxRockets !== undefined && (!Number.isInteger(a.maxRockets) || a.maxRockets < 0 || a.maxRockets > 64)) return { ok: false, error: 'maxRockets 需要 0-64 的整数' };
    return { ok: true, args: { to: { x: to.x, y: Math.floor(to.y) + 0.5, z: to.z }, ...(a.allowRockets === true ? { allowRockets: true } : {}), ...(a.maxRockets !== undefined ? { maxRockets: a.maxRockets } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const state = adapter.state();
    if (!state.connected || !state.alive || !state.observationReady) return fail('NOT_CONNECTED', '没有有效的存活观测，不能起飞');
    if (!adapter.glideTo) return fail('ERROR', '当前适配器不支持鞘翅飞行控制');
    const elytra = state.equipment?.find((e) => e.slot === 'torso')?.name === 'elytra';
    if (!elytra) return fail('MISSING_MATERIALS', '未穿戴鞘翅（占胸甲槽）；先 equip_armor 或手动装备，再 assess_flight 确认');
    const rockets = state.inventory.find((i) => i.name === 'firework_rocket')?.count ?? 0;
    if (args.allowRockets === true && rockets === 0) return fail('MISSING_MATERIALS', 'allowRockets:true 但背包里没有烟花火箭');
    const start = { ...state.pos };
    const hp0 = state.hp;
    try {
      const result = await adapter.glideTo(args.to, signal, {
        timeoutMs: Math.max(1, Math.min(90000, ctx.deadline - Date.now())),
        allowRockets: args.allowRockets === true,
        maxRockets: args.maxRockets ?? 0,
      });
      const p = result.position;
      const data = {
        target: args.to, from: start, ...result,
        effectEvidence: { verified: result.arrived === true, changed: result.arrived === true || result.landed === true,
          reasons: [result.arrived === true ? `实际脚位 ${start.y.toFixed(1)} → ${p.y.toFixed(1)}` : '未到达目标，以实际位置为准'] },
      };
      if (result.arrived) return ok(`鞘翅飞行结束：已落到目标附近（实际在 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})，距目标 ${result.distance} 格，${result.rocketsUsed ? `耗 ${result.rocketsUsed} 发火箭` : '未用火箭'}${result.hpLost ? `，掉 ${result.hpLost} 点血` : ''}）`, data);
      const code = result.reason === 'TIMEOUT' ? 'TIMEOUT' as const
        : result.reason === 'NO_ELYTRA' ? 'MISSING_MATERIALS' as const
        : result.reason === 'NOT_CONNECTED' ? 'NOT_CONNECTED' as const
        : result.crashed ? 'LOW_HP' as const : 'PATH_NOT_FOUND' as const;
      const summary = result.reason === 'LANDED_SHORT'
        ? `鞘翅已着陆但没到目标：实际在 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})，离目标还差 ${result.distance} 格（${result.crashed ? '飞行中撞到东西' : '高度不够提前落地'}${result.hpLost ? `，掉 ${result.hpLost} 点血` : ''}）`
        : `鞘翅飞行没有完成：${result.reason ?? '未到达'}（实际在 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})，距目标 ${result.distance} 格${result.crashed ? '，飞行中撞到东西' : ''}${result.rocketsUsed ? `，已耗 ${result.rocketsUsed} 发火箭` : ''}${result.hpLost ? `，掉 ${result.hpLost} 点血` : ''}）`;
      return fail(code, summary, data);
    } catch (error) {
      if (isAbort(error)) throw error;
      const pos = adapter.state().pos;
      const hpLost = Math.max(0, hp0 - adapter.state().hp);
      return fail(codeFromError(error), `鞘翅飞行中断：${(error as Error).message}（实际在 (${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)})${hpLost ? `，掉 ${hpLost} 点血` : ''}）`, {
        target: args.to, from: start, position: pos, hpLost, effectEvidence: { verified: true, changed: dist3(start, pos) > 0.5, reasons: [`实际脚位 ${start.y.toFixed(1)} → ${pos.y.toFixed(1)}`] },
      });
    }
  },
};

export const flightSkills = { assess_flight: assessFlight, fly_to: flyTo };
