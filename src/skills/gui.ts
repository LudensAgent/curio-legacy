import type { GuiOp, GuiView, TradeView, Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import { glanceAt, inspectBlock } from './observation.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { resolveItemAlias } from './work.ts';

/**
 * 通用界面：打开一个方块界面，看格子，放、取、点按钮。
 * 铁砧修东西、锻造台升级下界合金、砂轮去附魔、切石机、酿造台、附魔台、织布机……玩家都是同样几下鼠标。
 * 这里不写任何一种工作站的玩法，只如实报告每一格里实际有什么。
 */

const showView = (v: GuiView | undefined) => {
  if (!v) return '';
  const slots = v.slots.map((s) => `${s.slot}${s.role ? ` ${s.role}` : ''}：${s.name ? `${s.name}×${s.count}${s.enchants ? `（${s.enchants.join('、')}）` : ''}` : '空'}`);
  const ench = v.enchantments?.length ? `；附魔选项：${v.enchantments.map((e) => `button ${e.option} 需 ${e.level} 级${e.hint ? `（可能 ${e.hint}）` : ''}`).join('，')}` : '';
  return `【${v.type} 界面】${slots.join('；') || '全空'}${ench}`;
};

const parseOps = (raw: unknown, adapter: Parameters<typeof resolveItemAlias>[1]): GuiOp[] | string => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'ops 必须是数组';
  if (raw.length > 12) return 'ops 一次最多 12 步';
  const out: GuiOp[] = [];
  for (const r of raw) {
    const o = obj(r);
    const slotOf = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < 64 ? Number(v) : null);
    if (o.put !== undefined) {
      const p = obj(o.put);
      const item = resolveItemAlias(String(p.item ?? '').trim().replace(/^minecraft:/, ''), adapter);
      const slot = slotOf(p.slot);
      if (!item) return `put 的物品不认识：${String(p.item ?? '')}`;
      if (slot === null) return 'put 需要 slot（界面里的格子号）';
      const count = p.count === undefined ? undefined : Number(p.count);
      if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 64)) return 'put.count 必须是 1-64';
      out.push({ put: { item, slot, ...(count ? { count } : {}) } });
    } else if (o.take !== undefined) {
      const slot = slotOf(typeof o.take === 'object' ? obj(o.take).slot : o.take);
      if (slot === null) return 'take 需要 slot';
      out.push({ take: { slot } });
    } else if (o.button !== undefined) {
      const n = Number(o.button);
      if (!Number.isInteger(n) || n < 0 || n > 127) return 'button 必须是 0-127 的整数';
      out.push({ button: n });
    } else if (o.rename !== undefined) {
      const name = String(o.rename).slice(0, 50);
      if (!name.trim()) return 'rename 不能为空';
      out.push({ rename: name });
    } else return `看不懂的操作：${JSON.stringify(r)}`;
  }
  return out;
};

// ------------------------------------------------------------------ use_gui
export const useGui: Skill<{ target: string | Vec3Like; ops: GuiOp[] }> = {
  name: 'use_gui',
  description: '打开看得见的方块界面（铁砧、锻造台、砂轮、切石机、酿造台、附魔台、织布机、漏斗等），看每格放着什么，按格子放入/取出/点按钮',
  argsDoc: '{"target":"<方块名>"|{x,y,z},"ops"?:[{"put":{"item","slot","count"?}}|{"take":{"slot"}}|{"button":n}|{"rename":"名字"}]}，不带 ops 只看',
  timeoutMs: 45000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const target = inspectBlock.validate({ target: a.target }, adapter);
    if (!target.ok) return target;
    const ops = parseOps(a.ops, adapter);
    if (typeof ops === 'string') return { ok: false, error: ops };
    return { ok: true, args: { target: target.args.target, ops } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.useGui) return fail('ERROR', '当前适配器不支持界面操作');
    try {
      const names = typeof args.target === 'string' ? [args.target, ...adapter.resolveBlockNames(args.target)] : null;
      senses.refresh();
      const candidates: Vec3Like[] = names ? senses.knownBlocks(names, 32).slice(0, 8).map((h) => h.pos) : [args.target as Vec3Like];
      const seen = () => {
        senses.refresh();
        if (!senses.observeBlocks) return candidates.filter((p) => !names || names.includes(adapter.blockAt(p) ?? ''));
        return senses.observeBlocks(candidates).filter((o) => o.source === 'vision' && (!names || names.includes(o.name))).map((o) => o.pos);
      };
      let spots = seen();
      if (!spots.length && candidates[0]) { await glanceAt(ctx, candidates[0]); spots = seen(); }
      const here = adapter.state().pos;
      const pos = spots.sort((p, q) => dist3(here, p) - dist3(here, q))[0];
      if (!pos) return fail('NOT_FOUND', `看不见${typeof args.target === 'string' ? ` ${args.target}` : '这个方块'}（转头看过也没有；记忆里的坐标不能代替看见）`);
      const r = await adapter.useGui(pos, args.ops, signal);
      const view = showView(r.view);
      const did = r.done.length ? `做了：${r.done.join('，')}。` : '';
      if (!r.ok) {
        const code = r.reason?.startsWith('NO_ITEM') ? 'MISSING_MATERIALS' : r.reason?.startsWith('NOT_OPENABLE') ? 'BAD_ARGS' : 'ERROR';
        return fail(code, `界面操作没做完：${r.reason}。${did}${view}`, { pos, done: r.done, view: r.view });
      }
      return ok(`${did}${view}${args.ops.length ? '' : '（只看了一眼，没有动）'}；关掉后工作站里剩下的输入会退回背包，熔炉/酿造台/漏斗里的会留在里面`, { pos, done: r.done, view: r.view });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `界面操作出错：${(e as Error).message}`);
    }
  },
};

