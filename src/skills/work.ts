import { codeFromError, clampInt, fail, isAbort, obj, ok, type Skill } from './types.ts';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

// ------------------------------------------------------------------ gather
export const gather: Skill<{ block: string; count: number }> = {
  name: 'gather',
  description: '寻找并挖掘指定方块，拾取掉落物。block 可用别名：log(任意原木)、stone、dirt、coal、iron、ore 等',
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
    const { adapter, signal } = ctx;
    const names = adapter.resolveBlockNames(args.block);
    const skip = new Set<string>();
    let dug = 0;
    let failsInRow = 0;
    ctx.progress(0, `采集 ${args.block} x${args.count}`);
    while (dug < args.count) {
      const s = adapter.state();
      if (!s.connected) return fail('NOT_CONNECTED', '连接断开');
      if (s.emptySlots === 0) {
        return dug > 0 ? ok(`背包已满，采集了 ${dug}/${args.count} 个 ${args.block}`) : fail('INVENTORY_FULL', '背包已满');
      }
      const hits = adapter
        .findBlocks(names, 48, 64)
        .filter((h) => !skip.has(key(h.pos)))
        .sort((a, b) => a.dist + Math.abs(a.pos.y - s.pos.y) * 0.6 - (b.dist + Math.abs(b.pos.y - s.pos.y) * 0.6));
      if (!hits.length) {
        return dug > 0 ? ok(`附近没有更多 ${args.block}，采集了 ${dug}/${args.count}`) : fail('NOT_FOUND', `48 格内没有找到 ${args.block}`);
      }
      const target = hits.find((h) => adapter.canHarvest(h.pos));
      if (!target) return fail('TOOL_MISSING', `缺少能采集 ${hits[0].name} 的工具`, { block: hits[0].name });

      try {
        await adapter.moveTo({ kind: 'reach_block', pos: target.pos }, { signal, timeoutMs: Math.min(30000, Math.max(3000, ctx.deadline - Date.now())) });
        const r = await adapter.dig(target.pos, signal);
        if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
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
  description: '合成物品（需要工作台的配方会自动寻找或放置背包里的工作台）。常用：oak_planks、stick、crafting_table、wooden_pickaxe、stone_pickaxe、furnace、torch',
  argsDoc: '{"item": "<物品名>", "count"?: 1-16}',
  timeoutMs: 60000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const item = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    if (!adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 16, 1) } };
  },
  async run(ctx, args) {
    try {
      const r = await ctx.adapter.craft(args.item, args.count, ctx.signal);
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
