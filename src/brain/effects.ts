import type { AgentEvent, EventBus } from '../events.ts';

/**
 * 做完的事有没有留住：有些动作的效果要持续一阵才算数——把不要的东西扔掉，过一会儿又被自己捡回来，就等于白扔。
 * 动作在结果里声明它的持续效果（data.expect），这里在之后几分钟里盯着；被打破了就说清楚：
 * 是什么效果、之后做过哪些动作、被打破那一刻在做什么。只报事实，怎么避免由心智和技能工程师自己学。
 */
export interface EffectExpect {
  /** 扔掉的这些东西在 forMs 内不该再回到背包 */
  discarded?: string[];
  forMs?: number;
  /** 一句话说这是什么效果（“扔掉了 dirt×32”） */
  what?: string;
  /** 声明这个效果的是谁（默认取 task_end 的动作名；代码技能里套用 toss_item 时，由外层把技能名传进来，好把“被打破”记到这份技能头上） */
  by?: string;
}

interface Claim { item: string; what: string; by: string; at: number; until: number; tasks: string[]; reported: number }

const IDLE = new Set(['glance', 'wait']);

export class EffectWatch {
  private claims: Claim[] = [];
  /** 正在跑的动作（taskId → 动作名）：被打破那一刻在做什么 */
  private running = new Map<string, string>();

  constructor(private bus: EventBus) {
    bus.on('event', (ev: AgentEvent) => { try { this.onEvent(ev); } catch { /* 盯不住不影响游玩 */ } });
  }

  private onEvent(ev: AgentEvent) {
    const d = (ev.data ?? {}) as Record<string, any>;
    const now = ev.ts ?? Date.now();
    this.claims = this.claims.filter((c) => c.until > now);
    if (ev.type === 'task_end' && d.status === 'succeeded' && d.expect) {
      const e = d.expect as EffectExpect;
      for (const item of e.discarded ?? []) {
        this.claims = this.claims.filter((c) => c.item !== item);
        this.claims.push({ item, what: e.what ?? `扔掉了 ${item}`, by: e.by ?? String(d.skill ?? '动作'), at: now, until: now + (e.forMs ?? 180_000), tasks: [], reported: 0 });
      }
    }
    if (ev.type === 'task_end' && d.taskId) this.running.delete(String(d.taskId));
    if (ev.type === 'task_start' && d.skill) {
      const skill = String(d.skill);
      if (d.taskId) this.running.set(String(d.taskId), skill);
      // 明确要拿回来（指名捡、从箱子拿）：改主意了，不算被打破
      const item = d.args && typeof d.args === 'object' ? String((d.args as any).item ?? '') : '';
      if ((skill === 'pickup_items' || skill === 'take_items') && item) { this.claims = this.claims.filter((c) => c.item !== item); return; }
      if (IDLE.has(skill)) return;
      for (const c of this.claims) if (c.tasks.at(-1) !== skill) c.tasks = [...c.tasks, skill].slice(-6);
    }
  }

  /** 身体捡起了一堆掉落物，而且是自己刚扔掉的那一堆 */
  recollected(item: string, count: number, now = Date.now()) {
    const doing = [...this.running.values()].filter((s) => !IDLE.has(s)).at(-1) ?? null;
    const c = this.claims.find((x) => x.item === item && x.until > now);
    if (!c || now - c.reported < 30_000) return;
    c.reported = now;
    const ago = Math.max(1, Math.round((now - c.at) / 1000));
    const after = c.tasks.length ? `之后做过 ${c.tasks.join('、')}` : '之后没做别的动作';
    const how = doing ? `，捡回来时正在 ${doing}` : '，捡回来时没在做动作（多半是走到了掉落物上，玩家走近就会自动捡起）';
    this.bus.publish('effect_broken', 'P2', `${ago} 秒前 ${c.by}「${c.what}」，又捡回来了 ${item}×${count}：${after}${how}`, { item, count, by: c.by, tasks: c.tasks, doing, agoSec: ago });
  }
}
