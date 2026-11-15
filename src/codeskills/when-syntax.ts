import { PREDICATE_KEYS } from '../mind/predicate.ts';

/**
 * 技能 when 条件的固定说明，供造技能与改技能的 system 前缀共用。
 * 键列表直接从校验器导出，避免提示词和实际接受的键各改一份。
 */
export const WHEN_SYNTAX = `when 的键是固定的：${PREDICATE_KEYS.join('、')}（any/all/not 是组合，不是身体感觉）。例：{"in_wall":true}、{"hp_below":8,"hostile":{"name":"skeleton","within":16}}、{"after_failure":{"skill":"sleep"}}；受伤时间写 {"hurt_within":3}（秒，0.5–60），没有 "hurt" 这个键。`;