const showTrades = (t: TradeView[]) => t.map((x) => `#${x.index} ${x.give.join(' + ')} → ${x.get}${x.disabled ? '（已售罄）' : `（${x.uses}/${x.maxUses}）`}`).join('；');

// ------------------------------------------------------------------ trade
export const trade: Skill<{ who: string; id?: number; index: number | null; times: number }> = {
  name: 'trade',
  description: '和看得见的村民/流浪商人交易：不带 index 先看他卖什么收什么（价格是现价），带 index 按那条交易做 times 次；交易表是每一位各自的，按表交易时用 id 指定同一位',
  argsDoc: '{"who"?:"villager|wandering_trader","id"?:<实体id>,"index"?:n,"times"?:1-12}',
  timeoutMs: 40000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const who = typeof a.who === 'string' && a.who.trim() ? a.who.trim().toLowerCase() : 'villager';
    let index: number | null = null;
    if (a.index !== undefined && a.index !== null) {
      index = Number(a.index);
      if (!Number.isInteger(index) || index < 0 || index > 30) return { ok: false, error: 'index 必须是交易表里的序号' };
    }
    const times = a.times === undefined ? 1 : Number(a.times);
    if (!Number.isInteger(times) || times < 1 || times > 12) return { ok: false, error: 'times 必须是 1-12' };
    let id: number | undefined;
    if (a.id !== undefined && a.id !== null) {
      id = Number(a.id);
      if (!Number.isInteger(id) || id < 0) return { ok: false, error: 'id 必须是看到的实体 id' };
    }
    return { ok: true, args: { who, index, times, ...(id !== undefined ? { id } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.tradeWith) return fail('ERROR', '当前适配器不支持交易');
    senses.refresh();
    const match = (n: string) => n === args.who || n.endsWith(`_${args.who}`);
    // 一眼看得出不交易的（幼崽、傻子、无业）排到后面；给了 id 就只找那一位
    const unlikely = (e: { traits?: string }) => /幼崽|傻子|无业/.test(e.traits ?? '');
    const seen = senses.perceivedEntities(24).filter((e) => e.perception !== 'heard' && (args.id !== undefined ? e.id === args.id : match(e.name)))
      .sort((a, b) => Number(unlikely(a)) - Number(unlikely(b)) || a.dist - b.dist);
    if (!seen.length) return fail('NOT_FOUND', args.id !== undefined ? `看不见 id=${args.id} 的交易对象` : `看不见 ${args.who}`);
    const others = (exclude: number) => seen.filter((e) => e.id !== exclude).slice(0, 4).map((e) => `id=${e.id} ${e.name}${e.traits ? `（${e.traits}）` : ''} ${Math.round(e.dist)}格`).join('；');
    let target = seen[0];
    let who = `${target.name}${target.traits ? `（${target.traits}）` : ''}`;
    try {
      let r = await adapter.tradeWith(target.id, args.index, args.times, signal);
      // 只看交易表时，这位打不开交易界面就问问旁边下一位（给了 index 的交易表是那一位的，不换人）
      for (const next of seen.slice(1, 3)) {
        if (r.ok || args.index !== null || args.id !== undefined || !/NO_TRADE_WINDOW/.test(String(r.reason))) break;
        target = next; who = `${target.name}${target.traits ? `（${target.traits}）` : ''}`;
        r = await adapter.tradeWith(target.id, args.index, args.times, signal);
      }
      const list = r.trades.length ? `交易表：${showTrades(r.trades)}` : '';
      if (!r.ok) {
        const code = r.reason?.startsWith('NOT_ENOUGH') ? 'MISSING_MATERIALS' : r.reason === 'TARGET_GONE' ? 'TARGET_GONE' : 'ERROR';
        const alt = others(target.id);
        return fail(code, `和 ${who}（id=${target.id}）交易没成：${r.reason}。${list}${alt ? `${list ? '；' : ''}旁边还有：${alt}（trade {"id":…} 指定哪一位）` : ''}`, { trades: r.trades, villager: target.id });
      }
      if (args.index === null) return ok(`${who}（id=${target.id}）的${list || '交易表是空的'}；要按某条交易写 trade {"id":${target.id},"index":n}`, { trades: r.trades, villager: target.id });
      return ok(`和 ${who}（id=${target.id}）按 #${args.index} 交易了 ${r.traded} 次。${list}`, { trades: r.trades, traded: r.traded, villager: target.id });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `交易出错：${(e as Error).message}`);
    }
  },
};

export const guiSkills = [useGui, trade];
