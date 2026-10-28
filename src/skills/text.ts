import type { BlockObservation, Vec3Like } from '../adapter/types.ts';
import { inspectBlock } from './observation.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

export const signText: Skill<{ target: string | Vec3Like; lines?: string[]; back: boolean }> = {
  name: 'sign_text',
  description: '读取当前可见告示牌正面或背面文字；lines 明确指定四行以内的新文字时打开编辑器并写入，必须收到实际文字才确认成功',
  argsDoc: '{"target":"<告示牌方块名>"|{"x":0,"y":64,"z":0},"lines"?:["第一行","第二行"],"back"?:false}',
  timeoutMs: 25000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw), target = inspectBlock.validate({ target: a.target }, adapter);
    if (!target.ok) return target;
    if (a.lines !== undefined && (!Array.isArray(a.lines) || a.lines.length > 4 || a.lines.some((line: unknown) => typeof line !== 'string' || line.length > 45 || /[\r\n]/.test(line)))) return { ok: false, error: 'lines 最多四行，每行最多45个字符，不能含换行符' };
    if (a.back !== undefined && typeof a.back !== 'boolean') return { ok: false, error: 'back 必须是 boolean' };
    return { ok: true, args: { target: target.args.target, ...(a.lines !== undefined ? { lines: a.lines } : {}), back: a.back === true } };
  },
  async run(ctx, args) {
    if (!ctx.adapter.signText) return fail('ERROR', '适配器没有告示牌文本接口');
    const observed = await inspectBlock.run(ctx, { target: args.target });
    if (observed.status !== 'succeeded') return observed;
    const block = observed.data!.actual as BlockObservation;
    if (!/_sign$/.test(block.name)) return fail('BAD_ARGS', '指定方块不是告示牌');
    try {
      const r = await ctx.adapter.signText(block.pos, ctx.signal, { lines: args.lines, back: args.back });
      if (!r.ok) return fail(codeFromError(r.reason), `告示牌操作未确认：${r.reason}`, { pos: block.pos, lines: r.lines });
      return ok(`${args.lines ? '已确认告示牌文字' : '读到告示牌文字'}（${args.back ? '背面' : '正面'}）：${JSON.stringify(r.lines)}`, { pos: block.pos, lines: r.lines });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `告示牌操作失败：${String(error)}`); }
  },
};

export const editBook: Skill<{ sourceSlot: number; pages: string[]; title?: string }> = {
  name: 'edit_book',
  description: '编辑指定背包源槽的书与笔；pages 替换全书内容，title 省略则保持可编辑，提供 title 会签名成为不可再编辑的成书。读取现有页、标题和作者用 inspect_inventory 的 nbt',
  argsDoc: '{"sourceSlot":9-44,"pages":["第一页","第二页"],"title"?:"签名后的书名（不可撤销）"}',
  timeoutMs: 15000,
  movement: false,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    if (!Number.isInteger(a.sourceSlot) || a.sourceSlot < 9 || a.sourceSlot > 44) return { ok: false, error: 'sourceSlot 必须是 inspect_inventory 看到的9-44背包源槽' };
    if (!Array.isArray(a.pages) || a.pages.length > 100 || a.pages.some((page: unknown) => typeof page !== 'string' || page.length > 1024)) return { ok: false, error: 'pages 最多100页，每页最多1024个字符' };
    if (a.title !== undefined && (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 32)) return { ok: false, error: 'title 需要1-32个字符；省略则不签名' };
    return { ok: true, args: { sourceSlot: a.sourceSlot, pages: a.pages, ...(a.title !== undefined ? { title: a.title } : {}) } };
  },
  async run(ctx, args) {
    if (!ctx.adapter.editBook) return fail('ERROR', '适配器没有书本编辑接口');
    try {
      const r = await ctx.adapter.editBook(args.sourceSlot, args.pages, ctx.signal, args.title);
      return r.ok ? ok(`已确认书本${args.title === undefined ? '编辑' : `签名为「${args.title}」`}，共${args.pages.length}页`, { pages: args.pages.length, signed: args.title !== undefined })
        : fail(codeFromError(r.reason), `书本编辑未确认：${r.reason}`);
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `书本编辑失败：${String(error)}`); }
  },
};
