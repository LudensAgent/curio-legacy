import type { SkillBook } from '../knowledge/skillbook.ts';
import { KNOW_HOW_LESSON_KEY_PREFIX, type WorldMemory } from '../memory/store.ts';
import type { LedgerView } from './ledger.ts';
import { cleanLesson, keywords, type SelfModel } from './self.ts';
import { oreAlias } from '../memory/ore-spots.ts';
import { creatureAlias, HERD_MAX_AGE_MS } from '../memory/creature-spots.ts';
import { chestLocation, isContainerLandmark } from '../memory/chest-memory.ts';
import { recallText } from '../memory/recollection.ts';

/**
 * 按关键词想起来：像人看到眼前的事会想起以前的经历、学过的做法。
 * 不依赖外部服务：在日记、做过的事、窍门、游戏教训、技能书和记得的地方里，按关键词重叠 + 新近程度挑出最相关的几条。
 * 每次思考前自动想一遍（结果放进提示词）；模型也可以主动 {"kind":"recall","query":"…"} 再想。
 */
export interface Recalled {
  kind: 'experience' | 'diary' | 'know_how' | 'lesson' | 'skill' | 'place' | 'note' | 'ledger';
  text: string; score: number; ref?: string; at?: number; worldId?: string; dimension?: string; source?: string;
  /** 这条是因为当前目标、当前执行缺口，还是历史经历被想起。 */
  match?: 'current_goal' | 'execution_gap' | 'historical';
}

export interface RecallSources { self: SelfModel; memory: WorldMemory; book?: SkillBook | null; extraSkills?: { name: string; text: string }[]; ledger?: LedgerView | null }

