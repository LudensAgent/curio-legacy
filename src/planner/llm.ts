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

export interface LlmProvider {
  readonly name: string;
  complete(messages: ChatMessage[], signal: AbortSignal, hint?: unknown): Promise<Completion>;
}

/** 任何 OpenAI 兼容的 /chat/completions 接口：OpenAI、DeepSeek、通义、智谱、Ollama、LM Studio、vLLM… */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  constructor(private cfg: Omit<Config['llm'], 'maxPromptTokens' | 'maxRecallRounds' | 'visionInput' | 'contextWindowTokens' | 'compactAtRatio'>) {
    this.name = `openai-compatible:${cfg.model}`;
  }

  async complete(messages: ChatMessage[], signal: AbortSignal): Promise<Completion> {
    const t0 = Date.now();
    if (this.cfg.fakeDelayMs > 0) await sleep(this.cfg.fakeDelayMs, signal);
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: apiMessages(messages),
      temperature: this.cfg.temperature,
      // 推理型模型（如 deepseek-flash）会把思考过程也算进 max_tokens，太小会导致正文为空或被截断
      max_tokens: this.cfg.maxTokens,
    };
    if (this.cfg.jsonMode) body.response_format = { type: 'json_object' };
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
}

/**
 * Mock：不需要 API Key。用规则生成计划并模拟 1.5–4 秒的思考延迟，
 * 走与真实模型完全相同的解析/校验/执行链路，用来先验证整套系统。
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  constructor(private fakeDelayMs: number, private propose: (hint: unknown) => Record<string, unknown>, private baseDelay = [1500, 4000]) {}

  async complete(_messages: ChatMessage[], signal: AbortSignal, hint?: unknown): Promise<Completion> {
    const t0 = Date.now();
    const [lo, hi] = this.baseDelay;
    await sleep(lo + Math.random() * (hi - lo) + this.fakeDelayMs, signal);
    return { text: JSON.stringify(this.propose(hint)), latencyMs: Date.now() - t0 };
  }
}
