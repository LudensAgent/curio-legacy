import { defend, flee } from './combat.ts';
import { explore, goTo, lookAround, surface, unstuck, wander } from './movement.ts';
import { build, buildingArchive, sleepSkill } from './build.ts';
import { placeTorch } from './light.ts';
import { collectSeeds, expedition, farm, smelt, storeItems, takeItems } from './economy.ts';
import { hunt, pickupItems, shelter } from './survival.ts';
import type { Skill } from './types.ts';
import { craft, eat, gather } from './work.ts';
import { travelSkills } from './travel.ts';
import { equipmentSkills } from './equipment.ts';
import { buildingReview } from './building-review.ts';
import { dragonSkills } from './dragon.ts';
import { structureSkills } from './structures.ts';
import { reservationSkills } from './reservations.ts';
import { baseSkills } from './bases.ts';
import { actionSkills } from './actions.ts';

/** 技能白名单：LLM 只能从这里选择技能，参数必须通过各自的 validate。 */
export const SKILLS: Record<string, Skill> = Object.fromEntries(
  [explore, gather, goTo, craft, eat, hunt, pickupItems, shelter, build, buildingArchive, buildingReview, sleepSkill, placeTorch, smelt, storeItems, takeItems, collectSeeds, farm, expedition, flee, defend, wander, lookAround, unstuck, surface, ...Object.values(travelSkills), ...Object.values(equipmentSkills), ...Object.values(dragonSkills), ...Object.values(structureSkills), ...reservationSkills, ...baseSkills, ...actionSkills].map((s) => [s.name, s]),
);

/** 只给反射层/填充行为使用、不让 LLM 主动规划的技能 */
export const LLM_HIDDEN = new Set(['unstuck', 'surface']);

export function skillCatalog(): string {
  return Object.values(SKILLS)
    .filter((s) => !LLM_HIDDEN.has(s.name))
    .map((s) => `- ${s.name} ${s.argsDoc}：${s.description}`)
    .join('\n');
}
