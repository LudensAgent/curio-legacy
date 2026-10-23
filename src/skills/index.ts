import { defend, flee } from './combat.ts';
import { explore, goTo, lookAround, surface, unstuck, wander } from './movement.ts';
import { build, sleepSkill } from './build.ts';
import { hunt, pickupItems, shelter } from './survival.ts';
import type { Skill } from './types.ts';
import { craft, eat, gather } from './work.ts';

/** 技能白名单：LLM 只能从这里选择技能，参数必须通过各自的 validate。 */
export const SKILLS: Record<string, Skill> = Object.fromEntries(
  [explore, gather, goTo, craft, eat, hunt, pickupItems, shelter, build, sleepSkill, flee, defend, wander, lookAround, unstuck, surface].map((s) => [s.name, s]),
);

/** 只给反射层/填充行为使用、不让 LLM 主动规划的技能 */
export const LLM_HIDDEN = new Set(['unstuck', 'surface']);

export function skillCatalog(): string {
  return Object.values(SKILLS)
    .filter((s) => !LLM_HIDDEN.has(s.name))
    .map((s) => `- ${s.name} ${s.argsDoc}：${s.description}`)
    .join('\n');
}
