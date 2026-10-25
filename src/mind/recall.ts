import type { SkillBook } from '../knowledge/skillbook.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { LedgerView } from './ledger.ts';
import { cleanLesson, keywords, type SelfModel } from './self.ts';

/**
 * 按关键词想起来：像人看到眼前的事会想起以前的经历、学过的做法。
 * 不依赖外部服务：在日记、做过的事、窍门、游戏教训、技能书和记得的地方里，按关键词重叠 + 新近程度挑出最相关的几条。
 * 每次思考前自动想一遍（结果放进提示词）；模型也可以主动 {"kind":"recall","query":"…"} 再想。
 */
export interface Recalled { kind: 'experience' | 'diary' | 'know_how' | 'lesson' | 'skill' | 'place' | 'note' | 'ledger'; text: string; score: number; ref?: string; at?: number }

export interface RecallSources { self: SelfModel; memory: WorldMemory; book?: SkillBook | null; extraSkills?: { name: string; text: string }[]; ledger?: LedgerView | null }

const ago = (at: number, now: number) => {
  const m = Math.round((now - at) / 60000);
  return m < 1 ? '刚才' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

export function recallLocal(query: string, src: RecallSources, opts: { n?: number; exclude?: Recalled['kind'][]; excludeRefs?: string[]; now?: number } = {}): Recalled[] {
  const q = keywords(query);
  if (!q.size) return [];
  const now = opts.now ?? Date.now();
  const skip = new Set(opts.exclude ?? []);
  const out: Recalled[] = [];
  const score = (text: string, extra: string[] = []) => {
    const k = keywords(text);
    for (const e of extra) for (const w of keywords(e)) k.add(w);
    let n = 0;
    for (const w of q) if (k.has(w)) n += /^[a-z]/.test(w) ? 1.5 : 1;
    return n;
  };
  const fresh = (at: number) => at && now - at < 30 * 60_000 ? 0.6 : at && now - at < 3 * 3600_000 ? 0.3 : 0;
  const hide = new Set(opts.excludeRefs ?? []);
  // 已经在提示词别处出现的不重复；技能要更相关才算想起来（只沾一两个字的建筑说明不算）
  const push = (r: Omit<Recalled, 'score'>, base: number, at = 0) => {
    if (r.ref && hide.has(r.ref)) return;
    if (base >= (r.kind === 'skill' ? 3 : 2)) out.push({ ...r, score: base + fresh(at), ...(at ? { at } : {}) });
  };

  if (!skip.has('experience')) for (const r of src.self.history(60)) {
    const gained = Object.keys(r.gained).join(' ');
    push({ kind: 'experience', text: `${ago(r.at, now)}「${r.what}」→ ${r.outcome === 'done' ? '做成了' : r.outcome === 'stuck' ? '卡住了' : '停下了'}：${r.summary.slice(0, 80)}`, ref: r.id },
      score(`${r.what} ${r.summary} ${r.signature}`, [gained]) * (r.outcome === 'stuck' ? 1.2 : 1), r.at);
  }
  if (!skip.has('diary')) for (const d of src.self.diary(50)) push({ kind: 'diary', text: `${ago(d.at, now)}：${d.text}` }, score(d.text), d.at);
  if (!skip.has('know_how')) for (const k of src.self.data.knowHow) {
    const trust = (k.wins + 1) / (k.wins + k.losses + 2);
    push({ kind: 'know_how', text: `${cleanLesson(k.text)}（成${k.wins}/败${k.losses}）`, ref: k.id }, score(k.text, k.tags) * (0.6 + trust), k.updatedAt);
  }
  if (!skip.has('lesson')) {
    try { for (const l of src.memory.lessonsFor(40)) push({ kind: 'lesson', text: l.text.slice(0, 120) }, score(l.text), l.ts); } catch { /* 记忆暂不可用 */ }
  }
  if (!skip.has('note')) {
    try { for (const n of src.memory.notesFor({ n: 30 })) push({ kind: 'note', text: n.text.slice(0, 120) }, score(n.text), n.ts); } catch { /* 记忆暂不可用 */ }
  }
  if (!skip.has('skill')) {
    for (const s of src.book?.list() ?? []) push({ kind: 'skill', text: `${s.name}：${s.description}`, ref: s.name }, score(`${s.name.replace(/-/g, ' ')} ${s.description}`, [s.body.slice(0, 600)]) * 0.9);
    for (const s of src.extraSkills ?? []) push({ kind: 'skill', text: s.text, ref: s.name }, score(s.text));
  }
  if (!skip.has('place')) {
    try { for (const l of src.memory.landmarks()) push({ kind: 'place', text: `${l.label} (${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)}) ${l.dim}`, ref: l.id }, score(`${l.label} ${l.kind}`), l.ts); } catch { /* 记忆暂不可用 */ }
  }
  // 收获账：想到某样东西，就想起拿它一般花多少、在哪多、最省的做法是什么（名字或拿到它的那些活沾上关键词）
  if (!skip.has('ledger') && src.ledger) {
    try {
      for (const name of src.ledger.names()) {
        const base = score(name.replace(/_/g, ' '), src.ledger.aliases(name));
        if (base < 2) continue;
        const text = src.ledger.describe(name);
        if (text) push({ kind: 'ledger', text: text.slice(0, 260), ref: `ledger:${name}` }, base + 0.5);
      }
    } catch { /* 账本暂不可用 */ }
  }
  // 同一句话只留分高的一条
  const seen = new Set<string>();
  return out.sort((a, b) => b.score - a.score).filter((r) => { const k = r.text.slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, opts.n ?? 6);
}

export const RECALL_LABEL: Record<Recalled['kind'], string> = { experience: '经历', diary: '日记', know_how: '窍门', lesson: '教训', skill: '技能', place: '地方', note: '笔记', ledger: '收获账' };
