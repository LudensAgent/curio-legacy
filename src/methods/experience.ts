import fs from 'node:fs';
import path from 'node:path';
import type { GameAdapter } from '../adapter/types.ts';
import type { TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { SKILLS } from '../skills/index.ts';
import { SMELTABLE } from '../skills/economy.ts';
import { methodName, type MethodLibrary, type SimpleStep } from './learning.ts';

/**
 * 从经历里学做法（不靠模型主动提议，也不要求计划逐字重复）：
 * 1. 每一步结束时实测背包增减；
 * 2. 真的合成/冶炼出一件东西时，顺着“用掉了什么 ← 哪一步拿到的”往回找，得到做成它的那条因果链
 *    （中间被打断、绕路、多余的环顾都不算），数量、木头种类等细节归一化；
 * 3. 同一条链在两个不同的地方都真的做成过 → 采纳为已验证方法 method:get_<物品>（证据就是那两次背包的实测增加）；
 * 4. 同一件东西后来出现了明显更快、同样做成过两次的做法 → 换成新版本，旧版本退役（这就是“优化自己的玩法”）。
 */

interface TraceEntry {
  skill: string; args: Record<string, unknown>; ok: boolean; ts: number; durationMs: number;
  gain: Record<string, number>; used: Record<string, number>; worldId: string; dim: string; pos: { x: number; z: number };
}
export interface Episode {
  item: string; signature: string; steps: SimpleStep[]; durationMs: number; contextKey: string; worldId: string; dimension: string;
  ts: number; before: number; after: number;
}
interface Saved { version: 1; episodes: Record<string, Episode[]>; adopted: Record<string, { signature: string; version: number; avgMs: number }> }

/** 物品“家族”：木头类（原木/木头/木板）互相可换，木棍也来自木头 */
export function family(name: string): string {
  if (/_(log|wood|stem|hyphae)$/.test(name) || /_planks$/.test(name) || name === 'stick' || name === 'log' || name === 'planks') return 'wood';
  return name;
}
const fam = (o: Record<string, number>) => new Set(Object.keys(o).filter((k) => o[k] > 0).map(family));

/** 合成时程序会自动补做的中间品：不单独成为做法里的一步 */
const AUTO_INTERMEDIATE = /^([a-z_]+_planks|stick)$/;

export class ExperienceMiner {
  private trace: TraceEntry[] = [];
  private lastInv: Record<string, number> = {};
  private data: Saved = { version: 1, episodes: {}, adopted: {} };

  constructor(private file: string | null, private adapter: GameAdapter, private memory: WorldMemory, private methods: MethodLibrary, private bus: EventBus) {
    if (file && fs.existsSync(file)) {
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d?.version === 1) this.data = { version: 1, episodes: d.episodes ?? {}, adopted: d.adopted ?? {} }; }
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
      const st = this.normalize(t, item, t === last);
      if (!st) continue;
      const v = SKILLS[st.skill]?.validate(st.args, this.adapter);
      if (!v?.ok) return null;
      steps.push({ skill: st.skill, args: v.args });
    }
    // 只是一步合成（材料早就在背包里）不算学到了做法
    if (steps.length < 2 || !steps.some((st) => st.skill !== 'craft')) return null;
    const durationMs = chain.reduce((n, t) => n + t.durationMs, 0);
    return { item, signature: JSON.stringify(steps), steps, durationMs, worldId: last.worldId, dimension: last.dim,
      contextKey: `${last.worldId}:${last.dim}:${Math.floor(last.pos.x / 16)}:${Math.floor(last.pos.z / 16)}`, ts: last.ts, before, after };
  }

  /** 把一步具体经历变成可复用的一步：数量按缺口算（for），木头不限种类 */
  private normalize(t: TraceEntry, item: string, isLast: boolean): SimpleStep | null {
    const a = t.args;
    switch (t.skill) {
      case 'gather': {
        const block = String(a.block ?? '');
        if (!block) return null;
        return { skill: 'gather', args: { block: /_(log|wood|stem)$/.test(block) ? 'log' : block, for: { item, count: 1 } } };
      }
      case 'explore': return { skill: 'explore', args: { direction: 'auto', distance: 48, until: String(a.until) } };
      case 'craft': {
        const it = String(a.item ?? '');
        if (!isLast && AUTO_INTERMEDIATE.test(it)) return null; // 合成时会自动补做
        return { skill: 'craft', args: { item: it, count: isLast ? 1 : Number(a.count ?? 1) } };
      }
      case 'smelt': return { skill: 'smelt', args: { ...a } };
      case 'hunt': return { skill: 'hunt', args: { ...(a.animal ? { animal: a.animal } : {}), count: 1 } };
      case 'take_items': return { skill: 'take_items', args: { ...a } };
      default: return null;
    }
  }

  private record(ep: Episode) {
    const list = (this.data.episodes[ep.item] ??= []);
    list.push(ep);
    if (list.length > 12) list.splice(0, list.length - 12);
    this.save();
    this.bus.publish('experience', 'P3', `记住了一次做成 ${ep.item} 的经过（${ep.steps.map((st) => st.skill).join(' → ')}，${Math.round(ep.durationMs / 1000)} 秒）`, { item: ep.item });
    this.consider(ep.item);
  }

  /** 同一做法在两个不同地方都做成过：采纳；已有做法时，只有明显更快才换 */
  private consider(item: string) {
    const groups = new Map<string, Episode[]>();
    for (const e of this.data.episodes[item] ?? []) {
      if (e.worldId !== this.memory.worldId) continue;
      (groups.get(e.signature) ?? groups.set(e.signature, []).get(e.signature)!).push(e);
    }
    const proven = [...groups.values()].map((eps) => {
      const byPlace = new Map(eps.map((e) => [e.contextKey, e]));
      return { eps: [...byPlace.values()], avgMs: eps.reduce((n, e) => n + e.durationMs, 0) / eps.length };
    }).filter((g) => g.eps.length >= 2).sort((a, b) => a.avgMs - b.avgMs);
    const best = proven[0];
    if (!best) return;
    const current = this.data.adopted[item];
    const signature = best.eps[0].signature;
    if (current?.signature === signature) {
      if (Math.abs(current.avgMs - best.avgMs) > 1000) { current.avgMs = Math.round(best.avgMs); this.save(); }
      return;
    }
    if (current && best.avgMs > current.avgMs * 0.75) return; // 没有明显更快：保留原来的做法
    const name = methodName(`get_${item}`);
    const steps = best.eps[0].steps;
    const secs = Math.round(best.avgMs / 1000);
    const description = `我自己的做法：做出 ${item}（${steps.map((st) => `${st.skill}${(st.args as any)?.block ? ` ${(st.args as any).block}` : (st.args as any)?.item ? ` ${(st.args as any).item}` : ''}`).join(' → ')}；做成过 ${best.eps.length} 次，平均 ${secs} 秒）`.slice(0, 230);
    const r = this.methods.adoptObserved({ name, description, program: { type: 'sequence', steps: steps.map((st) => ({ type: 'call', skill: st.skill, args: st.args ?? {} })) },
      postcondition: { type: 'inventory_gain', item, count: 1 } },
    best.eps.map((e) => ({ contextKey: e.contextKey, worldId: e.worldId, dimension: e.dimension, ts: e.ts, before: { [item]: e.before }, after: { [item]: e.after } })));
    if (!r.ok) { this.bus.publish('skill_rejected', 'P3', `想把做 ${item} 的经验固定成方法，但没成：${r.error}`); return; }
    if (r.status !== 'verified') return;
    // 换成更快的新做法：旧版本退役
    if (current) for (const old of this.methods.verifiedVersions(name)) if (old.version !== r.version) this.methods.retire(name, old.version, `有更快的做法 v${r.version}（平均 ${secs} 秒，原来约 ${Math.round(current.avgMs / 1000)} 秒）`);
    this.data.adopted[item] = { signature, version: r.version, avgMs: Math.round(best.avgMs) };
    this.save();
    const msg = current ? `找到了做 ${item} 更快的办法，换成 ${r.name}（平均 ${secs} 秒，原来约 ${Math.round(current.avgMs / 1000)} 秒）` : `从经历里学会了 ${r.name}：${description}`;
    this.bus.publish('skill_learned', 'P2', msg, { name: r.name, item, version: r.version });
    this.memory.addLesson(`要做 ${item} 时可以直接用 ${r.name}（自己做成过 ${best.eps.length} 次的做法，平均 ${secs} 秒）`, { source: 'observed', key: `method:${item}` });
  }
}
