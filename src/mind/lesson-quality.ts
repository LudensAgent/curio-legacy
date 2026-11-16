import type { KnowHow } from './types.ts';

/** 这些是“选哪个动作/工具”的规则；天气、掉落、结构生成之类的客观事实不在这个范围。 */
const METHOD_SKILL = /(?:travel_to|explore_toward|navigate_to|advance|excavate_run|mine_cell|place_cell|place_support|pillar_one|move_step|descend_to|approach_visible|go_near|swim_path)/;
/** 只有出现明确的选择/禁令词，才算在指定做法；单纯提到动作名不算。 */
const CHOICE = /(?:别用|不要用|不要再|别再|改用|改让|换成|优先|直接用|只用|必须用|长段用|短段用|用[^，。；]{0,12}(?:代替|替代))/;

/** 程序补的适用边界：不是 Agent 写的结论，只说明这条规则还没有确认应用证据。 */
export const PROVISIONAL_METHOD_LIMIT = '程序标注：这条方法选择规则还没有确认应用证据，只作暂定假设；采用前先按当前地形、授权、工具和材料验证。';

export const isMethodChoiceRule = (text: string): boolean => METHOD_SKILL.test(text) && CHOICE.test(text);

type Application = NonNullable<KnowHow['applications']>[number];
type LessonEvidence = Pick<KnowHow, 'text' | 'unverified' | 'wins' | 'applications'>;

/** 与提示词里的 applications.done 同一口径：搜索未确认、只在原地/附近的成功都不算确认应用。 */
export const isConfirmedApplication = (application: Application): boolean =>
  application.outcome === 'done' && application.completion !== 'condition' && application.completion !== 'attempt'
  && application.searchUnconfirmed !== true && application.limited !== true;

export const hasConfirmedApplication = (lesson: Pick<KnowHow, 'applications'>): boolean =>
  (lesson.applications ?? []).some(isConfirmedApplication);

/** 合并两条记载的适用边界；去重并保留最近 12 条。 */
export const mergeLessonLimits = (existing: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] =>
  [...new Set([...(existing ?? []), ...(incoming ?? [])])].slice(0, 12);

export type LessonWithLimits = LessonEvidence & Pick<KnowHow, 'limits'>;

/**
 * 没有确认应用证据的方法选择规则：可以留着供主动 recall，但不该自动进入每次决策的 know_how。
 * 只针对“动作/工具选择”，普通的观察事实不压掉；Agent 写了 limits 只说明它更条件化，
 * 仍要等确认应用证据才恢复自动注入。
 */
export const needsProvisionalMethodLimit = (lesson: LessonEvidence): boolean =>
  lesson.unverified === true && lesson.wins === 0 && !hasConfirmedApplication(lesson) && isMethodChoiceRule(lesson.text);

/**
 * 同步程序标注：没有证据时补一条暂定边界；后来有了确认应用就撤掉这条程序标注。
 * Agent 自己写的 limits 不动；撤掉程序标注后若没有别的边界，就把 limits 清空。
 */
export const refreshProvisionalMethodLimit = (lesson: LessonWithLimits): boolean => {
  const agentLimits = (lesson.limits ?? []).filter((limit) => limit !== PROVISIONAL_METHOD_LIMIT);
  const provisional = agentLimits.length !== (lesson.limits?.length ?? 0);
  if (needsProvisionalMethodLimit(lesson)) {
    // Agent 已经写了适用边界：不再补程序标注；已有程序标注就撤掉，免得和 Agent 的条件混在一起。
    if (agentLimits.length > 0) {
      if (!provisional) return false;
      lesson.limits = agentLimits;
      return true;
    }
    if (provisional) return false;
    lesson.limits = [PROVISIONAL_METHOD_LIMIT];
    return true;
  }
  if (!provisional) return false;
  if (agentLimits.length > 0) lesson.limits = agentLimits; else delete lesson.limits;
  return true;
};
