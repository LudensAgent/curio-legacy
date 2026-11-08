import { descend } from '../descent.ts';
import type { Skill } from '../types.ts';

/**
 * L2：只执行 Agent 明确选择的单条下落边。
 * 落点仍必须来自当前可见的 assess_landings；这里不复用旧的自动选点策略。
 */
export const descendTo: Skill<{ target: { x: number; y: number; z: number }; allowUnknownCorridor?: boolean }> = {
  ...descend,
  name: 'descend_to',
  description: '执行你明确选择的相邻较低落点；先复核当前可见落点、净空、通道、支撑顶面和生命余量。支持已看清至少两格深的水面。落点/净空已确认但落体通道没全部看清时，可用 allowUnknownCorridor 明确承担这部分未知；不挖不搭不代选路线。',
  argsDoc: '{"target":{"x":数值,"y":数值,"z":数值},"allowUnknownCorridor"?:boolean}；target 必须从 assess_landings 的 options[].target（或 options[].descend.target）原样复制，descend_to 不接受 mode/nearest；水中抵达不代表上岸。',
};
