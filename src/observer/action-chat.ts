import type { GameAdapter } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import { ExpressionProjection, type ExpressionContext } from './expression.ts';

const EXPRESSION_EVENTS = new Set(['plan', 'task_start', 'task_end', 'attempt_end', 'intent_decision', 'discovery', 'item_new',
  'paused', 'disconnected', 'death', 'shutdown', 'plan_fallback', 'spawn']);

/** Brief character thoughts for game chat and replay; never owns gameplay controls. */
export class ActionChat {
  private projection = new ExpressionProjection();
  private lastSentAt = -Infinity;
  private lastSnapshot = '';
  private timer: NodeJS.Timeout | null = null;
  private listening = false;
  private listener = (event: AgentEvent) => this.observe(event);

  constructor(private adapter: Pick<GameAdapter, 'state' | 'chat'>, private bus: EventBus,
    private options: { enabled: boolean; minIntervalMs?: number; canSend?: () => boolean;
      context?: () => Omit<ExpressionContext, 'state' | 'allowed'> }) {}

  start() {
    if (this.listening) return;
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
    this.projection.clear();
    this.publishSnapshot();
  }

  private context(): ExpressionContext { return { ...this.options.context?.(), state: this.adapter.state(), allowed: this.options.canSend?.() !== false }; }
  snapshot() { return this.projection.snapshot(this.context()); }
  private publishSnapshot() {
    const snapshot = this.snapshot(), key = JSON.stringify(snapshot);
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    this.bus.publish('expression_changed', 'P3', '公开表达状态已更新', { ...snapshot });
  }
  private observe(event: AgentEvent) {
    if (!EXPRESSION_EVENTS.has(event.type)) return;
    this.projection.observe(event, this.context());
    this.flush();
  }

  flush() {
    this.publishSnapshot();
    const item = this.projection.pendingSpeech(this.context());
    if (!this.options.enabled || !item || Date.now() - this.lastSentAt < Math.max(1000, this.options.minIntervalMs ?? 1800)) return;
    try {
      this.adapter.chat(`[想法] ${item.thought}`.slice(0, 180));
      this.lastSentAt = Date.now(); this.projection.markSent(item.taskId);
      this.bus.publish('expression_submitted', 'P3', '已提交当前动作的公开想法', {
        planId: item.planId, taskId: item.taskId, thought: item.thought, scope: this.snapshot().scope, delivery: 'unconfirmed',
      });
    } catch { this.projection.markSent(item.taskId); } // transport failure must not stop physical control
  }
}
