import type { GameAdapter } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';

/** Brief character thoughts for game chat and replay; never owns gameplay controls. */
export class ActionChat {
  private queue: { text: string; at: number }[] = [];
  private lastSentAt = -Infinity;
  private lastText = '';
  private timer: NodeJS.Timeout | null = null;
  private listening = false;
  private listener = (event: AgentEvent) => this.observe(event);

  constructor(private adapter: Pick<GameAdapter, 'state' | 'chat'>, private bus: EventBus,
    private options: { enabled: boolean; minIntervalMs?: number; canSend?: () => boolean }) {}

  start() {
    if (!this.options.enabled || this.listening) return;
    this.listening = true;
    this.bus.on('event', this.listener);
    this.timer = setInterval(() => this.flush(), 250);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.off('event', this.listener);
    this.listening = false;
    this.queue = [];
  }

  private observe(event: AgentEvent) {
    if (event.type === 'paused' || event.type === 'disconnected' || event.type === 'death') { this.queue = []; return; }
    const data = event.data ?? {};
    if (data.source === 'filler' || event.msg.startsWith('[filler]')) return;
    // Only activated model plans carry a publishable thought; rule/filler text can still describe actions.
    if (event.type !== 'plan' || data.source !== 'llm' || typeof data.thought !== 'string') return;
    const thought = data.thought.replace(/§./g, '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!thought) return;
    const text = `[想法] ${thought}`.slice(0, 180);
    if (text === this.lastText && Date.now() - this.lastSentAt < 10000 || this.queue.at(-1)?.text === text) return;
    // Bounded pending captions: fresh observations matter more than delayed narration.
    if (this.queue.length >= 24) this.queue.shift();
    this.queue.push({ text, at: Date.now() });
    this.flush();
  }

  flush() {
    const state = this.adapter.state();
    if (!state.connected || !state.alive || !state.observationReady || this.options.canSend?.() === false) { this.queue = []; return; }
    this.queue = this.queue.filter((item) => Date.now() - item.at <= 10000);
    if (!this.queue.length || Date.now() - this.lastSentAt < Math.max(1000, this.options.minIntervalMs ?? 1800)) return;
    const item = this.queue.shift()!;
    const delayed = Math.floor((Date.now() - item.at) / 1000);
    const text = delayed >= 3 ? `${item.text.slice(0, 160)}（${delayed}秒前）` : item.text;
    try {
      this.adapter.chat(text);
      this.lastSentAt = Date.now(); this.lastText = text;
    } catch { this.queue = []; } // chat transport failure must not stop physical control
  }
}
