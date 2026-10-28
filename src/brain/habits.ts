import type { HazardKind, WorldMemory } from '../memory/store.ts';

/**
 * 习惯与反思（自学技能的数据来源）：
 * - 找出最近反复产生已验证效果的同一套步骤 → 提示 LLM 学成技能；重复 3 次以上自动提为候选
 * - 每完成若干个目标，提醒 LLM 做一次反思，写下经验教训
 */
export interface LearnCandidate {
  signature: string;
  times: number;
  steps: { skill: string; args?: unknown }[];
  goal: string;
}

export function learnCandidates(memory: WorldMemory, known: Set<string>): LearnCandidate[] {
  const m = new Map<string, LearnCandidate>();
  for (const g of memory.recentGoals(20)) {
    if (g.status !== 'succeeded' || !g.effectEvidence?.verified || !g.effectEvidence.changed || !g.steps || !g.plan || g.steps.length < 2) continue;
    if (g.steps.some((s) => /^(macro|trial|method):/.test(s))) continue;
    const sig = g.steps.join(' → ');
    if (known.has(sig)) continue;
    const c = m.get(sig) ?? { signature: sig, times: 0, steps: g.plan, goal: g.goal };
    c.times++;
    m.set(sig, c);
  }
  return [...m.values()].filter((c) => c.times >= 2).sort((a, b) => b.times - a.times).slice(0, 3);
}

/** 由步骤生成一个合法的技能名：gather_log_craft_torch */
export function habitName(c: LearnCandidate): string {
  const base = c.signature
    .split(' → ')
    .map((s) => s.replace(/^macro:/, '').replace(/[^a-z0-9:_]/g, '').replace(':', '_'))
    .join('_')
    .replace(/_+/g, '_')
    .slice(0, 28)
    .replace(/_$/, '');
  return /^[a-z]/.test(base) ? base : `h_${base}`.slice(0, 30);
}

/** 自上次（模型写下的）经验或上次反思以来，又完成了 every 个目标 → 该反思了。程序记下的观察性经验不算反思 */
export function reflectionDue(memory: WorldMemory, every = 8, since = 0): boolean {
  const lastLesson = memory.lessons(40).filter((l) => l.source !== 'observed').at(-1)?.ts ?? 0;
  const from = Math.max(lastLesson, since);
  return memory.recentGoals(40).filter((g) => g.ts > from).length >= every;
}

// ------------------------------------------------------------ 程序观察到的经验（不是模型说的）
/** 死前几秒的状态（main 每秒记一份） */
export interface VitalSample {
  ts: number;
  hp: number;
  food: number;
  oxygen: number;
  inWater: boolean;
  inLava: boolean;
  /** 最近的敌对生物距离（看见/听见），没有为 null */
  hostileDist: number | null;
  /** 附近的敌对生物（名字 + 距离），用来认出远程/爆炸的怪 */
  hostiles?: { name: string; dist: number }[];
  /** 这一刻在做的（非反射）任务：技能名 + 关键参数 */
  task?: string;
  pos?: { x: number; y: number; z: number };
}

/** 根据死前的状态推断死因（只用真实观测，推不出就是 unknown） */
export function deathCause(samples: VitalSample[], lastHurtAt = 0, now = Date.now()): HazardKind {
  const recent = samples.filter((s) => now - s.ts <= 12_000);
  const last = recent.at(-1);
  if (!last) return 'unknown';
  if (recent.some((s) => s.inLava)) return 'lava';
  // 氧气读数只在水里可信（岸上的读数可能是旧值）
  if (recent.slice(-4).some((s) => s.inWater && s.oxygen <= 3)) return 'drowning';
  const near = (s: VitalSample, d: number) => s.hostileDist !== null && s.hostileDist <= d;
  // 骷髅射箭、苦力怕爆炸、烈焰人/恶魂远程：20 多格外也能打死人
  const ranged = (s: VitalSample) => (s.hostiles ?? []).some((h) => RANGED.test(h.name) && h.dist <= 24);
  if (last.food <= 0 && !recent.some((s) => near(s, 6))) return 'starvation';
  const tail = recent.slice(-4);
  if (tail.some((s) => near(s, 6) || ranged(s)) || (now - lastHurtAt < 3000 && recent.slice(-3).some((s) => near(s, 10)))) return 'mob';
  // 前一刻血还多、没有怪、不在水里：多半是摔死
  const before = recent.slice(-4, -1);
  if (before.length && before.some((s) => s.hp >= 6) && !last.inWater) return 'fall';
  return 'unknown';
}

const RANGED = /skeleton|stray|bogged|creeper|pillager|blaze|ghast|witch|drowned|shulker|wither|guardian/;

const CAUSE_TEXT: Record<HazardKind, string> = {
  drowning: '淹死', lava: '掉进岩浆', fall: '摔死', mob: '被怪打死',
  explosion: '被炸死', starvation: '饿死', suffocation: '窒息而死', unknown: '死亡',
};

export const causeName = (kind: HazardKind | string) => CAUSE_TEXT[kind as HazardKind] ?? String(kind);

/** Record what happened without turning a fixed strategy into personal learning. */
export function hazardFact(h: { pos: { x: number; y: number; z: number }; kind: HazardKind; count: number; during?: string; note?: string }): string {
  return `在 (${h.pos.x},${h.pos.y},${h.pos.z}) 附近${h.during ? `做 ${h.during} 时` : ''}${causeName(h.kind)}过 ${h.count} 次${h.note ? `；${h.note}` : ''}`;
}

/** 与 Executive 记录目标时相同的步骤签名 */
export function signatureOf(steps: { skill: string; args?: unknown }[]): string {
  return steps
    .map((st) => {
      const a = (st.args ?? {}) as Record<string, unknown>;
      const key = a.block ?? a.item ?? a.blueprint ?? a.crop ?? a.target ?? a.animal ?? a.direction ?? '';
      return key ? `${st.skill}:${key}` : st.skill;
    })
    .join(' → ');
}
