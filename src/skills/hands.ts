import { dist3 } from '../util.ts';
import { DIRS } from '../perception/perception.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { resolveItemAlias } from './work.ts';

/**
 * 玩家的“手”：Q 键扔东西、F 键换副手、数字键选快捷栏、把东西穿到身上。
 * 只是动作本身——什么时候把金锭丢给猪灵、把小麦丢给村民、把火把放副手，由 LLM 自己判断。
 */

const SLOTS = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] as const;
type Dest = typeof SLOTS[number];
const SLOT_ZH: Record<Dest, string> = { hand: '主手', 'off-hand': '副手', head: '头', torso: '胸', legs: '腿', feet: '脚' };

const itemArg = (raw: unknown, adapter: Parameters<typeof resolveItemAlias>[1]) => {
  const name = String(raw ?? '').trim().replace(/^minecraft:/, '');
  return name ? resolveItemAlias(name, adapter) : null;
};

// ------------------------------------------------------------------ toss_item
type Toward = 'back' | 'front' | keyof typeof DIRS | { x: number; y: number; z: number };
export const tossItem: Skill<{ item: string; count: number | null; sourceSlot?: number; to?: string; toward?: Toward }> = {
  name: 'toss_item',
  description: '扔出物品（Q 键）；to 写看得见的实体会先走近朝它扔；toward 定往哪扔（不写就朝正看着的方向，扔在前面一两格）',
  argsDoc: '{"item","sourceSlot"?:5-45（inspect_inventory 的源槽；item 须匹配，只扔该槽）,"count"?:默认全部,"to"?:"<实体名>","toward"?:"back|front|N|NE|E|SE|S|SW|W|NW" 或 [x,y,z]}',
  timeoutMs: 30000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const item = itemArg(a.item, adapter);
    if (!item) return { ok: false, error: `未知物品：${String(a.item ?? '')}` };
    const sourceSlot = a.sourceSlot;
    if (sourceSlot !== undefined && (!Number.isInteger(sourceSlot) || sourceSlot < 5 || sourceSlot > 45)) return { ok: false, error: 'sourceSlot 必须是 inspect_inventory 的槽位整数 5-45' };
    let count: number | null = null;
    if (a.count !== undefined && a.count !== null) {
      const n = Number(a.count);
      if (!Number.isInteger(n) || n < 1 || n > 2304) return { ok: false, error: 'count 必须是正整数' };
      count = n;
    }
    const to = typeof a.to === 'string' && a.to.trim() ? a.to.trim().toLowerCase() : undefined;
    let toward: Toward | undefined;
    if (a.toward !== undefined && a.toward !== null && a.toward !== '') {
      const t = a.toward;
      const xyz = Array.isArray(t) ? t : typeof t === 'string' && /^-?\d+(\.\d+)?[,\s]+-?\d+(\.\d+)?[,\s]+-?\d+(\.\d+)?$/.test(t.trim()) ? t.trim().split(/[,\s]+/) : null;
      if (xyz && xyz.length === 3 && xyz.every((n) => Number.isFinite(Number(n)))) toward = { x: Number(xyz[0]), y: Number(xyz[1]), z: Number(xyz[2]) };
      else if (typeof t === 'string' && ['back', 'front'].includes(t.trim().toLowerCase())) toward = t.trim().toLowerCase() as 'back' | 'front';
      else if (typeof t === 'string' && DIRS[t.trim().toUpperCase()]) toward = t.trim().toUpperCase() as keyof typeof DIRS;
      else return { ok: false, error: 'toward 写 back（身后）、front、方位 N/NE/E/SE/S/SW/W/NW，或坐标 [x,y,z]' };
      if (to) return { ok: false, error: 'to（扔给谁）和 toward（往哪扔）只写一个' };
    }
    return { ok: true, args: { item, count, ...(sourceSlot !== undefined ? { sourceSlot } : {}), ...(to ? { to } : {}), ...(toward ? { toward } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.tossItem) return fail('ERROR', '当前适配器不支持扔物品');
    if (args.sourceSlot === undefined && !adapter.state().inventory.some((i) => i.name === args.item)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`);
    try {
      let face: { x: number; y: number; z: number } | undefined;
      let toName: string | undefined;
      if (args.to) {
        const match = (n: string) => n === args.to || n.endsWith(`_${args.to}`) || n.replace(/^player:/, '') === args.to;
        senses.refresh();
        const target = senses.perceivedEntities(32).filter((e) => e.kind !== 'item' && match(e.name)).sort((a, b) => a.dist - b.dist)[0];
        if (!target) return fail('NOT_FOUND', `看不见 ${args.to}，没有扔`);
        if (target.dist > 3) {
          ctx.progress(0.3, `走到 ${target.name} 旁边`);
          await adapter.moveTo({ kind: 'near', pos: target.pos, range: 2 }, { signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now() - 5000) });
        }
        senses.refresh();
        const now = senses.perceivedEntities(32).find((e) => e.id === target.id) ?? target;
        if (dist3(adapter.state().pos, now.pos) > 6) return fail('PATH_NOT_FOUND', `走不到 ${target.name} 跟前，没有扔`);
        face = now.pos;
        toName = now.name;
      }
      let where = '';
      if (!face && args.toward) {
        // 往哪扔：身后、某个方位、某一点；落点按约 3 格远算（只是转个身再扔）
        const eye = adapter.eye(), p = adapter.state().pos;
        const yaw = eye?.yaw ?? 0;
        const step = (dx: number, dz: number) => { const l = Math.hypot(dx, dz) || 1; return { x: p.x + dx / l * 3, y: p.y, z: p.z + dz / l * 3 }; };
        const t = args.toward;
        face = typeof t === 'object' ? t : t === 'back' ? step(Math.sin(yaw), Math.cos(yaw)) : t === 'front' ? step(-Math.sin(yaw), -Math.cos(yaw)) : step(DIRS[t][0], DIRS[t][1]);
        where = typeof t === 'object' ? `（朝 ${t.x},${t.y},${t.z}）` : t === 'back' ? '（朝身后）' : t === 'front' ? '' : `（朝 ${t}）`;
      }
      const r = await adapter.tossItem(args.item, args.count, signal, face, { gift: !!toName, ...(args.sourceSlot !== undefined ? { sourceSlot: args.sourceSlot } : {}) });
      if (!r.ok) return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : 'ERROR', `扔 ${args.item} 失败：${r.reason}`);
      const left = adapter.state().inventory.filter((i) => i.name === args.item).reduce((n, i) => n + i.count, 0);
      return ok(`扔出了 ${r.tossed} 个 ${args.item}${toName ? `（朝 ${toName}）` : where}，背包还剩 ${left} 个；掉在地上的东西过一会儿才会被捡走或消失`, { item: args.item, tossed: r.tossed, left, ...(toName ? {} : { expect: { discarded: [args.item], forMs: 180_000, what: `扔掉了 ${args.item}×${r.tossed}${where}` } }), ...(toName ? { to: toName } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `扔 ${args.item} 出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ hold_item
export const holdItem: Skill<{ item: string | null; to: Dest; slot?: number; sourceSlot?: number }> = {
  name: 'hold_item',
  description: '拿到主手/副手、穿上，或放进快捷栏 slot 并选中；sourceSlot 选择同名物品中的具体一件，item:null 清空该手或脱下护甲',
  argsDoc: '{"item":"<物品名>"|null,"to"?:"hand|off-hand|head|torso|legs|feet","sourceSlot"?:5-45（inspect_inventory 的源槽，物品名须匹配）,"slot"?:0-8（目标快捷栏）}',
  timeoutMs: 15000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const item = a.item === null ? null : itemArg(a.item, adapter);
    if (item === null && a.item !== null) return { ok: false, error: `未知物品：${String(a.item ?? '')}` };
    const to = (typeof a.to === 'string' && a.to.trim() ? a.to.trim().toLowerCase().replace(/^offhand$/, 'off-hand') : 'hand') as Dest;
    if (!SLOTS.includes(to)) return { ok: false, error: `to 必须是 ${SLOTS.join('/')}` };
    const sourceSlot = a.sourceSlot;
    if (sourceSlot !== undefined && (!Number.isInteger(sourceSlot) || sourceSlot < 5 || sourceSlot > 45)) return { ok: false, error: 'sourceSlot 必须是 inspect_inventory 的槽位整数 5-45' };
    if (item === null && (sourceSlot !== undefined || a.slot !== undefined)) return { ok: false, error: 'item:null 用来清空装备位置，不能同时指定 sourceSlot 或 slot' };
    if (a.slot !== undefined && a.slot !== null) {
      const slot = Number(a.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 8) return { ok: false, error: 'slot 必须是 0-8' };
      if (to !== 'hand') return { ok: false, error: 'slot 只能和 to:"hand" 一起用' };
      return { ok: true, args: { item, to, slot, ...(sourceSlot !== undefined ? { sourceSlot } : {}) } };
    }
    return { ok: true, args: { item, to, ...(sourceSlot !== undefined ? { sourceSlot } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const s = adapter.state();
    const worn = s.equipment?.find((e) => e.slot === args.to)?.name;
    if (args.item === null) {
      if (!adapter.equipItem) return fail('ERROR', '当前适配器没有装备接口');
      try {
        const result = await adapter.equipItem(null, args.to, signal);
        if (!result.ok) return fail('ERROR', `清空${SLOT_ZH[args.to]}失败：${result.reason}`);
        const after = adapter.state();
        return ok(`${SLOT_ZH[args.to]}已清空`, { held: after.held, equipment: after.equipment });
      } catch (error) {
        if (isAbort(error)) throw error;
        return fail(codeFromError(error), `清空${SLOT_ZH[args.to]}出错：${(error as Error).message}`);
      }
    }
    // 手里已经是这种东西：同名还有更耐用的才真换（“换把好石镐”），不然就是已经拿着了
    const best = s.inventory.find((i) => i.name === args.item)?.durabilities?.[0];
    const better = s.heldDurability && best !== undefined && best > s.heldDurability.left;
    if (args.sourceSlot === undefined && args.to === 'hand' && args.slot === undefined && s.held === args.item && !better) return ok(`${args.item} 已经在主手${s.heldDurability ? `（耐久 ${s.heldDurability.left}/${s.heldDurability.max}，背包里没有更耐用的同名的）` : ''}`);
    if (args.sourceSlot === undefined && args.to !== 'hand' && worn === args.item) return ok(`${args.item} 已经在${SLOT_ZH[args.to]}`);
    if (args.sourceSlot === undefined && !s.inventory.some((i) => i.name === args.item)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`);
    try {
      if (args.slot !== undefined) {
        if (!adapter.arrangeHotbar) return fail('ERROR', '当前适配器不支持整理快捷栏');
        const r = await adapter.arrangeHotbar(args.item, args.slot, signal, args.sourceSlot === undefined ? undefined : { sourceSlot: args.sourceSlot });
        if (!r.ok) return fail('ERROR', `把 ${args.item} 放到快捷栏第 ${args.slot} 格失败：${r.reason}`);
        return ok(`${args.item} 放在快捷栏第 ${args.slot} 格并拿在主手`, { hotbar: adapter.state().hotbar });
      }
      if (!adapter.equipItem) return fail('ERROR', '当前适配器没有装备接口');
      const r = await adapter.equipItem(args.item, args.to, signal, args.sourceSlot === undefined ? undefined : { sourceSlot: args.sourceSlot });
      if (!r.ok) return fail('ERROR', `把 ${args.item} 放到${SLOT_ZH[args.to]}失败：${r.reason}`);
      const after = adapter.state();
      const swapped = args.to !== 'hand' && worn && worn !== args.item ? `，换下的 ${worn} 回到背包` : '';
      const dur = args.to === 'hand' && after.heldDurability ? `（耐久 ${after.heldDurability.left}/${after.heldDurability.max}）` : '';
      return ok(`${args.item}${dur} 已在${SLOT_ZH[args.to]}${swapped}`, { held: after.held, equipment: after.equipment });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `拿 ${args.item} 出错：${(e as Error).message}`);
    }
  },
};

export const inspectInventory: Skill<{}> = {
  name: 'inspect_inventory',
  description: '按实际槽位查看背包、快捷栏和装备中的每一叠物品，保留附魔、自定义名、耐久及 NBT（药水、书、地图等）；sourceSlot 可用于精确持物或丢弃',
  argsDoc: '{}',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate: () => ({ ok: true, args: {} }),
  async run(ctx) {
    if (!ctx.adapter.inventorySlots) return fail('ERROR', '当前适配器不能逐槽查看物品');
    const slots = ctx.adapter.inventorySlots();
    return ok(slots.length ? `物品槽位：${slots.map((item) => `${item.slot}: ${item.name}×${item.count}${item.customName ? `「${item.customName}」` : ''}${item.enchants?.length ? `（${item.enchants.join('、')}）` : ''}`).join('；')}；操作后槽位可能改变，下次选择前重新查看` : '背包和装备槽都是空的', { slots });
  },
};

export const handSkills = [tossItem, holdItem, inspectInventory];
