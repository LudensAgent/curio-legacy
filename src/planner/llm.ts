import type { Config } from '../config.ts';
import { describeNetworkError } from '../network-error.ts';
import { sleep } from '../util.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: { url: string; detail?: 'low' | 'high' | 'auto' }[];
}

const apiMessages = (messages: ChatMessage[]) => messages.map((m) => ({ role: m.role, content: m.images?.length
  ? [{ type: 'text', text: m.content }, ...m.images.map((image) => ({ type: 'image_url', image_url: image }))]
  : m.content }));

export interface Completion {
  text: string;
  latencyMs: number;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type OnDelta = (d: { content?: string; reasoning?: string }) => void;

export interface LlmProvider {
  readonly name: string;
  complete(messages: ChatMessage[], signal: AbortSignal, hint?: unknown, onDelta?: OnDelta): Promise<Completion>;
}

/** 任何 OpenAI 兼容的 /chat/completions 接口：OpenAI、DeepSeek、通义、智谱、Ollama、LM Studio、vLLM… */
/** hint.maxTokensScale：1–8 倍 */
const scaleOf = (hint: unknown) => { const n = Number((hint as any)?.maxTokensScale); return Number.isFinite(n) && n > 1 ? Math.min(8, n) : 1; };

/** DNS / 连接层的瞬时故障（如 Clash TUN DNS 间歇失效）：请求根本没到服务端，短暂退避重试通常能成 */
function isTransient(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    const e = cur as { message?: unknown; code?: unknown; syscall?: unknown };
    const msg = String(e?.message ?? '');
    const code = String(e?.code ?? '');
    // getaddrinfo 全家（ENOTFOUND/EAI_AGAIN/…）都是 DNS 瞬时失败
    if (e?.syscall === 'getaddrinfo') return true;
    if (/getaddrinfo\s+(ENOTFOUND|EAI_AGAIN|ENONET|ECONNREFUSED)/.test(msg)) return true;
    if (/^(ENOTFOUND|EAI_AGAIN|ENONET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ECONNABORTED)$/.test(code)) return true;
    if (/^HTTP (429|502|503|504)/.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  constructor(private cfg: Omit<Config['llm'], 'maxPromptTokens' | 'contextWindowTokens' | 'lightThinking' | 'reasoningEffort' | 'price' | 'priceHolidays'> & { lightThinking?: string; reasoningEffort?: string }) {
    this.name = `openai-compatible:${cfg.model}`;
  }

  /** 个别任务（建筑设计）要想得更久：输出上限按 hint.maxTokensScale 放大 */
  private maxTokens(hint: unknown) { const scale = scaleOf(hint); return scale > 1 ? Math.min(65536, Math.round(this.cfg.maxTokens * scale)) : this.cfg.maxTokens; }

  /** 服务端不认识 reasoning_effort 时记住，之后不再发送 */
  private effortParamRejected = false;

  /** 推理力度：hint.reasoningEffort 优先（建筑设计要 high），否则按配置；auto = DeepSeek 认真想用 low（想得短、决定落地快） */
  private effort(hint: unknown): string | null {
    if (this.effortParamRejected || this.noThinking(hint)) return null;
    const want = (hint as any)?.reasoningEffort as string | undefined;
    if (want) return want;
    const mode = this.cfg.reasoningEffort ?? 'auto';
    if (mode === 'off' || mode === 'none') return null;
    if (mode !== 'auto') return mode;
    return /deepseek/i.test(`${this.cfg.model} ${this.cfg.baseUrl}`) ? 'low' : null;
  }

  /** 服务端不认识 thinking 参数时记住，之后不再发送 */
  private thinkingParamRejected = false;

  /** 小决策关闭“先长篇思考”：它占了小决策大部分耗时，想得越久，决定落地时信息越旧。
   *  实测 deepseek-flash：瞥一眼、写代码、建筑设计关思考正确率不降、延迟降 4-7.6 倍；
   *  但「认真想」关思考会想得浅、活的执行质量差（参数/维度错、频繁卡住），故认真想保留 low。
   *  技能总结/生成/改进默认带显式 reasoningEffort（low），不会被这里的放大输出分支关掉。 */
  private noThinking(hint: unknown): boolean {
    if (this.thinkingParamRejected) return false;
    const want = (hint as any)?.reasoningEffort as string | undefined;
    if (want && want !== 'off' && want !== 'none') return false;
    // 认真想（mind 的 full、非放大输出）保留思考；瞥一眼和写代码/建筑（放大输出）关思考
    if ((hint as any)?.tier === 'full' && scaleOf(hint) === 1) return false;
    const mode = (this.cfg as any).lightThinking ?? 'auto';
    if (mode === 'off') return true;
    return mode === 'auto' && /deepseek/i.test(`${this.cfg.model} ${this.cfg.baseUrl}`);
  }

  async complete(messages: ChatMessage[], signal: AbortSignal, hint?: unknown, onDelta?: OnDelta): Promise<Completion> {
    let transient = 0;
    let streamed = false;
    const safeDelta = onDelta ? (d: { content?: string; reasoning?: string }) => { streamed = true; onDelta(d); } : undefined;
    try {
      for (;;) {
        try {
          return await this.completeOnce(messages, signal, hint, safeDelta);
        } catch (e: any) {
          const msg = String(e?.message);
          // 服务端不认识参数（reasoning_effort / thinking）：记住后各重试一次
          if (/^HTTP 4\d\d/.test(msg) && /reasoning_effort/i.test(msg) && this.effort(hint)) { this.effortParamRejected = true; continue; }
          if (this.noThinking(hint) && /^HTTP 4\d\d/.test(msg) && /thinking/i.test(msg)) { this.thinkingParamRejected = true; continue; }
          // DNS / 连接层瞬时故障：请求根本没到服务端，短暂退避重试通常能成。已经 stream 出内容就不再重试（会重复输出）。
          if (isTransient(e) && !streamed && transient < 3 && !signal.aborted) {
            transient++;
            await sleep(Math.min(5000, 500 * 2 ** (transient - 1)), signal);
            continue;
          }
          throw e;
        }
      }
    } catch (error: any) {
      if (signal.aborted || ['AbortError', 'AbortedError', 'TimeoutError'].includes(error?.name)) throw error;
      const message = describeNetworkError(error, [this.cfg.apiKey]);
      if (message === String(error?.message ?? error)) throw error;
      const detailed = new Error(message, { cause: error });
      detailed.name = error?.name ?? 'Error';
      throw detailed;
    }
  }

  private async completeOnce(messages: ChatMessage[], signal: AbortSignal, hint: unknown, onDelta?: OnDelta): Promise<Completion> {
    const t0 = Date.now();
    if (this.cfg.fakeDelayMs > 0) await sleep(this.cfg.fakeDelayMs, signal);
    if (this.cfg.stream && onDelta && !this.streamUnsupported) {
      try {
        return await this.completeStream(messages, signal, onDelta, t0, hint);
      } catch (e: any) {
        // 服务端不支持流式（HTTP 400/404/422）：记住，之后都走普通请求
        if (!/^HTTP (400|404|422)/.test(String(e?.message))) throw e;
        this.streamUnsupported = true;
      }
    }
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: apiMessages(messages),
      temperature: this.cfg.temperature,
      // 推理型模型（如 deepseek-flash）会把思考过程也算进 max_tokens，太小会导致正文为空或被截断
      max_tokens: this.maxTokens(hint),
    };
    if (this.cfg.jsonMode) body.response_format = { type: 'json_object' };
    if (this.noThinking(hint)) body.thinking = { type: 'disabled' };
    const effort = this.effort(hint);
    if (effort) body.reasoning_effort = effort;
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs * scaleOf(hint))]),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const choice = json?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string') throw new Error(`响应中没有 choices[0].message.content：${raw.slice(0, 200)}`);
    return { text, latencyMs: Date.now() - t0, usage: json.usage, finishReason: choice?.finish_reason };
  }

  private streamUnsupported = false;

  private body(messages: ChatMessage[], stream: boolean, hint?: unknown): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.cfg.model, messages: apiMessages(messages), temperature: this.cfg.temperature, max_tokens: this.maxTokens(hint) };
    if (this.cfg.jsonMode) body.response_format = { type: 'json_object' };
    if (this.noThinking(hint)) body.thinking = { type: 'disabled' };
    const effort = this.effort(hint);
    if (effort) body.reasoning_effort = effort;
    if (stream) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
    return body;
  }

  /** SSE 流式：逐块回调 content / reasoning_content（DeepSeek 等推理模型会先输出思考过程） */
  private async completeStream(messages: ChatMessage[], signal: AbortSignal, onDelta: OnDelta, t0: number, hint?: unknown): Promise<Completion> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(this.body(messages, true, hint)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs * scaleOf(hint))]),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let text = '';
    let finishReason: string | undefined;
    let usage: Completion['usage'];
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const content = ch.delta?.content ?? '';
        const reasoning = ch.delta?.reasoning_content ?? ch.delta?.reasoning ?? '';
        if (content || reasoning) {
          text += content;
          onDelta({ content, reasoning });
        }
      }
    }
    return { text, latencyMs: Date.now() - t0, usage, finishReason };
  }
}

/**
 * Mock：不需要 API Key。用规则生成计划并模拟 1.5–4 秒的思考延迟，
 * 走与真实模型完全相同的解析/校验/执行链路，用来先验证整套系统。
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  constructor(private fakeDelayMs: number, private propose: (hint: unknown) => Record<string, unknown>, private baseDelay = [1500, 4000]) {}

  async complete(_messages: ChatMessage[], signal: AbortSignal, hint?: unknown, onDelta?: OnDelta): Promise<Completion> {
    const t0 = Date.now();
    const [lo, hi] = this.baseDelay;
    await sleep(lo + Math.random() * (hi - lo) + this.fakeDelayMs, signal);
    const text = JSON.stringify(this.propose(hint));
    if (onDelta) for (let i = 0; i < text.length; i += 40) onDelta({ content: text.slice(i, i + 40) });
    return { text, latencyMs: Date.now() - t0 };
  }
}
