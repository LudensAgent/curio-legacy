import { codeFromError, clampInt, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { craftReservationConflict } from '../projects/reservations.ts';
import { config } from '../config.ts';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

// ------------------------------------------------------------------ gather
/** 可以“往下挖”找到的地表/地下方块 */
const DIGGABLE_DOWN = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'dirt', 'grass_block', 'coarse_dirt', 'sand', 'gravel', 'clay']);
const UNSAFE_BELOW = new Set(['lava', 'water', 'air', 'cave_air', 'bedrock']);
const WATERY = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column', 'lava']);

export const gather: Skill<{ block: string; count: number }> = {
  name: 'gather',
  description: '前往【看见过或正看见】的指定方块并挖掘、拾取。看不见的不会去挖（没有透视）；stone/dirt/sand 若看不见会就地向下挖。block 可用别名：log(任意原木)、stone、dirt、coal、iron、ore',
  argsDoc: '{"block": "log|stone|coal|iron|<方块名>", "count"?: 1-32}',
  timeoutMs: 180000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const block = String(a.block ?? '').trim();
    if (!block) return { ok: false, error: 'block 不能为空' };
    if (!adapter.resolveBlockNames(block).length) return { ok: false, error: `未知方块：${block}` };
    return { ok: true, args: { block, count: clampInt(a.count, 1, 32, 4) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const names = adapter.resolveBlockNames(args.block);
    const canDigDown = names.some((n) => DIGGABLE_DOWN.has(n));
    const skip = new Set<string>();
    let dug = 0;
    let failsInRow = 0;
    let dugDown = 0;
    ctx.progress(0, `采集 ${args.block} x${args.count}`);
    while (dug < args.count) {
      const s = adapter.state();
      if (!s.connected) return fail('NOT_CONNECTED', '连接断开');
      if (s.emptySlots === 0) {
        return dug > 0 ? ok(`背包已满，采集了 ${dug}/${args.count} 个 ${args.block}`) : fail('INVENTORY_FULL', '背包已满');
      }
      senses.refresh();
      const hits = senses
        .knownBlocks(names, 256)
        .filter((h) => !skip.has(key(h.pos)))
        // 水下（上方是水）的方块不去挖：会憋气溺水
        .filter((h) => !WATERY.has(adapter.blockAt({ x: h.pos.x, y: h.pos.y + 1, z: h.pos.z }) ?? 'air'))
        .sort((a, b) => a.dist + Math.abs(a.pos.y - s.pos.y) * 0.6 - (b.dist + Math.abs(b.pos.y - s.pos.y) * 0.6));

      if (!hits.length) {
        // 看不见目标：石头/泥土类可以就地往下挖（脚下的方块是“踩着的”，不算透视）
        if (canDigDown && dugDown < 8 && !s.inWater) {
          const below = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y) - 1, z: Math.floor(s.pos.z) };
          const under = adapter.blockAt(below);
          const under2 = adapter.blockAt({ ...below, y: below.y - 1 });
          if (under && DIGGABLE_DOWN.has(under) && !UNSAFE_BELOW.has(under2 ?? 'air')) {
            ctx.progress(dug / args.count, `向下挖（${under}）`);
            const r = await adapter.dig(below, signal);
            if (r.ok) {
              dugDown++;
              if (names.includes(under)) {
                dug++;
                ctx.progress(dug / args.count, `采集 ${args.block} ${dug}/${args.count}`);
              }
              await adapter.collectNearbyDrops(signal, 3, 1500);
              continue;
            }
          }
        }
        return dug > 0
          ? ok(`看不到更多 ${args.block}，采集了 ${dug}/${args.count}`)
          : fail('NOT_FOUND', `视野和记忆里都没有 ${args.block}（可以先 look_around 环顾，或 explore 到别处看看）`);
      }
      const target = hits.find((h) => adapter.canHarvest(h.pos));
      if (!target) return fail('TOOL_MISSING', `缺少能采集 ${hits[0].name} 的工具`, { block: hits[0].name });

      try {
        ctx.progress(dug / args.count, `前往 ${target.name}（${Math.round(target.dist)} 格）`);
        await adapter.moveTo({ kind: 'reach_block', pos: target.pos }, { signal, timeoutMs: Math.min(90000, Math.max(3000, ctx.deadline - Date.now())) });
        const t0 = Date.now();
        const r = await adapter.dig(target.pos, signal);
        if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
        ctx.memory.recordDig(target.name, adapter.state().held, Date.now() - t0);
      } catch (e) {
        if (isAbort(e)) throw e;
        skip.add(key(target.pos));
        if (++failsInRow >= 4) {
          return dug > 0 ? ok(`多次失败后停止，采集了 ${dug}/${args.count}`) : fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `无法到达或挖掘 ${args.block}：${(e as Error).message}`);
        }
        continue;
      }
      failsInRow = 0;
      dug++;
      ctx.progress(dug / args.count, `采集 ${args.block} ${dug}/${args.count}`);
      await adapter.collectNearbyDrops(signal, 6, 3000);
    }
    return ok(`采集了 ${dug} 个 ${args.block}`, { dug });
  },
};

// ------------------------------------------------------------------ craft
export const craft: Skill<{ item: string; count: number }> = {
  name: 'craft',
  description: '合成物品。会自动补做两层以内的前置材料（原木→木板→木棍）、自动使用记得的工作台或现做一个放下，所以直接写最终物品即可。常用：wooden_pickaxe、stone_pickaxe、furnace、torch、crafting_table',
  argsDoc: '{"item": "<物品名>", "count"?: 1-64}',
  timeoutMs: 60000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const item = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    if (!adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 1) } };
  },
  async run(ctx, args) {
    try {
      const table = ctx.senses.knownBlocks(['crafting_table'], 32)[0];
      const conflict = craftReservationConflict(ctx.memory, ctx.adapter.state(), args.item, args.count, config.mc.version, !!table);
      if (conflict) return fail('MISSING_MATERIALS', `预留保护：${conflict.reason}`, { conflict });
      const r = await ctx.adapter.craft(args.item, args.count, ctx.signal, { tablePos: table?.pos });
      if (!r.ok) return fail((r.reason as any) ?? 'ERROR', `无法合成 ${args.item}：${r.reason}`);
      return ok(`合成了 ${r.crafted} 个 ${args.item}`, { crafted: r.crafted });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `合成 ${args.item} 出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ eat
export const eat: Skill<{}> = {
  name: 'eat',
  description: '吃背包里最好的食物',
  argsDoc: '{}',
  timeoutMs: 10000,
  movement: false,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    if (!ctx.adapter.hasFood()) return fail('NO_FOOD', '背包里没有可吃的食物');
    try {
      await ctx.adapter.eat(ctx.signal);
      return ok(`进食完成，饥饿值 ${ctx.adapter.state().food}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `进食失败：${(e as Error).message}`);
    }
  },
};
