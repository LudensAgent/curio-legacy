import { EXCAVATION_MAX_STEPS, EXCAVATION_ROUTE_NOTE, excavationSkill, type ExcavationArgs } from '../excavation.ts';
import { obj, type Skill } from '../types.ts';

/**
 * L2 有界开挖执行器：执行 Agent 已选的方向/模式/步数/工具/填充/风险计划。
 * 不是旧 excavate_path 的兼容别名；入口不再需要，也不负责选择入口或保证覆盖地下。
 */
export const excavateRun: Skill<Omit<ExcavationArgs, 'entry'>> = {
  ...excavationSkill,
  name: 'excavate_run',
  description: `执行已选定的有界开挖计划：从当前站位沿指定方向、模式（stairs/stairs_up/tunnel）和步数推进，逐格确认能否挖开、支撑、净空、液体、落块和落地。遇风险默认停下并返回具体格；只有显式 wet/lava/allowFalling 才继续。缺支撑可显式 fill，补不上就在挖前停。只报告实际路径，不保证覆盖或找到结构。${EXCAVATION_ROUTE_NOTE}`,
  catalog: `{"mode"?:"stairs|stairs_up|tunnel","direction":"north|east|south|west","steps"?:1-${EXCAVATION_MAX_STEPS},"tool"?:"物品名","fill"?:"方块名|any","wet"?:true,"lava"?:true,"allowFalling"?:true,"requireTool"?:true}：施工：从当前站位朝一个方向直线挖下行阶梯/上行阶梯/平巷，逐格挖开并确认；不绕路、不走现成的路；遇液体、落块、悬空默认停下`,
  argsDoc: '{"mode"?:"stairs|stairs_up|tunnel","direction":"north|east|south|west","steps"?:1-' + EXCAVATION_MAX_STEPS + ',"tool"?:"物品注册名","fill"?:"<方块名>|any","wet"?:true,"lava"?:true,"allowFalling"?:true,"requireTool"?:true}；从当前站位开始，不接受 entry；tool 不在背包才报 TOOL_MISSING，不掉落也照挖并报 noDrop；requireTool:true 时，需要工具才能采集的方块没有可用工具就停在该格并回报（泥土/沙/原木这类空手可采集的照旧），不空手慢挖；风险授权分别生效，不写则风险前停；邻格未加载只跳过、不阻断。',
  validate(raw, adapter) {
    const a = obj(raw);
    if (a.entry !== undefined) return { ok: false, error: 'excavate_run 从当前站位开始，不接受 entry；需要从某个入口开挖请先走到那里' };
    const v = excavationSkill.validate({ ...a, entry: 'current' }, adapter);
    if (!v.ok) return v;
    // entry 是内部引擎的参数（固定为 current）。返回给宿主的规范化参数必须保持 LLM 契约形状：
    // 若把 entry 一起交回，activity step 会带着它被再次校验，而 excavate_run 明确不接受 entry。
    const { entry: _entry, ...args } = v.args;
    return { ok: true, args };
  },
  run(ctx, args) {
    return excavationSkill.run(ctx, { ...args, entry: 'current' });
  },
};
