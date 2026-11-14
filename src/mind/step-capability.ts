import { SKILLS } from '../skills/index.ts';

/**
 * 步骤能力的事实来源：哪些动作已知不会改变背包、不能把身体带到指定位置、不会实际观察目标。
 * `thinker` 的 done_when 逻辑校验和 `activity` 的当前活动提示共用这一份，避免两套口径。
 * 只列「已知不会」的动作；未知的自学/代码技能一律当作可能，避免误判合法步骤。
 */

/** 不会产生背包物品（采集/制作/拾取类才会）。`take_items` 带 target 时会取出物品，不属于这里。 */
export const NON_PRODUCING_STEPS = new Set([
  'look', 'look_around', 'resolve_target', 'plan_route', 'navigate_to', 'advance', 'move_step', 'press_keys',
  'descend_to', 'assess_landings', 'find_item', 'observe_portal', 'inspect_block', 'wait', 'sleep',
  'eat', 'store_items', 'toss_item', 'place_cell', 'place_support', 'pillar_one', 'swim_path',
  'boat_path', 'travel_portal', 'recall_portal', 'guard', 'spatial_query', 'spatial_extrema',
  'remember_place', 'sign_text', 'edit_book',
]);

/**
 * 不能保证到达任意指定坐标的动作。`craft`/`sleep`/`smelt`/`use_gui`/`interact_block`
 * 会用 reach_block 走到已知工作台、床、熔炉、容器或看得见的方块旁：只保证进入交互距离，
 * 不保证到达 `location_near` 的指定坐标。`gather`/`take_items` 按参数点名方块类型/容器，
 * 可能正好到达指定坐标，留在集合外，避免把合法计划判死；这是保守取舍，不是“它们一定能到”。
 */
export const NO_ARBITRARY_TRAVEL_STEPS = new Set([
  'look', 'look_around', 'resolve_target', 'plan_route', 'assess_landings', 'find_item',
  'observe_portal', 'inspect_block', 'wait', 'sleep', 'eat', 'craft', 'smelt', 'use_gui', 'interact_block',
  'remember_place', 'spatial_query', 'spatial_extrema', 'sign_text', 'edit_book',
]);

/** 只查询/观察、不改变背包也不移动身体的动作；用于当前活动的能力提示。
 *  以 Skill.readOnly 元数据为准；`look` 只转镜头、`observe_portal` 会记录门，二者没有标 readOnly，单独补进来。 */
export const QUERY_ONLY_STEPS = new Set([
  ...Object.values(SKILLS).filter((skill) => skill.readOnly === true).map((skill) => skill.name),
  'look', 'observe_portal',
]);

/** 不会实际观察目标方块/实体的动作；用于 `exploration.find` 的逻辑否定判断。
 *  `approach_visible` 只到已看见/记得的目标，不保证本次看见；`excavate_run` 只按方向开挖，不保证找到结构；
 *  `find_item` 只查容器记录。这些按动作契约保留在集合内，不因为“它可能路过”就放行。 */
export const NON_OBSERVING_STEPS = new Set([
  'move_step', 'navigate_to', 'advance', 'travel_to', 'approach_visible', 'press_keys', 'descend_to', 'excavate_run',
  'pillar_one', 'place_cell', 'place_support', 'craft', 'smelt', 'sleep', 'eat', 'wait', 'store_items',
  'travel_portal', 'recall_portal', 'boat_path', 'swim_path', 'resolve_target', 'plan_route', 'assess_landings',
  'find_item', 'remember_place', 'sign_text', 'edit_book',
]);

