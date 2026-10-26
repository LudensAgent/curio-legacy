import type { AgentEvent } from '../events.ts';
import { DARK_TICK, DAWN_TICK, durationText, ticksUntil, type Percept } from '../perception/perception.ts';
import type { ActivityEnd, Noticing, StuckHere } from './types.ts';

export const EXPERIENCE_MS = 10 * 60_000;

export function stuckHere(records: ActivityEnd[], here: ActivityEnd['pos'], now = Date.now()): StuckHere | null {
  const local = records.filter((r) => now - r.at >= 0 && now - r.at <= EXPERIENCE_MS &&
    Math.hypot(r.pos.x - here.x, r.pos.y - here.y, r.pos.z - here.z) <= 8);
  const failures = new Map<string, ActivityEnd[]>();
  for (const r of local) {
    if (r.outcome !== 'stuck') continue;
    const code = r.failureCode ?? 'STUCK';
    const group = failures.get(code) ?? [];
    group.push(r); failures.set(code, group);
  }
  const repeated = [...failures.entries()].filter(([, rs]) => rs.length >= 3)
    .sort((a, b) => b[1].at(-1)!.at - a[1].at(-1)!.at)[0];
  if (!repeated) return null;
  return {
    minutes: Math.max(0.1, Math.round((now - repeated[1][0].at) / 6000) / 10),
    // 只列真正卡住的办法：这一带做成了的事不算“试过但不行”
    tried: [...new Set(local.filter((r) => r.outcome === 'stuck').map((r) => r.what))].slice(-8),
    failureCode: repeated[0], lastAt: repeated[1].at(-1)!.at,
  };
}

/** 显著度阈值：≥0.75 立刻放下手上的事去想；≥0.5 边做边重新想一想；更低的只是“注意到了”，留给下一次思考 */
export const URGENT = 0.75;
export const RECONSIDER = 0.5;

const levelOf = (s: number): Noticing['level'] => s >= URGENT ? 'urgent' : s >= RECONSIDER ? 'reconsider' : 'note';

interface Snapshot { effects: Set<string>; worn: Set<string>; tod: number; weather: string; phase: string; food: number; hp: number; emptySlots: number; hostiles: Set<string>; resources: Set<string>; light: string | null; inWater: boolean; drops: Map<string, { item: string; count: number; dist: number; dir: string; tossed_by_me?: boolean }> }

/**
 * 注意力：把游戏里发生的事变成“我注意到了…”，并判断值不值得为它停下来重新想。
 * 真人玩家不会对每件事都重新规划：天黑、饿了、背包满了、看见新东西，才会抬头想一想。
 */
