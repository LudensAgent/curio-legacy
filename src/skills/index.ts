import { defend, flee } from './combat.ts';
import { explore, followPassage, goTo, lookAround, surface, unstuck, wander } from './movement.ts';
import { build, buildingArchive, sleepSkill } from './build.ts';
import { placeTorch } from './light.ts';
import { collectFurnace, collectSeeds, expedition, farm, findItem, smelt, storeItems, takeItems } from './economy.ts';
import { hunt, pickupItems, shelter } from './survival.ts';
import type { Skill } from './types.ts';
import { craft, eat, gather } from './work.ts';
import { mergeTools } from './merge.ts';
import { travelSkills } from './travel.ts';
import { overlandSkills } from './overland.ts';
import { equipmentSkills } from './equipment.ts';
import { buildingReview } from './building-review.ts';
import { dragonSkills } from './dragon.ts';
import { structureSkills } from './structures.ts';
import { reservationSkills } from './reservations.ts';
import { baseSkills } from './bases.ts';
import { actionSkills } from './actions.ts';
import { handSkills } from './hands.ts';
import { guiSkills } from './gui.ts';
import { bodySkills } from './body.ts';
import { primitiveSkills } from './primitives.ts';
import { fish } from './fishing.ts';
import { glance, wait } from './wait.ts';
import { forage } from './forage.ts';
import { inspectBlock, rememberPlace } from './observation.ts';
import { interactBlock } from './block-interaction.ts';
import { descend } from './descent.ts';
import { assessLandings } from './landing.ts';
import { flightSkills } from './elytra.ts';
import { useSkill } from './use-skill.ts';
import { editBook, signText } from './text.ts';
import { isSkillDisabled } from './disabled.ts';

/** 技能白名单：LLM 只能从这里选择技能，参数必须通过各自的 validate。 */
export const SKILLS: Record<string, Skill> = Object.fromEntries(
  [explore, gather, goTo, followPassage, craft, mergeTools, eat, hunt, pickupItems, shelter, build, buildingArchive, buildingReview, sleepSkill, placeTorch, smelt, collectFurnace, storeItems, takeItems, findItem, collectSeeds, farm, expedition, flee, defend, wander, lookAround, unstuck, surface, ...Object.values(travelSkills), ...Object.values(equipmentSkills), ...Object.values(dragonSkills), ...Object.values(structureSkills), ...reservationSkills, ...baseSkills, ...actionSkills, ...handSkills, ...guiSkills, ...bodySkills, ...primitiveSkills, ...overlandSkills, fish, wait, glance, forage, inspectBlock, rememberPlace, interactBlock, assessLandings, descend, ...Object.values(flightSkills), useSkill, signText, editBook].map((s) => [s.name, s]),
);

/** 只给反射层/填充行为使用、不让 LLM 主动规划的技能 */
/** 心智不直接用的：unstuck/glance/wander 是身体等想法时的填充动作 */
export const LLM_HIDDEN = new Set(['unstuck', 'glance', 'wander']);

export function skillCatalog(): string {
  return Object.values(SKILLS)
    .filter((s) => !LLM_HIDDEN.has(s.name) && !isSkillDisabled(s.name))
    .map((s) => `- ${s.name} ${s.argsDoc}：${s.description}`)
    .join('\n');
}
