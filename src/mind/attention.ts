import type { AgentEvent } from '../events.ts';
import type { Percept } from '../perception/perception.ts';
import type { ActivityEnd, Noticing } from './types.ts';

export const EXPERIENCE_MS = 10 * 60_000;

/** 显著度阈值：≥0.75 立刻放下手上的事去想；≥0.5 边做边重新想一想；更低的只是“注意到了”，留给下一次思考 */
export const URGENT = 0.75;
export const RECONSIDER = 0.5;

const levelOf = (s: number): Noticing['level'] => s >= URGENT ? 'urgent' : s >= RECONSIDER ? 'reconsider' : 'note';

interface Snapshot { effects: Set<string>; worn: Set<string>; weather: string; phase: string; food: number; hp: number; emptySlots: number; hostiles: Set<string>; resources: Set<string>; light: string | null; inWater: boolean }

/**
 * 注意力：把游戏里发生的事变成“我注意到了…”，并判断值不值得为它停下来重新想。
 * 真人玩家不会对每件事都重新规划：天黑、饿了、背包满了、看见新东西，才会抬头想一想。
 */
export class Attention {
  private pending: Noticing[] = [];
  private seenAt = new Map<string, number>();
  private seenDrops = new Set<number>();
  private last: Snapshot | null = null;
  private loopSeenThrough = 0;

  /** 记一条注意到的事；同一件事在冷却时间内不重复提 */
  notice(key: string, what: string, salience: number, cooldownMs = 60_000, now = Date.now()): Noticing | null {
    const prev = this.seenAt.get(key);
    if (prev !== undefined && now - prev < cooldownMs) return null;
    this.seenAt.set(key, now);
    const n: Noticing = { at: now, key, what: what.slice(0, 120), salience, level: levelOf(salience) };
    this.pending = [...this.pending.filter((p) => p.key !== key), n].slice(-12);
    return n;
  }

