import type { WorldMemory } from '../memory/store.ts';

/**
 * 习惯与反思（自学技能的数据来源）：
 * - 找出最近反复成功的同一套步骤 → 提示 LLM 学成技能；重复 3 次以上直接自动习惯化
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
    if (g.status !== 'succeeded' || !g.steps || !g.plan || g.steps.length < 2) continue;
    if (g.steps.some((s) => s.startsWith('macro:'))) continue;
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

export function reflectionDue(memory: WorldMemory, every = 8): boolean {
  const lastLesson = memory.lessons(1)[0]?.ts ?? 0;
  return memory.recentGoals(40).filter((g) => g.ts > lastLesson).length >= every;
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