const ago = (at: number, now: number) => {
  const m = Math.round((now - at) / 60000);
  return m < 1 ? '刚才' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

export function recallLocal(query: string, src: RecallSources, opts: {
  n?: number; exclude?: Recalled['kind'][]; excludeRefs?: string[]; now?: number;
  /** 当前目标与执行缺口的独立关键词：用于标注匹配来源，不改变主要相关度分数。 */
  goal?: string; gap?: string;
} = {}): Recalled[] {
  const q = keywords(query);
  if (!q.size) return [];
  const goalKeys = keywords(opts.goal ?? ''), gapKeys = keywords(opts.gap ?? '');
  const overlapCount = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };
  const matchOf = (text: string): Recalled['match'] => {
    const k = keywords(text);
    return overlapCount(k, goalKeys) > 0 ? 'current_goal' : overlapCount(k, gapKeys) > 0 ? 'execution_gap' : 'historical';
  };
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
  const push = (r: Omit<Recalled, 'score'>, base: number, at = 0, floor = r.kind === 'skill' ? 3 : 2) => {
    if (r.ref && hide.has(r.ref)) return;
    const observedAt = ['know_how', 'lesson', 'diary'].includes(r.kind) || r.kind === 'note' && r.source !== 'note:fact' ? 0 : at || undefined;
    if (base >= floor) {
      const match = matchOf(r.text);
      // 目标/执行缺口是当前要用的，历史方法只有在更相关时才排在前面。
      const weight = match === 'current_goal' ? 1.25 : match === 'execution_gap' ? 1.15 : 1;
      out.push({ ...r, text: r.kind === 'skill' ? r.text : recallText(r.text, src.memory, r.dimension, observedAt, now), score: (base + fresh(at)) * weight, match, ...(at ? { at } : {}) });
    }
  };

  if (!skip.has('experience')) for (const r of src.self.history(60)) {
    const gained = Object.keys(r.gained).join(' ');
    push({ kind: 'experience', text: `${ago(r.at, now)}「${r.what}」→ ${r.outcome === 'done' ? '收工' : r.outcome === 'stuck' ? '卡住了' : '停下了'}：${r.summary.slice(0, 150)}`, ref: r.id },
      score(`${r.what} ${r.summary} ${r.signature}`, [gained]) * (r.outcome === 'stuck' ? 1.2 : 1), r.at);
  }
  if (!skip.has('diary')) for (const d of src.self.diary(50)) push({ kind: 'diary', text: `${ago(d.at, now)}：${d.text}` }, score(d.text), d.at);
  if (!skip.has('know_how')) for (const k of src.self.data.knowHow) {
    const trust = (k.wins + 1) / (k.wins + k.losses + 2);
    const applied = k.applications?.length
      ? `，应用${k.applications.filter((a) => a.outcome === 'done' && a.completion !== 'condition' && a.completion !== 'attempt' && !a.searchUnconfirmed && !a.limited).length}成/${k.applications.filter((a) => a.outcome === 'stuck').length}败`
      : '';
    const counter = k.counterexamples?.length
      ? `，反例${k.counterexamples.length}条${k.counterexamples.at(-1)?.reason ? `（最近 ${k.counterexamples.at(-1)!.reason}）` : ''}`
      : '';
    const limits = k.limits?.length ? `，边界：${k.limits.slice(0, 2).join('；')}` : '';
    const source = k.source === 'observed' ? '亲眼观察' : k.source === 'experiment' ? '实验' : '反思';
    // 未消解的反例多于确认成功（wins 已排除 attempt/原地/搜索未确认）：默认注入时降权；历史仍可主动查。
    const contested = (k.counterexamples?.length ?? 0) > k.wins;
    push({ kind: 'know_how', text: `${cleanLesson(k.text)}（成${k.wins}/败${k.losses}${k.unverified === true ? '，未验证' : ''}，来源${source}${applied}${counter}${limits}）`, ref: k.id, source: `know_how:${k.id}` },
      score(k.text, k.tags) * (0.6 + trust) * (contested ? 0.55 : 1), k.updatedAt, contested ? 0.5 : 2);
  }
  if (!skip.has('lesson')) {
    // addLesson 以 know_how:<id> 存的副本只是主窍门通道的镜像；主条目被合并/改写/删除后，
    // 旧副本不能换个通道再作为独立教训出现。程序亲眼观察写下的教训没有这个 key，照常保留。
    try {
      for (const l of src.memory.lessonsFor(40).filter((l) => !l.key?.startsWith(KNOW_HOW_LESSON_KEY_PREFIX))) {
        const provenance = l.source === 'observed' ? '亲历观察' : '模型推断（来源/验证状态未记录）';
        push({ kind: 'lesson', text: `${provenance}：${l.text.slice(0, 120)}`, source: `lesson:${l.source ?? 'model'}` }, score(l.text), l.ts);
      }
    } catch { /* 记忆暂不可用 */ }
  }
  if (!skip.has('note')) {
    try { for (const n of src.memory.notesFor({ n: 30 })) push({ kind: 'note', text: `${n.text.slice(0, 120)}〔${n.kind}，${n.dimension ?? '维度未标注'}，${ago(n.ts, now)}的笔记〕`, worldId: n.worldId, dimension: n.dimension, source: `note:${n.kind}` }, score(n.text), n.ts); } catch { /* 记忆暂不可用 */ }
  }
  if (!skip.has('skill')) {
    for (const s of src.book?.list() ?? []) {
      // 候选只是候选：展示用途与验证状态，是否试用、何时试用由 Agent 判断，不催当场调用。
      const candidate = src.book?.candidate(s.name);
      const trial = candidate
        ? `（候选，尚未验收；用途与触发条件见 {"kind":"skill","name":"${s.name}"}，试用写在 use_skill trial:true 里）`
        : '';
      // 自写的纯文字做法只是未验证笔记：想起时也标明，不能和已验证/可执行技能混在一起。
      const note = s.source === 'self' && s.behavior === undefined ? '（未验证的文字笔记，不会自动执行）' : '';
      push({ kind: 'skill', text: `${s.name}：${s.description}${note}${trial}`, ref: s.name }, score(`${s.name.replace(/-/g, ' ')} ${s.description}`, [s.body.slice(0, 600)]) * 0.9);
    }
    for (const s of src.extraSkills ?? []) push({ kind: 'skill', text: s.text, ref: s.name }, score(s.text));
  }
  if (!skip.has('place')) {
    try {
      for (const l of src.memory.landmarks()) {
        const herd = l.kind === 'herd';
        if (herd && now - l.ts > HERD_MAX_AGE_MS) continue; // 动物早走远了
        const location = isContainerLandmark(l.label) ? chestLocation(l, { now }) : null;
        const where = location ? location.text : `(${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)})`;
        push({ kind: 'place', text: `${l.label} ${where} ${l.dim}${herd ? `，${ago(l.ts, now)}见过 ${l.count ?? 1} 只${l.detail ? `（${l.detail}）` : ''}` : `，${ago(l.ts, now)}的历史地点，当前状态待复核`}`, ref: l.id, worldId: l.worldId, dimension: l.dim, source: 'historical_observation' },
          score(`${l.label} ${l.kind}`, [oreAlias(l.label), herd ? creatureAlias(l.label) : '']), l.ts);
      }
    } catch { /* 记忆暂不可用 */ }
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
