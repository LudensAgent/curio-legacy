import type { BlockObservation, Vec3Like } from '../adapter/types.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { inspectBlock } from './observation.ts';
import { resolveItemAlias } from './work.ts';
import { codeFromError, fail, isAbort, obj, ok, type FailureCode, type Skill } from './types.ts';

/** Generic right-click against a currently observed block, without a gameplay recipe. */
export const interactBlock: Skill<{ target: string | Vec3Like; item?: string }> = {
  name: 'interact_block',
  description: '对当前可见方块空手或持指定物品右键一次；可精确指定已观测坐标，复核距离、遮挡和实际变化，不自动选择玩法',
  argsDoc: '{"target":"<方块名>" | {"x":整数,"y":整数,"z":整数}, "item"?:"<物品名，省略为空手>"}',
  timeoutMs: 25000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw), target = inspectBlock.validate({ target: a.target }, adapter);
    if (!target.ok) return target;
    if (a.item === undefined || a.item === '') return { ok: true, args: target.args };
    const item = typeof a.item === 'string' ? resolveItemAlias(a.item.trim().replace(/^minecraft:/, ''), adapter) : null;
    return item ? { ok: true, args: { ...target.args, item } } : { ok: false, error: 'item 需要实际注册物品名；空手时省略' };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const refused = (code: FailureCode, message: string) => fail(code, message, { effectEvidence: { verified: true, changed: false, reasons: ['没有执行右键'] } });
    if (!adapter.useBlockAt || !senses.observeBlocks) return refused('NOT_FOUND', '当前没有方块交互或可见状态接口，不能凭坐标右键');
    const origin = adapter.state();
    const check = () => {
      throwIfAborted(signal);
      const state = adapter.state();
      if (state.worldId !== origin.worldId || state.dim !== origin.dim || state.sessionId !== origin.sessionId) throw new AbortedError('interaction session changed');
      return state;
    };
    const observe = (positions: Vec3Like[]) => {
      check(); senses.refresh();
      return senses.observeBlocks!(positions).filter((block) => block.source === 'vision' && block.worldId === origin.worldId && block.dimension === origin.dim
        && block.sessionId === origin.sessionId && Math.abs(Date.now() - block.observedAt) <= 2000);
    };
    const distance = (pos: Vec3Like) => dist3(adapter.eye() ?? { ...adapter.state().pos, y: adapter.state().pos.y + 1.62 }, { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
    const key = (block: BlockObservation) => `${block.name}:${JSON.stringify(Object.entries(block.properties).sort(([a], [b]) => a.localeCompare(b)))}`;
    const inventoryKey = () => JSON.stringify(check().inventory.slice().sort((a, b) => a.name.localeCompare(b.name)));
    try {
      check();
      if (args.item && !origin.inventory.some((item) => item.name === args.item && item.count > 0)) return refused('MISSING_MATERIALS', `背包没有 ${args.item}`);
      const names = typeof args.target === 'string' ? [args.target, ...adapter.resolveBlockNames(args.target)] : null;
      const positions = names ? senses.knownBlocks(names, 32).slice(0, 16).map((block) => block.pos) : [args.target as Vec3Like];
      let before = observe(positions).filter((block) => !names || names.includes(block.name)).sort((a, b) => distance(a.pos) - distance(b.pos))[0];
      if (!before) return refused('NOT_FOUND', '目标当前不可见或未加载；坐标和旧记忆不能替代观察');
      const pos = before.pos, expected = before.name;
      if (/^(air|cave_air|void_air)$/.test(expected)) return refused('BAD_ARGS', '目标是空气，不能当作可右键方块');
      if (distance(pos) > 4.4) {
        await adapter.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: Math.max(1, Math.min(12000, ctx.deadline - Date.now() - 4000)), constructionSafe: true, allowSwimming: false });
        await sleep(180, signal);
      }
      check();
      before = observe([pos])[0];
      if (!before || before.name !== expected) return refused('TARGET_GONE', '靠近后目标已改变或被遮挡，未执行右键');
      if (distance(pos) > 4.4) return refused('PATH_NOT_FOUND', '尚未真正走到伸手可及的位置，未执行右键');
      const eye = adapter.eye();
      if (!eye) return refused('NOT_CONNECTED', '当前没有有效视角');
      // A visible object behind transparent glass is not itself clickable.
      const to = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }, length = dist3(eye, to);
      for (let d = 0.1; d < length; d += 0.2) {
        const cell = { x: Math.floor(eye.x + (to.x - eye.x) * d / length), y: Math.floor(eye.y + (to.y - eye.y) * d / length), z: Math.floor(eye.z + (to.z - eye.z) * d / length) };
        if (cell.x === pos.x && cell.y === pos.y && cell.z === pos.z) continue;
        const block = adapter.blockAt(cell);
        if (!block || !/^(air|cave_air|void_air|water|bubble_column|short_grass|grass|tall_grass|fern|large_fern|vine|torch|wall_torch)$/.test(block)) return refused('PATH_NOT_FOUND', '右键路径被方块遮挡或尚未加载，先换个站位');
      }
      const inventory = inventoryKey();
      const result = await adapter.useBlockAt(pos, args.item ?? '', signal);
      check();
      const actual = observe([pos])[0], reasons = [
        ...(actual && key(actual) !== key(before) ? [`${before.name} 在 ${pos.x},${pos.y},${pos.z} 的可见状态改变`] : []),
        ...(inventoryKey() !== inventory ? ['背包物品数量改变'] : []),
        ...(result.effectEvidence?.verified && result.effectEvidence.changed ? result.effectEvidence.reasons : []),
      ];
      const effectEvidence = { verified: reasons.length > 0 || result.effectEvidence?.verified === true, changed: reasons.length > 0, reasons: reasons.length ? [...new Set(reasons)] : [result.reason ?? '没有确认方块、背包或交互窗口的实际变化'] };
      const data = { target: expected, pos, item: args.item ?? null, before, actual: actual ?? null, effectEvidence };
      if (!result.ok) return fail('EFFECT_NOT_CONFIRMED', `对 ${expected} 右键失败：${result.reason}`, data);
      if (!effectEvidence.changed) return fail('EFFECT_NOT_CONFIRMED', `已对 ${expected} 发起右键，但实际效果未确认`, data);
      return ok(`对 ${expected} ${args.item ? `使用 ${args.item}` : '空手右键'}；${effectEvidence.reasons.join('；')}`, data);
    } catch (error) {
      if (isAbort(error)) throw error;
      return fail(codeFromError(error), `方块交互失败：${(error as Error).message}`, { effectEvidence: { verified: false, changed: false, reasons: ['交互异常，效果未知'] } });
    }
  },
};
