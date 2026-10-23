import type { Config } from '../config.ts';
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
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  constructor(private cfg: Omit<Config['llm'], 'maxPromptTokens' | 'maxRecallRounds' | 'visionInput' | 'contextWindowTokens' | 'compactAtRatio' | 'lightThinking'> & { lightThinking?: string }) {
    this.name = `openai-compatible:${cfg.model}`;
  }

  /** 服务端不认识 thinking 参数时记住，之后不再发送 */
  private thinkingParamRejected = false;

  /** 小决策关闭“先长篇思考”：它占了小决策大部分耗时，想得越久，决定落地时信息越旧 */
  private noThinking(hint: unknown): boolean {
    if (this.thinkingParamRejected || (hint as any)?.tier !== 'light') return false;
    const mode = (this.cfg as any).lightThinking ?? 'auto';
    if (mode === 'off') return true;
    return mode === 'auto' && /deepseek/i.test(`${this.cfg.model} ${this.cfg.baseUrl}`);
  }

  async complete(messages: ChatMessage[], signal: AbortSignal, hint?: unknown, onDelta?: OnDelta): Promise<Completion> {
    try {
      return await this.completeOnce(messages, signal, hint, onDelta);
    } catch (e: any) {
      if (this.noThinking(hint) && /^HTTP 4\d\d/.test(String(e?.message)) && /thinking/i.test(String(e?.message))) {
        this.thinkingParamRejected = true;
        return this.completeOnce(messages, signal, hint, onDelta);
      }
      throw e;
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
      max_tokens: this.cfg.maxTokens,
    };
    if (this.cfg.jsonMode) body.response_format = { type: 'json_object' };
    if (this.noThinking(hint)) body.thinking = { type: 'disabled' };
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs)]),
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
    const body: Record<string, unknown> = { model: this.cfg.model, messages: apiMessages(messages), temperature: this.cfg.temperature, max_tokens: this.cfg.maxTokens };
    if (this.cfg.jsonMode) body.response_format = { type: 'json_object' };
    if (this.noThinking(hint)) body.thinking = { type: 'disabled' };
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs)]),
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