  /** 从事件总线里挑出值得注意的事 */
  fromEvent(ev: AgentEvent): Noticing | null {
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'discovery': return this.notice(`disc:${ev.msg}`, ev.msg, 0.42, 120_000);
      case 'item_new': return this.notice(`item:${String(d.item ?? ev.msg)}`, ev.msg, 0.4, 600_000);
      case 'craft_landed': return this.notice(`craft_landed:${String(d.item ?? '')}`, ev.msg, 0.45, 30_000);
      case 'hurt': return this.notice('hurt', ev.msg, 0.45, 15_000);
      case 'reflex': return this.notice(`reflex:${ev.msg.slice(-12)}`, `身体自己反应了：${ev.msg}`, 0.35, 20_000);
      case 'death_items': return this.notice('death_items', ev.msg, 0.7, 60_000);
      case 'process_changed': return this.notice(`process:${JSON.stringify(d.pos ?? ev.msg)}`, ev.msg, 0.55, 5 * 60_000);
      case 'design': return this.notice(`design:${String(d.draftId ?? '')}`, `建筑师把图纸画好了：${ev.msg}`, 0.6, 0);
      case 'skill_hint': return this.notice(`skill_hint:${String(d.skill ?? '')}`, ev.msg, 0.5, 10 * 60_000);
      case 'goal_kept': return this.notice(`goal_kept:${String(d.agendaId ?? '')}`, ev.msg, 0.4, 600_000);
      case 'effect_broken': return this.notice(`effect:${String(d.item ?? '')}`, `刚做完的事又被打破了：${ev.msg}`, 0.55, 60_000);
      case 'design_failed': return this.notice(`design_failed:${ev.msg.slice(0, 20)}`, `建筑师没画成：${ev.msg}`, 0.5, 0);
      case 'chat': {
        // 有人在聊天里说话（不是自己）：值得听一听
        if (/^<([^>]+)>/.test(ev.msg) && !/\[想法\]/.test(ev.msg)) return this.notice(`chat:${ev.msg}`, `有人说：${ev.msg}`, 0.5, 5_000);
        return null;
      }
      case 'skill_loop': return this.notice(`skill_loop:${String(d.a ?? '')}:${String(d.b ?? '')}`, ev.msg, 0.65, 300_000);
      case 'reflex_gaveup': return this.notice('reflex_gaveup', ev.msg, 0.8, 20_000);
      case 'skill_forged': return this.notice(`skill_forged:${String(d.name ?? '')}`, d.candidate ? `${ev.msg}；尚未启用，由我选择时机用 use_skill {name:"${String(d.name ?? '')}",trial:true} 试用` : `${ev.msg}（身体以后会自己这么做）`, 0.4, 0);
      case 'skill_merged': return this.notice(`skill_merged:${String(d.into ?? '')}`, ev.msg, 0.3, 0);
      case 'skill_improved': return this.notice(`skill_improved:${String(d.name ?? '')}`, ev.msg, 0.35, 0);
      case 'skill_promoted': return this.notice(`skill_promoted:${String(d.name ?? '')}`, ev.msg, 0.4, 0);
      case 'skill_rollback': return this.notice(`skill_rollback:${String(d.name ?? '')}`, ev.msg, 0.35, 0);
      case 'skill_disabled': return d.by === 'stats' ? this.notice(`skill_disabled:${String(d.name ?? '')}`, `${ev.msg}：回头改一改（同名重写 skill）`, 0.5, 600_000) : null;
      case 'lesson': return d.source === 'observed' ? this.notice(`lesson:${ev.msg.slice(0, 30)}`, ev.msg, 0.3, 300_000) : null;
      default: return null;
    }
  }

  /** 比较前后两次感知，找出“变化”：天色、饥饿、生命、背包、新出现的怪和资源 */
  fromPercept(p: Percept, now = Date.now(), considerPickup = false): Noticing[] {
    const freshDrops = (p.vision?.visible_drops ?? []).flatMap((drop) => {
      const ids = drop.ids.filter((id) => !this.seenDrops.has(id));
      drop.ids.forEach((id) => this.seenDrops.add(id));
      return ids.length && drop.dist <= 16 ? [{ ...drop, ids }] : [];
    });
    const snap: Snapshot = {
      effects: new Set(p.effects ?? []),
      // 同名的全都快坏了才算“快坏了”：手里那把快坏、背包里还有好的，不是缺工具
      worn: new Set((p.inventory ?? []).filter((i) => i.durability && (i.durabilities?.[0] ?? i.durability.left) / i.durability.max < 0.15).map((i) => i.name)),
      weather: p.time.weather ?? '', phase: p.time.phase, food: p.self.food, hp: p.self.hp, emptySlots: p.emptySlots,
      hostiles: new Set(p.nearby.hostile.filter((h) => h.dist <= 16).map((h) => h.name)),
      resources: new Set(p.nearby.resources.filter((r) => r.seen === 'now').map((r) => r.block)),
      light: p.light?.level ?? null, inWater: p.self.inWater,
    };
    const prev = this.last;
    this.last = snap;
    if (!prev) return [];
    const out: (Noticing | null)[] = [];
    // 时间感：只在昼夜变化时抬头看一眼（天快黑了、天黑了、天亮了）；不报几点，也不报“离天黑/天亮还有多久”
    if (snap.phase !== prev.phase) {
      if (snap.phase === 'dusk') out.push(this.notice('dusk', '太阳在落山，天快黑了', 0.55, 300_000, now));
      else if (snap.phase === 'night') out.push(this.notice('night', '天黑了，怪物会出来', 0.6, 300_000, now));
      else if (snap.phase === 'dawn' || (snap.phase === 'day' && prev.phase !== 'dawn')) out.push(this.notice('morning', '天亮了', 0.55, 300_000, now));
    }
    // 身上多了状态效果（中毒、饥饿、凋零……）：像人看到心变绿了
    for (const e of snap.effects) if (!prev.effects.has(e)) out.push(this.notice(`effect:${e}`, `身上有了状态效果：${e}`, /中毒|凋零|饥饿|失明|黑暗|不祥/.test(e) ? 0.55 : 0.35, 60_000, now));
    // 工具、武器、护甲快磨坏了
    for (const n of snap.worn) if (!prev.worn.has(n)) out.push(this.notice(`worn:${n}`, `${n} 快坏了（耐久不到 15%）`, 0.5, 300_000, now));
    // 天气变了：像人抬头看天——下雨、打雷、雨停
    if (snap.weather && prev.weather && snap.weather !== prev.weather) {
      const kind = (w: string) => w.startsWith('雷雨') ? 'thunder' : w.startsWith('下雨') ? 'rain' : 'clear';
      const now2 = kind(snap.weather), was = kind(prev.weather);
      if (now2 === 'thunder') out.push(this.notice('weather', `打雷了：${snap.weather}`, 0.6, 120_000, now));
      else if (now2 === 'rain' && was === 'clear') out.push(this.notice('weather', `开始${snap.weather}`, 0.4, 120_000, now));
      else if (now2 === 'clear') out.push(this.notice('weather', `${was === 'thunder' ? '雷雨' : '雨'}停了，天晴了`, 0.35, 120_000, now));
    }
    if (snap.food <= 6 && prev.food > 6) out.push(this.notice('hungry', `饿了（饥饿值 ${snap.food}）`, 0.6, 120_000, now));
    else if (snap.food <= 12 && prev.food > 12) out.push(this.notice('peckish', `有点饿（饥饿值 ${snap.food}）`, 0.3, 300_000, now));
    if (prev.hp - snap.hp >= 4) out.push(this.notice('hp_drop', `掉了 ${Math.round(prev.hp - snap.hp)} 点血，现在 ${Math.round(snap.hp)}`, snap.hp <= 8 ? 0.7 : 0.5, 10_000, now));
    if (snap.emptySlots === 0 && prev.emptySlots > 0) out.push(this.notice('inv_full', '背包没有空格了；与已有未满物品堆兼容的物品仍可能装入', 0.55, 180_000, now));
    for (const h of snap.hostiles) if (!prev.hostiles.has(h) && h !== 'creeper') out.push(this.notice(`hostile:${h}`, `附近出现了 ${h}`, 0.4, 30_000, now));
    // 苦力怕靠近是要立刻拿主意的事：只报事实（几格外、是否在嘶嘶作响），打还是跑由它定
    const creeper = p.nearby.hostile.find((h) => h.name === 'creeper' && h.dist <= 10);
    if (creeper) out.push(this.notice('creeper_near', `苦力怕在 ${Math.round(creeper.dist)} 格外${creeper.fusing ? '，正在嘶嘶作响' : '靠过来'}`, creeper.dist <= 6 ? 0.8 : 0.6, 20_000, now));
    for (const r of snap.resources) if (!prev.resources.has(r) && /ore|diamond|emerald|ancient|amethyst|spawner|chest|portal|village|bell/.test(r)) {
      out.push(this.notice(`res:${r}`, `看见了 ${r}`, /diamond|emerald|ancient|spawner|portal/.test(r) ? 0.55 : 0.4, 180_000, now));
    }
    if (snap.light === 'dark' && prev.light !== 'dark') out.push(this.notice('dark', '周围很暗', 0.3, 120_000, now));
    // 转头后重见同一实体不再提醒；同种物品的新实体仍交给下一次思考判断。
    // 同批合成一条，新批次保留到现有思考调度统一取走，不用物品名冷却吞掉新信息。
    if (freshDrops.length) out.push(this.notice(`drops:${freshDrops.flatMap((d) => d.ids).sort((a, b) => a - b).join(',')}`,
      `地上有掉落物：${freshDrops.slice(0, 4).map((d) => `${d.item}×${d.count}（${d.dir ?? ''}${d.dist}格${d.tossed_by_me ? '，自己刚扔的' : ''}）`).join('、')}——要不要捡（pickup_items），自己判断`, considerPickup ? 0.5 : 0.4, 0, now));
    return out.filter((n): n is Noticing => !!n);
  }

  fromLoop(records: ActivityEnd[], here: ActivityEnd['pos'], now = Date.now()): Noticing | null {
    // 完成一段活动后，先前的失败不再组成新的重复提醒；原始经历仍由心智保存。
    const completedAt = records.filter((r) => r.outcome === 'done').reduce((at, r) => Math.max(at, r.at), 0);
    if (completedAt > this.loopSeenThrough) {
      this.resetLoop();
      this.loopSeenThrough = completedAt;
    }
    const latest = records.at(-1);
    if (!latest || latest.outcome !== 'stuck' || latest.at <= this.loopSeenThrough) return null;
    const failures = records.filter((r) => r.outcome === 'stuck' && r.at > this.loopSeenThrough
      && r.skill === latest.skill && r.failureCode === latest.failureCode
      && now - r.at >= 0 && now - r.at <= EXPERIENCE_MS
      && Math.hypot(r.pos.x - here.x, r.pos.y - here.y, r.pos.z - here.z) <= 8);
    if (failures.length < 3 || !failures.includes(latest)) return null;
    this.loopSeenThrough = latest.at;
    // 只汇报这批新证据；时间流逝不等于继续失败，也不据此抢占动作或指定策略。
    return this.notice(`loop:${latest.skill ?? 'activity'}:${latest.failureCode ?? 'STUCK'}`,
      `附近新记录 ${failures.length} 次 ${latest.skill ?? '活动'} ${latest.failureCode ?? 'STUCK'} 失败；最近一次：${latest.summary}`,
      0.45, 0, now);
  }

  resetLoop() { this.loopSeenThrough = 0; this.pending = this.pending.filter((n) => !n.key.startsWith('loop:')); }

  /** 取走所有待处理的注意（交给思考），并返回其中最高的显著度 */
  drain(): Noticing[] { const out = this.pending; this.pending = []; return out; }
  peek(): Noticing[] { return [...this.pending]; }
  highest(): number { return this.pending.reduce((m, n) => Math.max(m, n.salience), 0); }
  reset() { this.pending = []; this.last = null; this.seenDrops.clear(); this.resetLoop(); }
}
