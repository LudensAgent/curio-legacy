import fs from 'node:fs';
import path from 'node:path';
import type { GameAdapter } from '../adapter/types.ts';
import type { TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { SKILLS } from '../skills/index.ts';
import { SMELTABLE } from '../skills/economy.ts';
import { validateSkill } from '../skills/types.ts';
import { methodName, type MethodLibrary, type SimpleStep } from './learning.ts';

/**
 * 从经历里学做法（不靠模型主动提议，也不要求计划逐字重复）：
 * 1. 每一步结束时实测背包增减；
 * 2. 真的合成/冶炼出一件东西时，顺着“用掉了什么 ← 哪一步拿到的”往回找，得到做成它的那条因果链
 *    （中间被打断、绕路、多余的环顾都不算），保留动作的原始目标、数量和开关；
 * 3. 同一条链在两个不同的地方出现过 → 提出候选，供 Agent 显式试验；
 * 4. 提取的因果链只是程序的假设，不能用原经历给候选程序填入通过证据。
 */

interface TraceEntry {
  skill: string; args: Record<string, unknown>; ok: boolean; ts: number; durationMs: number;
  gain: Record<string, number>; used: Record<string, number>; worldId: string; dim: string; pos: { x: number; z: number };
}
export interface Episode {
  item: string; signature: string; steps: SimpleStep[]; durationMs: number; contextKey: string; worldId: string; dimension: string;
  ts: number; before: number; after: number;
}
interface Saved { version: 1; episodes: Record<string, Episode[]> }

/** 物品“家族”：木头类（原木/木头/木板）互相可换，木棍也来自木头 */
export function family(name: string): string {
  if (/_(log|wood|stem|hyphae)$/.test(name) || /_planks$/.test(name) || name === 'stick' || name === 'log' || name === 'planks') return 'wood';
  return name;
}
const fam = (o: Record<string, number>) => new Set(Object.keys(o).filter((k) => o[k] > 0).map(family));

/** Intermediate products do not independently trigger candidate extraction. */
const AUTO_INTERMEDIATE = /^([a-z_]+_planks|stick)$/;

export class ExperienceMiner {
  private trace: TraceEntry[] = [];
  private lastInv: Record<string, number> = {};
  private data: Saved = { version: 1, episodes: {} };

  constructor(private file: string | null, private adapter: GameAdapter, private memory: WorldMemory, private methods: MethodLibrary, private bus: EventBus) {
    if (file && fs.existsSync(file)) {
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d?.version === 1) this.data = { version: 1, episodes: d.episodes ?? {} }; }
      catch { /* 文件坏了就从头积累，不影响游玩 */ }
    }
    this.lastInv = this.inventory();
  }

  private inventory(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const i of this.adapter.state().inventory) out[i.name] = (out[i.name] ?? 0) + i.count;
    return out;
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  episodes(item?: string): Episode[] { return structuredClone(item ? this.data.episodes[item] ?? [] : Object.values(this.data.episodes).flat()); }

  /** 每个任务结束时调用（任何来源的任务都要调用，好让背包基线跟上；只有模型选的步骤进入经历） */
  onDone(o: TaskOutcome) {
    const now = this.inventory();
    const gain: Record<string, number> = {}, used: Record<string, number> = {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(this.lastInv)])) {
      const d = (now[k] ?? 0) - (this.lastInv[k] ?? 0);
      if (d > 0) gain[k] = d; else if (d < 0) used[k] = -d;
    }
    const before = this.lastInv;
    this.lastInv = now;
    if (o.task.source !== 'llm') return;
    const s = this.adapter.state();
    const entry: TraceEntry = { skill: o.task.skill, args: (o.task.args ?? {}) as Record<string, unknown>, ok: o.result.status === 'succeeded',
      ts: Date.now(), durationMs: o.durationMs, gain, used, worldId: s.worldId, dim: s.dim, pos: { x: s.pos.x, z: s.pos.z } };
    this.trace.push(entry);
    this.trace = this.trace.filter((t) => entry.ts - t.ts < 20 * 60_000).slice(-40);
    if (!entry.ok || !['craft', 'smelt'].includes(entry.skill)) return;
    const item = entry.skill === 'craft' ? String(entry.args.item ?? '') : SMELTABLE[String(entry.args.item ?? '')] ?? '';
    if (!item || !(gain[item] > 0) || AUTO_INTERMEDIATE.test(item)) return;
    const episode = this.extract(item, entry, before[item] ?? 0, now[item] ?? 0);
    if (episode) this.record(episode);
  }

  /** 顺着“用掉的东西 ← 拿到它的那一步”往回找，得到做成 item 的因果链 */
  private extract(item: string, last: TraceEntry, before: number, after: number): Episode | null {
    const chain: TraceEntry[] = [last];
    let needed = fam(last.used);
    for (let i = this.trace.length - 2; i >= 0 && needed.size && chain.length < 10; i--) {
      const t = this.trace[i];
      if (!t.ok || t.worldId !== last.worldId || t.dim !== last.dim || last.ts - t.ts > 15 * 60_000) continue;
      const g = fam(t.gain);
      if (![...g].some((f) => needed.has(f))) continue;
      chain.unshift(t);
      needed = new Set([...[...needed].filter((f) => !g.has(f)), ...fam(t.used)]);
      // 采集前专门去找它的那段 explore 也是做法的一部分（看见目标就停，所以不会白走）
      const prev = this.trace[i - 1];
      if (t.skill === 'gather' && prev?.ok && prev.skill === 'explore' && prev.args.until) chain.unshift(prev);
    }
    const steps: SimpleStep[] = [];
    for (const t of chain) {
      if (!['gather', 'explore', 'craft', 'smelt', 'hunt', 'take_items'].includes(t.skill)) continue;
      const skill = SKILLS[t.skill];
      if (!skill) return null;
      const v = validateSkill(skill, t.args, this.adapter);
      if (!v.ok) return null;
      steps.push({ skill: t.skill, args: structuredClone(v.args) });
    }
    // 只是一步合成（材料早就在背包里）不算学到了做法
    if (steps.length < 2 || !steps.some((st) => st.skill !== 'craft')) return null;
    const durationMs = chain.reduce((n, t) => n + t.durationMs, 0);
    return { item, signature: JSON.stringify(steps), steps, durationMs, worldId: last.worldId, dimension: last.dim,
      contextKey: `${last.worldId}:${last.dim}:${Math.floor(last.pos.x / 16)}:${Math.floor(last.pos.z / 16)}`, ts: last.ts, before, after };
  }

  private record(ep: Episode) {
    const list = (this.data.episodes[ep.item] ??= []);
    list.push(ep);
    if (list.length > 12) list.splice(0, list.length - 12);
    this.save();
    this.bus.publish('experience', 'P3', `记录 ${ep.item} 增加期间的动作（${ep.steps.map((st) => st.skill).join(' → ')}，因果关系尚待试验）`, { item: ep.item });
    this.consider(ep.item);
  }

  /** 重复经历仅提示一个可试验的组合；旧经历不证明提取后的程序可靠。 */
  private consider(item: string) {
    const groups = new Map<string, Episode[]>();
    for (const e of this.data.episodes[item] ?? []) {
      if (e.worldId !== this.memory.worldId) continue;
      (groups.get(e.signature) ?? groups.set(e.signature, []).get(e.signature)!).push(e);
    }
    const repeated = [...groups.values()].map((eps) => {
      const byPlace = new Map(eps.map((e) => [e.contextKey, e]));
      return { eps: [...byPlace.values()], avgMs: eps.reduce((n, e) => n + e.durationMs, 0) / eps.length };
    }).filter((g) => g.eps.length >= 2).sort((a, b) => a.avgMs - b.avgMs);
    const best = repeated[0];
    if (!best) return;
    const name = methodName(`get_${item}`);
    const steps = best.eps[0].steps;
    const description = `从经历提取的候选组合：获得 ${item}（${steps.map((st) => st.skill).join(' → ')}）；组合效果尚未验证`.slice(0, 230);
    const r = this.methods.propose({ name, description, program: { type: 'sequence', steps: steps.map((st) => ({ type: 'call', skill: st.skill, args: st.args ?? {} })) },
      postcondition: { type: 'inventory_gain', item, count: 1 } });
    if (!r.ok) { this.bus.publish('skill_rejected', 'P3', `想把做 ${item} 的经验固定成方法，但没成：${r.error}`); return; }
    if (!r.existing) this.bus.publish('experience_candidate', 'P2', `从重复经历提出 ${r.name}；仍需显式执行并检查结果`, { name: r.name, item, version: r.version });
  }
}
