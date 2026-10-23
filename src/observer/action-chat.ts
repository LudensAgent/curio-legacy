import type { GameAdapter } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';

const labels: Record<string, string> = {
  gather: '采集', craft: '合成', build: '施工', goto: '前往', explore: '探索', look_around: '观察周围',
  hunt: '狩猎', eat: '进食', sleep: '睡觉', flee: '撤离', defend: '防御', smelt: '冶炼',
  store_items: '存放物品', take_items: '取出物品', farm: '照料农田', building_review: '观察建筑',
  build_portal: '建造传送门', travel_portal: '穿越传送门', recall_portal: '沿记录返程',
  find_stronghold: '追踪末影之眼', dragon_fight: '末影龙战斗', use_end_gateway: '穿越末地折跃门',
};

/** Game-chat captions for server-side replay. Observational only; never owns gameplay controls. */
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
    let text = '';
    if (event.type === 'task_start' && typeof data.skill === 'string') {
      const args = (data.args ?? {}) as Record<string, unknown>;
      const subject = args.block ?? args.item ?? args.target ?? args.blueprint ?? args.crop ?? args.animal ?? '';
      const amount = typeof args.count === 'number' ? ` ×${args.count}` : '';
      text = `[行动] 开始${labels[data.skill] ?? data.skill}${subject ? `：${subject}` : ''}${amount}`;
    } else if (event.type === 'task_end') {
      // Preserve partial success and failures verbatim; never infer physical goal completion.
      const summary = typeof data.summary === 'string' ? data.summary : event.msg.replace(/^\[[^\]]+\]\s*/, '');
      text = `[行动] ${data.status === 'failed' ? '失败' : data.status === 'cancelled' ? '中断' : '结束'}：${summary}`;
    }
    text = text.replace(/§./g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 180);
    if (!text || text === this.lastText && Date.now() - this.lastSentAt < 10000 || this.queue.at(-1)?.text === text) return;
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
