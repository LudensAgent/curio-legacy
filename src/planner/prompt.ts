import type { WorldMemory } from '../memory/store.ts';
import type { ChatMessage } from './llm.ts';

export interface MySkillInfo {
  /** 调用时用的技能名（trial:x:v1 / method:x / macro:x） */
  name: string;
  status: 'candidate' | 'verified' | 'macro';
  description: string;
  trials?: { verified: number; failed: number };
  /** 宏的历史成功率（skillStats） */
  success?: string;
}

/** exploredAround 的“没去过”档位：提示词按同一常量和标签筛选，避免字面量漂移。 */
export const UNEXPLORED_LABEL = '没去过';
const DIR8: [string, number, number][] = [['N', 0, -1], ['NE', 0.7071, -0.7071], ['E', 1, 0], ['SE', 0.7071, 0.7071], ['S', 0, 1], ['SW', -0.7071, 0.7071], ['W', -1, 0], ['NW', -0.7071, -0.7071]];
/**
 * 身边八个方向 128 格内去过多少（来自走过的区块记录）：让模型知道哪边已经搜过、哪边还是新地方，
 * 不再朝已经找过的方向来回走。粗分三档，免得每走几步就变、打碎提示词缓存。
 */
export function exploredAround(memory: WorldMemory, dim: string, pos: [number, number, number]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [d, dx, dz] of DIR8) {
    let seen = 0, n = 0;
    for (let r = 32; r <= 128; r += 16) { n++; if (memory.chunkVisits(dim, pos[0] + dx * r, pos[2] + dz * r) > 0) seen++; }
    out[d] = seen / n >= 0.6 ? '大多去过' : seen / n >= 0.25 ? '去过一些' : UNEXPLORED_LABEL;
  }
  return out;
}

export function boundedJson(value: unknown, maxBytes: number): string {
  if (maxBytes <= 0) return '[]';
  if (!Array.isArray(value)) {
    const json = JSON.stringify(value);
    return json && Buffer.byteLength(json, 'utf8') <= maxBytes ? json : '[]';
  }
  // Encode each record once; repeated whole-history serialization stalls physics ticks.
  const rows: string[] = [];
  let bytes = 2;
  for (const entry of value) {
    const json = JSON.stringify(entry) ?? 'null';
    const next = Buffer.byteLength(json, 'utf8') + (rows.length ? 1 : 0);
    if (bytes + next > maxBytes) break;
    rows.push(json); bytes += next;
  }
  return `[${rows.join(',')}]`;
}

/** 粗略估 token：中文按 1 字 1 token，其余按约 4 字符 1 token。比纯字节数更贴近真实（中文 1 字 3 字节，纯字节会把预算提前约 3 倍触发）。 */
function estimateTokens(s: string): number {
  let cjk = 0, other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0x3000 && code <= 0x303F)
      || (code >= 0x3040 && code <= 0x30FF) || (code >= 0xFF00 && code <= 0xFFEF)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

export const promptCost = (messages: ChatMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m.content) + (m.images?.length ?? 0) * 1024, 0)
  + messages.length * 8;

/** Conservative token estimate across model tokenizers, including Chinese and tool/retry turns. */
export function enforcePromptBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (!Number.isFinite(maxTokens) || maxTokens < 1024) throw new Error('PROMPT_BUDGET_INVALID');
  // Preserve the newest query/result or validation feedback as a complete exchange.
  while (messages.length > 4 && promptCost(messages) > maxTokens) {
    const count = messages[2].role === 'assistant' && messages[3]?.role === 'user' ? 2 : 1;
    messages.splice(2, count);
  }
  if (promptCost(messages) > maxTokens) for (const message of messages) delete message.images;
  if (promptCost(messages) > maxTokens) throw new Error(`PROMPT_BUDGET_EXCEEDED: ${promptCost(messages)}/${maxTokens}`);
  return messages;
}
