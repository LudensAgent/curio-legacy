import { excavationSkill, type ExcavationArgs } from '../excavation.ts';
import { obj, type Skill } from '../types.ts';

/**
 * L2 有界开挖执行器：执行 Agent 已选的方向/模式/步数/工具/填充/风险计划。
 * 不是旧 excavate_path 的兼容别名；入口不再需要，也不负责选择入口或保证覆盖地下。
 */
export const excavateRun: Skill<ExcavationArgs> = {
  ...excavationSkill,
  name: 'excavate_run',
  description: '执行一条已选定的有界开挖计划：从当前实际站位沿指定方向、模式（stairs/stairs_up/tunnel）和步数推进，逐格确认工具、支撑、净空、液体、下落方块和真实落地。遇到风险默认停下并返回具体格；只有显式 wet/lava/allowFalling 才继续。缺支撑可显式 fill，补不上就在挖前停下。只报告实际路径，不保证覆盖地下或找到结构。',
  argsDoc: '{"mode"?:"stairs|stairs_up|tunnel","direction":"north|east|south|west","steps"?:1-8,"tool"?:"物品注册名","fill"?:"<方块名>|any","wet"?:true,"lava"?:true,"allowFalling"?:true}；从当前站位开始，不接受 entry；风险授权分别生效，不写则在风险前停下；邻格未加载只跳过、不阻断。',
  validate(raw, adapter) {
    const a = obj(raw);
    if (a.entry !== undefined) return { ok: false, error: 'excavate_run 从当前站位开始，不接受 entry；需要从某个入口开挖请先走到那里' };
    return excavationSkill.validate({ ...a, entry: 'current' }, adapter);
  },
  run(ctx, args) {
    return excavationSkill.run(ctx, { ...args, entry: 'current' });
  },
};
