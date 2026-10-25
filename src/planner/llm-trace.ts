import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { day } from '../log.ts';
import type { ChatMessage } from './llm.ts';

/**
 * LLM 调用追踪：控制台用它实时显示“发出去的提示词”和“流式返回的内容”。
 * 不走 EventBus，避免把逐字增量写进事件日志。
 *
 * 事件（'llm'）：
 *  { kind: 'request', call }                 新调用（含完整 messages）
 *  { kind: 'delta', id, content, reasoning } 增量（约每 120ms 合并一次）
 *  { kind: 'done', id, ...结果 }              结束
 *
 * 给了 dir 就把每次调用结束时的完整记录（提示词、思考过程、完整回复、用量）按天追加写进
 * dir/llm-calls-YYYYMMDD.jsonl，留作以后分析和优化提示词的材料；启动时读回最近几条，控制台重启后还看得到。
 */
/** 调用分类：按发起调用的模块（label 前缀）认，控制台据此分组和筛选 */
export type LlmCategory = 'think' | 'glance' | 'reflect' | 'architect' | 'forge' | 'improve' | 'curate' | 'other';
export function llmCategory(label: string): LlmCategory {
  if (label === 'mind:回想') return 'reflect';
  if (label.startsWith('mind:')) return label.endsWith('·瞥一眼') ? 'glance' : 'think';
  if (label === 'architect') return 'architect';
  if (label.startsWith('skill:总结')) return 'forge';
  if (label.startsWith('skill:改进')) return 'improve';
  if (label.startsWith('skill:整理')) return 'curate';
  return 'other';
}

export interface LlmCallRecord {
  id: string;
  ts: number;
  reason: string;
  category: LlmCategory;
  attempt: number;
  provider: string;
  messages: ChatMessage[];
  reasoning: string;
  content: string;
  status: 'streaming' | 'ok' | 'invalid' | 'error';
  latencyMs?: number;
  firstTokenMs?: number;
  usage?: unknown;
  finishReason?: string;
  error?: string;
}

const MAX_CALLS = 40;
const FLUSH_MS = 120;

export class LlmTrace extends EventEmitter {
  private calls: LlmCallRecord[] = [];
  private pending = new Map<string, { content: string; reasoning: string }>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private dir: string | null;

  constructor(opts: { dir?: string | null } = {}) {
    super();
    this.dir = opts.dir ?? null;
    if (this.dir) {
      try { fs.mkdirSync(this.dir, { recursive: true }); this.calls = LlmTrace.load(this.dir, MAX_CALLS); } catch { /* 读不到历史就从空的开始 */ }
    }
  }

  /** 从存档里读回最近 n 条（最新的几天里找） */
  static load(dir: string, n: number): LlmCallRecord[] {
    const files = fs.readdirSync(dir).filter((f) => /^llm-calls-\d{8}\.jsonl$/.test(f)).sort().reverse();
    const out: LlmCallRecord[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) { try { out.push(JSON.parse(lines[i])); } catch { /* 坏行跳过 */ } }
      if (out.length >= n) break;
    }
    return out.reverse();
  }

  private persist(call: LlmCallRecord) {
    if (!this.dir) return;
    try { fs.appendFileSync(path.join(this.dir, `llm-calls-${day()}.jsonl`), JSON.stringify(call) + '\n'); } catch { /* 写不进去不影响游玩 */ }
  }

  begin(meta: { reason: string; attempt: number; provider: string }, messages: ChatMessage[]): string {
    const id = `llm_${Date.now().toString(36)}_${++this.seq}`;
    const call: LlmCallRecord = { id, ts: Date.now(), ...meta, category: llmCategory(meta.reason), messages: messages.map((m) => ({ ...m })), reasoning: '', content: '', status: 'streaming' };
    this.calls.push(call);
    if (this.calls.length > MAX_CALLS) this.calls.shift();
    this.emit('llm', { kind: 'request', call });
    return id;
  }

  delta(id: string, d: { content?: string; reasoning?: string }) {
    const call = this.calls.find((c) => c.id === id);
    if (!call) return;
    if (!call.firstTokenMs) call.firstTokenMs = Date.now() - call.ts;
    call.content += d.content ?? '';
    call.reasoning += d.reasoning ?? '';
    const p = this.pending.get(id) ?? { content: '', reasoning: '' };
    p.content += d.content ?? '';
    p.reasoning += d.reasoning ?? '';
    this.pending.set(id, p);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  end(id: string, r: { status: LlmCallRecord['status']; text?: string; latencyMs?: number; usage?: unknown; finishReason?: string; error?: string }) {
    this.flush();
    const call = this.calls.find((c) => c.id === id);
    if (!call) return;
    // 非流式提供方（或流式失败后回退）只在结束时给出全文
    if (r.text != null && !call.content) call.content = r.text;
    Object.assign(call, { status: r.status, latencyMs: r.latencyMs, usage: r.usage, finishReason: r.finishReason, error: r.error });
    this.persist(call);
    this.emit('llm', { kind: 'done', id, status: call.status, content: call.content, latencyMs: call.latencyMs, firstTokenMs: call.firstTokenMs, usage: call.usage, finishReason: call.finishReason, error: call.error });
  }

  recent(): LlmCallRecord[] {
    return this.calls;
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [id, p] of this.pending) this.emit('llm', { kind: 'delta', id, ...p });
    this.pending.clear();
  }
}