export class Attention {
  private pending: Noticing[] = [];
  private seenAt = new Map<string, number>();
  private last: Snapshot | null = null;

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
      case 'hurt': return this.notice('hurt', ev.msg, 0.45, 15_000);
      case 'reflex': return this.notice(`reflex:${ev.msg.slice(-12)}`, `身体自己反应了：${ev.msg}`, 0.35, 20_000);
      case 'death_items': return this.notice('death_items', ev.msg, 0.7, 60_000);
      case 'design': return this.notice(`design:${String(d.draftId ?? '')}`, `建筑师把图纸画好了：${ev.msg}`, 0.6, 0);
      case 'effect_broken': return this.notice(`effect:${String(d.item ?? '')}`, `刚做完的事又被打破了：${ev.msg}`, 0.55, 60_000);
      case 'design_failed': return this.notice(`design_failed:${ev.msg.slice(0, 20)}`, `建筑师没画成：${ev.msg}`, 0.5, 0);
      case 'chat': {
        // 有人在聊天里说话（不是自己）：值得听一听
        if (/^<([^>]+)>/.test(ev.msg) && !/\[想法\]/.test(ev.msg)) return this.notice(`chat:${ev.msg}`, `有人说：${ev.msg}`, 0.5, 5_000);
        return null;
      }
      case 'skill_loop': return this.notice(`skill_loop:${String(d.a ?? '')}:${String(d.b ?? '')}`, ev.msg, 0.65, 300_000);
      case 'reflex_gaveup': return this.notice('reflex_gaveup', ev.msg, 0.8, 20_000);
      case 'skill_forged': return this.notice(`skill_forged:${String(d.name ?? '')}`, `${ev.msg}（身体以后会自己这么做）`, 0.4, 0);
      case 'skill_merged': return this.notice(`skill_merged:${String(d.into ?? '')}`, ev.msg, 0.3, 0);
      case 'skill_improved': return this.notice(`skill_improved:${String(d.name ?? '')}`, ev.msg, 0.35, 0);
      case 'skill_rollback': return this.notice(`skill_rollback:${String(d.name ?? '')}`, ev.msg, 0.35, 0);
      case 'skill_disabled': return d.by === 'stats' ? this.notice(`skill_disabled:${String(d.name ?? '')}`, `${ev.msg}：回头改一改（同名重写 skill）`, 0.5, 600_000) : null;
      case 'lesson': return d.source === 'observed' ? this.notice(`lesson:${ev.msg.slice(0, 30)}`, ev.msg, 0.3, 300_000) : null;
      default: return null;
    }
  }

  /** 比较前后两次感知，找出“变化”：天色、饥饿、生命、背包、新出现的怪和资源 */
  fromPercept(p: Percept, now = Date.now()): Noticing[] {
    const snap: Snapshot = {
      effects: new Set(p.effects ?? []),
      // 同名的全都快坏了才算“快坏了”：手里那把快坏、背包里还有好的，不是缺工具
      worn: new Set((p.inventory ?? []).filter((i) => i.durability && (i.durabilities?.[0] ?? i.durability.left) / i.durability.max < 0.15).map((i) => i.name)),
      tod: ((p.time.timeOfDay % 24000) + 24000) % 24000, weather: p.time.weather ?? '', phase: p.time.phase, food: p.self.food, hp: p.self.hp, emptySlots: p.emptySlots,
      hostiles: new Set(p.nearby.hostile.filter((h) => h.dist <= 16).map((h) => h.name)),
      resources: new Set(p.nearby.resources.filter((r) => r.seen === 'now').map((r) => r.block)),
      light: p.light?.level ?? null, inWater: p.self.inWater,
      drops: new Map(((p.vision as any)?.visible_drops ?? []).map((d: { item: string; count: number; dist: number; dir: string; tossed_by_me?: boolean }) => [d.tossed_by_me ? `${d.item}:mine` : d.item, d])),
    };
    const prev = this.last;
    this.last = snap;
    if (!prev) return [];
    const out: (Noticing | null)[] = [];
    // 时间感：一天里的几个节点各抬头想一次（像人看一眼天色：今天过了多少、晚上还有多久、新的一天要做什么）
    const day = p.time.day !== undefined ? `第 ${p.time.day + 1} 天` : '';
    const untilDark = durationText(ticksUntil(snap.tod, DARK_TICK)), untilDawn = durationText(ticksUntil(snap.tod, DAWN_TICK));
    if (snap.phase !== prev.phase) {
      if (snap.phase === 'dusk') out.push(this.notice('dusk', `${day}傍晚 6 点，太阳在落山：${untilDark}后天黑刷怪、半小时后就能睡；今晚在哪过，想好了就去`, 0.55, 300_000, now));
      else if (snap.phase === 'night') out.push(this.notice('night', `晚上 7 点，天黑了，怪物会出来；离天亮约 ${untilDawn.replace(/^约 /, '')}`, 0.6, 300_000, now));
      else if (snap.phase === 'dawn' || (snap.phase === 'day' && prev.phase !== 'dawn')) out.push(this.notice('morning', `天亮了，${day ? `新的一天（${day}）` : '新的一天'}开始：想想今天要做成什么`, 0.55, 300_000, now));
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
    const crossed = (tick: number) => prev.tod < tick && snap.tod >= tick && snap.tod - prev.tod < 2400;
    if (crossed(6000)) out.push(this.notice('noon', `中午 12 点了，${day}白天过了一半，离天黑（晚上 7 点）还有${untilDark}：下午还长，手上的活接着做`, 0.5, 300_000, now));
    if (crossed(18000)) out.push(this.notice('midnight', `半夜 12 点了，离天亮约 ${untilDawn.replace(/^约 /, '')}`, 0.5, 300_000, now));
    if (snap.food <= 6 && prev.food > 6) out.push(this.notice('hungry', `饿了（饥饿值 ${snap.food}）`, 0.6, 120_000, now));
    else if (snap.food <= 12 && prev.food > 12) out.push(this.notice('peckish', `有点饿（饥饿值 ${snap.food}）`, 0.3, 300_000, now));
    if (prev.hp - snap.hp >= 4) out.push(this.notice('hp_drop', `掉了 ${Math.round(prev.hp - snap.hp)} 点血，现在 ${Math.round(snap.hp)}`, snap.hp <= 8 ? 0.7 : 0.5, 10_000, now));
    if (snap.emptySlots === 0 && prev.emptySlots > 0) out.push(this.notice('inv_full', '背包满了，再捡东西就装不下了', 0.55, 180_000, now));
    for (const h of snap.hostiles) if (!prev.hostiles.has(h) && h !== 'creeper') out.push(this.notice(`hostile:${h}`, `附近出现了 ${h}`, 0.4, 30_000, now));
    // 苦力怕靠近是要立刻拿主意的事：打（defend {"target":"creeper"}，砍一下退一步）还是绕开跑远
    const creeper = p.nearby.hostile.find((h) => h.name === 'creeper' && h.dist <= 10);
    if (creeper) out.push(this.notice('creeper_near', `苦力怕在 ${Math.round(creeper.dist)} 格外${creeper.fusing ? '，正在嘶嘶作响' : '靠过来'}：打掉它（defend {"target":"creeper"}）还是绕开跑远，现在拿主意`, creeper.dist <= 6 ? 0.8 : 0.6, 20_000, now));
    for (const r of snap.resources) if (!prev.resources.has(r) && /ore|diamond|emerald|ancient|amethyst|spawner|chest|portal|village|bell/.test(r)) {
      out.push(this.notice(`res:${r}`, `看见了 ${r}`, /diamond|emerald|ancient|spawner|portal/.test(r) ? 0.55 : 0.4, 180_000, now));
    }
    if (snap.light === 'dark' && prev.light !== 'dark') out.push(this.notice('dark', '周围很暗', 0.3, 120_000, now));
    // 地上新出现的掉落物（猎物掉的肉、打怪掉的东西、炸出来的方块……）：看见了就知道，捡不捡它自己定
    const fresh = [...snap.drops.entries()].filter(([k, d]) => !prev.drops.has(k) && d.dist <= 16).map(([, d]) => d);
    if (fresh.length) out.push(this.notice(`drops:${fresh.map((d) => d.item).sort().join(',')}`,
      `地上有掉落物：${fresh.slice(0, 4).map((d) => `${d.item}×${d.count}（${d.dir ?? ''}${d.dist}格${d.tossed_by_me ? '，自己刚扔的' : ''}）`).join('、')}——要不要捡（pickup_items），自己判断`, 0.5, 60_000, now));
    return out.filter((n): n is Noticing => !!n);
  }

  fromLoop(records: ActivityEnd[], here: ActivityEnd['pos'], now = Date.now()): Noticing | null {
    const stuck = stuckHere(records, here, now);
    if (!stuck) return null;
    // 同一带、同一种失败只提醒一次（冷却几分钟），否则每多失败一次就逼着重新深想一遍
    return this.notice(`loop:${stuck.failureCode}`,
      `在 (${Math.round(here.x)},${Math.round(here.y)},${Math.round(here.z)}) 一带已卡住 ${stuck.minutes} 分钟，试过：${stuck.tried.join('、')}；需要换完全不同的思路`,
      0.8, 4 * 60_000, now);
  }

  /** 取走所有待处理的注意（交给思考），并返回其中最高的显著度 */
  drain(): Noticing[] { const out = this.pending; this.pending = []; return out; }
  peek(): Noticing[] { return [...this.pending]; }
  highest(): number { return this.pending.reduce((m, n) => Math.max(m, n.salience), 0); }
  reset() { this.pending = []; this.last = null; }
}
