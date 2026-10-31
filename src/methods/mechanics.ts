import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { isSkillDisabled } from '../skills/disabled.ts';

// These are general operations exposed by the current registry, not recipes
// for situations. Specialized workflows remain searchable as composites.
const PRIMITIVES = ['use_item', 'interact_block', 'interact', 'ride', 'dismount', 'dig', 'dig_at', 'step', 'place_at', 'hit_entity', 'inspect_block', 'craft', 'look', 'look_around', 'goto', 'fly_to', 'pickup_items', 'hold_item', 'inspect_inventory', 'toss_item', 'use_gui', 'sign_text', 'edit_book', 'climb_up', 'assess_landings', 'assess_flight', 'descend', 'eat', 'wait', 'guard'];
const ALIASES: Record<string, string[]> = {
  use_item: ['右键', '使用物品', '放置', '放下', 'right click', 'use item', 'place', 'place block'],
  interact_block: ['空手右键', '方块交互', '开门', '关门', '点击方块', '门', '按钮', '拉杆', 'activate block', 'right click block', 'door', 'button', 'lever'],
  interact: ['交互', '互动', '右键实体', '坐上', '乘坐', '坐船', '上船', '骑马', 'interact', 'mount', 'entity interaction'],
  ride: ['驾驶', '操控载具', '划行', '骑行', '船', '矿车', '马', 'boat', 'minecart', 'horse', 'ride', 'steer', 'drive', 'vehicle control'],
  dismount: ['下船', '下马', '下车', '离开载具', 'dismount', 'unmount', 'get off'],
  dig: ['拆除', '拆下', '挖掘', '挖', '回收方块', '拿起来', 'dig', 'break', 'mine', 'remove block'],
  hit_entity: ['左键实体', '击打', '攻击实体', '打碎实体', '船', '矿车', '盔甲架', 'hit entity', 'attack', 'boat', 'minecart', 'armor stand'],
  inspect_block: ['查看状态', '检查方块', '门', '作物', '属性', 'inspect', 'block state', 'properties', 'door', 'crop'],
  craft: ['合成', '制作', 'craft', 'make', 'recipe'],
  look_around: ['观察', '张望', '寻找', '查看周围', 'look', 'observe', 'search', 'look around'],
  goto: ['移动', '走路', '步行', '前往', 'goto', 'walk', 'move', 'go to'],
  pickup_items: ['拾取', '捡起', '掉落物', 'pickup', 'pick up', 'collect drops'],
  climb_up: ['爬升', '爬高', '垫脚', 'climb', 'pillar up'],
  assess_landings: ['落差', '落点', '高度', '摔伤', '水深', '查看下方', 'landing', 'fall risk', 'drop height'],
  descend: ['下行', '下去', '下落', '跳下', '跳入水', 'descend', 'drop down', 'water landing'],
  assess_flight: ['飞行评估', '评估飞行', '能不能飞', '能否飞行', '飞行前提', '飞行检查', 'assess flight', 'flight check'],
  fly_to: ['飞行', '滑翔', '鞘翅', '飞天', '火箭推进', '烟花推进', '飞到', 'fly', 'glide', 'elytra'],
  eat: ['吃', '进食', 'eat', 'food'],
  wait: ['等待', '等候', 'wait', 'pause'],
  guard: ['举盾', '格挡', '挡箭', '挡住', '盾', '盾牌', '防御', 'shield', 'block', 'guard', 'parry'],
};
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'with', 'how', 'can', 'please', 'i']);

export interface MechanicEntry {
  primitive: string;
  kind: 'primitive' | 'composite';
  /** Exact registered argument documentation; this is not a generated schema. */
  parameters: string;
  effect: string;
  movement: boolean;
  readOnly: boolean;
  source: 'registered_skills';
}

/** Read capabilities on demand without executing, registering or selecting them. */
export function queryMechanics(query: string, limit = 6) {
  const text = String(query ?? '').trim().slice(0, 300), normalized = normalize(text);
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 6;
  const terms = [...new Set([
    ...(normalized.match(/[a-z0-9]+/g) ?? []).filter((word) => !STOP_WORDS.has(word)),
    ...(normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((word) => word.length === 1 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))),
  ])];
  const candidates = Object.values(SKILLS).filter((skill) => !LLM_HIDDEN.has(skill.name) && !isSkillDisabled(skill.name)).map((skill) => {
    const order = PRIMITIVES.indexOf(skill.name), primitive = order >= 0;
    if (!normalized) return { skill, primitive, order, score: primitive ? 1 : 0 };
    const name = normalize(skill.name), args = normalize(skill.argsDoc), description = normalize(skill.description);
    const aliases = (ALIASES[skill.name] ?? []).map(normalize);
    let score = name === normalized ? 1000 : name.includes(normalized) ? 200 : 0;
    for (const term of terms) {
      if (name.includes(term)) score += 18;
      if (args.includes(term)) score += 5;
      if (description.includes(term)) score += 3;
    }
    for (const alias of aliases) {
      if (alias === normalized) score += 100;
      else if (normalized.includes(alias)) score += 15 + alias.length;
      else if (terms.some((term) => alias.includes(term))) score += 5;
    }
    return { skill, primitive, order, score };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.primitive) - Number(a.primitive) || (a.primitive && b.primitive ? a.order - b.order : a.skill.name.localeCompare(b.skill.name)));
  const mechanics: MechanicEntry[] = candidates.slice(0, cap).map(({ skill, primitive }) => ({
    primitive: skill.name, kind: primitive ? 'primitive' : 'composite', parameters: skill.argsDoc, effect: skill.description,
    movement: skill.movement, readOnly: skill.readOnly === true, source: 'registered_skills',
  }));
  return {
    source: 'registered_skills' as const, query: text, mechanics, totalMatches: candidates.length, hasMore: candidates.length > mechanics.length,
    ...(!normalized ? { catalog: candidates.map(({ skill }) => skill.name) } : {}),
  };
}
