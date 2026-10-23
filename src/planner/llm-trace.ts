import { EventEmitter } from 'node:events';
import type { ChatMessage } from './llm.ts';

/**
 * LLM 调用追踪：控制台用它实时显示“发出去的提示词”和“流式返回的内容”。
 * 不走 EventBus，避免把逐字增量写进事件日志。
 *
 * 事件（'llm'）：
 *  { kind: 'request', call }                 新调用（含完整 messages）
 *  { kind: 'delta', id, content, reasoning } 增量（约每 120ms 合并一次）
 *  { kind: 'done', id, ...结果 }              结束
 */
export interface LlmCallRecord {
  id: string;
  ts: number;
  reason: string;
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

const MAX_CALLS = 20;
const FLUSH_MS = 120;

export class LlmTrace extends EventEmitter {
  private calls: LlmCallRecord[] = [];
  private pending = new Map<string, { content: string; reasoning: string }>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  begin(meta: { reason: string; attempt: number; provider: string }, messages: ChatMessage[]): string {
    const id = `llm_${Date.now().toString(36)}_${++this.seq}`;
    const call: LlmCallRecord = { id, ts: Date.now(), ...meta, messages: messages.map((m) => ({ ...m })), reasoning: '', content: '', status: 'streaming' };
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
