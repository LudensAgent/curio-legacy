import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 技能书：一份份写成 Markdown 的“做法和原则”（SKILL.md），像现在的 agent 那样按需加载：
 * 平时只把每份的名字和一句用途放进提示词，真要用时再把全文读进这一次思考。
 *
 * - 内置技能放在仓库的 skills/<名字>/SKILL.md（你可以自己添加、修改）；
 * - 自己写的技能放在 data/skills/<名字>/SKILL.md：从经历里总结出一套做法，就写成一份，下次直接用。
 *
 * 一份技能可以只是“知识”（正文），也可以带一段 ```behavior JSON：触发条件 + 动作步骤。
 * 模型写出的 behavior 先保存候选；显式试用验收后再启用（见 mind/behaviors.ts）。
 */
export type SkillMode = 'auto' | 'recover' | 'manual';
export interface KnowSkill {
  name: string; description: string; body: string; source: 'builtin' | 'self'; file: string; updatedAt: number;
  /** 学习笔记独立于执行契约，修订、晋升和回退不覆盖它。 */
  notes?: string;
  /** 正文里 ```behavior 块的原始 JSON（校验交给行为引擎） */
  behavior?: unknown;
  /** auto：条件成立自动做；recover：某个动作失败时先试；manual：只在 routine 里 use_skill 调用 */
  mode?: SkillMode;
}

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
export const BUILTIN_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
const BEHAVIOR_BLOCK = /```behavior\s*\n([\s\S]*?)\n```/;

export function parseSkillMarkdown(text: string): { name?: string; description?: string; body: string } {
  const m = text.replace(/\r\n/g, '\n').match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { body: text.replace(/\r\n/g, '\n').trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: meta.name, description: meta.description, body: m[2].trim() };
}

/** 正文里的 behavior 块；没有或不是合法 JSON 时为 undefined */
export function behaviorOf(body: string): unknown {
  const m = body.match(BEHAVIOR_BLOCK);
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return undefined; }
}

export function modeOf(behavior: unknown): SkillMode | undefined {
  if (!behavior || typeof behavior !== 'object') return undefined;
  const when = (behavior as Record<string, unknown>).when;
  if (!when) return 'manual';
  return JSON.stringify(when).includes('"after_failure"') ? 'recover' : 'auto';
}

const MODE_LABEL: Record<SkillMode, string> = { auto: '条件成立自动做', recover: '动作失败时先试', manual: '用 use_skill 调用' };

export class SkillBook {
  private skills = new Map<string, KnowSkill>();
  private candidates = new Map<string, KnowSkill>();
  private listeners = new Set<() => void>();
  constructor(private builtinDir: string | null = BUILTIN_SKILLS_DIR, private selfDir: string | null = null) { this.reload(); }

  /** 技能变了（新写、修订、重新加载）时通知：行为引擎据此立刻换上新的做法 */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { for (const fn of this.listeners) { try { fn(); } catch { /* 监听者出错不影响技能书 */ } } }

  reload() {
    this.skills.clear();
    this.candidates.clear();
    for (const [dir, source] of [[this.builtinDir, 'builtin'], [this.selfDir, 'self']] as const) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'SKILL.md');
        const candidateFile = path.join(dir, entry.name, 'candidate.json');
        const notesFile = path.join(dir, entry.name, 'NOTES.md');
        const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : undefined;
        if (source === 'self' && fs.existsSync(candidateFile)) {
          try {
            const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8')) as { name: string; description: string; body: string; behavior: Record<string, unknown> };
            if (candidate.name === entry.name && NAME.test(candidate.name) && typeof candidate.description === 'string' && typeof candidate.body === 'string' && candidate.behavior && typeof candidate.behavior === 'object') {
              this.candidates.set(candidate.name, { ...candidate, notes, source, file: candidateFile, updatedAt: fs.statSync(candidateFile).mtimeMs, mode: modeOf(candidate.behavior) });
            }
          } catch { /* 损坏的候选不影响稳定技能加载 */ }
        }
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = parseSkillMarkdown(fs.readFileSync(file, 'utf8'));
          const name = (parsed.name ?? entry.name).trim();
          if (!NAME.test(name) || !parsed.body) continue;
          // 内置的同名技能优先：自己写的不能悄悄覆盖人写的说明；只有代码技能可以被改进出新版本
          const builtin = this.skills.get(name);
          if (source === 'self' && builtin?.source === 'builtin' && !hasCode(builtin.behavior)) continue;
          let behavior = behaviorOf(parsed.body);
          const codeFile = path.join(dir, entry.name, 'code.js');
          if (fs.existsSync(codeFile) && !(behavior && typeof behavior === 'object' && 'steps' in behavior)) behavior = { ...(behavior && typeof behavior === 'object' ? behavior : {}), code: fs.readFileSync(codeFile, 'utf8') };
          this.skills.set(name, { name, description: (parsed.description ?? '').slice(0, 200), body: parsed.body.slice(0, 12000), notes, source, file, updatedAt: fs.statSync(file).mtimeMs,
            ...(behavior !== undefined ? { behavior, mode: modeOf(behavior) } : {}) });
        } catch { /* 读不了的技能跳过 */ }
      }
    }
    this.changed();
  }

  /** 代码技能某个旧版本的代码（退回用） */
  codeVersion(name: string, version: number): string | null {
    const k = this.skills.get(name) ?? this.candidates.get(name);
    if (!k) return null;
    const file = path.join(path.dirname(k.file), 'versions', `v${version}.js`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    // 内置技能的第 1 版就是仓库里的 code.js
    if (version === 1 && this.builtinDir) { const f = path.join(this.builtinDir, name, 'code.js'); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); }
    return null;
  }

  /** 完整版本用于回退；只有旧代码、没有契约的历史不能冒充完整版本。 */
  definitionVersion(name: string, version: number): KnowSkill | null {
    const k = this.skills.get(name) ?? this.candidates.get(name);
    if (!k) return null;
    const file = path.join(path.dirname(k.file), 'versions', `v${version}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as KnowSkill : null;
  }

  list(): KnowSkill[] { return [...new Map([...this.candidates, ...this.skills]).values()].sort((a, b) => Number(a.source === 'self') - Number(b.source === 'self') || a.name.localeCompare(b.name)); }
  get(name: string): KnowSkill | undefined { return this.skills.get(name) ?? this.candidates.get(name); }
  candidate(name: string): KnowSkill | undefined { return this.candidates.get(name); }
  pending(): KnowSkill[] { return [...this.candidates.values()]; }
  /** 保存过的完整契约和旧代码；只有代码的历史不能当成完整契约。 */
  versions(name: string): { version: number; definition: boolean; code: boolean }[] {
    const skill = this.skills.get(name) ?? this.candidates.get(name);
    if (!skill) return [];
    const directory = path.join(path.dirname(skill.file), 'versions');
    if (!fs.existsSync(directory)) return [];
    const versions = new Map<number, { version: number; definition: boolean; code: boolean }>();
    for (const entry of fs.readdirSync(directory)) {
      const match = /^v([1-9]\d*)\.(json|js)$/.exec(entry);
      if (!match) continue;
      const version = Number(match[1]);
      const record = versions.get(version) ?? { version, definition: false, code: false };
      if (match[2] === 'json') record.definition = true; else record.code = true;
      versions.set(version, record);
    }
    return [...versions.values()].sort((a, b) => a.version - b.version);
  }
  versionCeiling(name: string): number {
    const current = this.skills.get(name), candidate = this.candidates.get(name);
    const file = current?.file ?? candidate?.file;
    const directory = file ? path.join(path.dirname(file), 'versions') : this.selfDir ? path.join(this.selfDir, name, 'versions') : null;
    const archived = directory && fs.existsSync(directory) ? fs.readdirSync(directory).flatMap((entry) => {
      const matched = /^v([1-9]\d*)\.(?:json|js)$/.exec(entry);
      return matched ? [Number(matched[1])] : [];
    }) : [];
    return Math.max(0, Number((current?.behavior as Record<string, unknown> | undefined)?.version) || (current?.behavior ? 1 : 0),
      Number((candidate?.behavior as Record<string, unknown> | undefined)?.version) || 0, ...archived);
  }
  promote(name: string, previousVersion?: number): boolean {
    const candidate = this.candidates.get(name);
    if (!candidate) return false;
    const behavior = { ...candidate.behavior as Record<string, unknown>, candidate: undefined };
    const r = this.write(name, candidate.description, candidate.body, behavior, { version: Number((candidate.behavior as Record<string, unknown>).version), previousVersion });
    if (!r.ok) return false;
    return true;
  }
  /** 提示词里的索引：每份一行 */
  index(skip?: (name: string) => boolean, executionError?: (name: string, trial: boolean) => string | null): string[] {
    return this.list().filter((s) => !skip?.(s.name)).map((s) => {
      const candidate = this.candidates.get(s.name);
      const status: string[] = [];
      if (s !== candidate) {
        if (s.behavior === undefined) status.push(/```behavior(?:\s|$)/.test(s.body)
          ? '行为定义格式无效，不能用 use_skill 直接执行' : '仅文字记录，先阅读，不能用 use_skill 直接执行');
        else if (!executionError) status.push(`未确认是否可执行${s.mode ? `，声明方式：${MODE_LABEL[s.mode]}` : ''}`);
        else {
          const error = executionError(s.name, false);
          status.push(error ? `不可执行：${error}` : `可执行${s.mode ? `，${MODE_LABEL[s.mode]}` : ''}`);
        }
      }
      if (candidate) {
        const error = executionError?.(s.name, true);
        status.push(!executionError ? '候选，尚未确认能否试用' : error ? `候选不可试用：${error}` : '候选，用 use_skill trial:true 试用');
      }
      return `${s.name}${s.source === 'self' ? '（我自己写的）' : ''}：［${status.join('；')}］${s.description}`;
    });
  }

  /** 写一份自己的技能（或修订自己写过的）；不能改内置技能。behavior 是已经校验过的触发条件和步骤 */
  write(name: string, description: string, body: string, behavior?: unknown, opts: { candidate?: boolean; version?: number; previousVersion?: number } = {}): { ok: true; skill: KnowSkill; created: boolean } | { ok: false; error: string } {
    if (!this.selfDir) return { ok: false, error: '没有地方保存自己写的技能' };
    const n = normalizeSkillName(name);
    if (!NAME.test(n)) return { ok: false, error: '技能名只能用小写英文、数字和连字符（2–41 个字符）' };
    const prev = this.skills.get(n);
    if (prev?.source === 'builtin' && !(hasCode(prev.behavior) && hasCode(behavior))) return { ok: false, error: `${n} 是内置技能，不能改；换个名字写自己的版本` };
    const desc = description.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    let text = body.replace(/\r\n/g, '\n').replace(BEHAVIOR_BLOCK, '').trim().slice(0, 6000);
    const pending = this.candidates.get(n);
    const dir = path.join(this.selfDir, n);
    const notesFile = path.join(dir, 'NOTES.md');
    if (behavior === undefined && (prev?.behavior !== undefined || pending)) {
      if (desc.length < 4 || text.length < 20) return { ok: false, error: '技能需要一句用途说明和至少几行做法' };
      fs.writeFileSync(notesFile, text + '\n');
      if (prev) this.skills.set(n, { ...prev, notes: text });
      if (pending) this.candidates.set(n, { ...pending, notes: text });
      this.changed();
      return { ok: true, skill: this.get(n)!, created: false };
    }
    // 代码单独存成 code.js（换下来的旧版本留在 versions/ 里，退回时用）
    const code = hasCode(behavior) ? String((behavior as Record<string, unknown>).code) : null;
    const previousVersion = opts.previousVersion ?? (Number((prev?.behavior as Record<string, unknown> | undefined)?.version) || 1);
    const version = opts.version ?? Math.max(this.versionCeiling(n), prev?.behavior ? previousVersion : 0) + 1;
    const definition = behavior && typeof behavior === 'object' ? { ...behavior, version, ...(opts.candidate ? { candidate: true } : {}) } : undefined;
    const meta = code ? { ...definition, code: undefined, code_file: 'code.js' } : definition;
    if (meta !== undefined) text = `${text}${text ? '\n\n' : ''}\`\`\`behavior\n${JSON.stringify(meta, null, 1)}\n\`\`\``;
    if (desc.length < 4 || text.length < 20) return { ok: false, error: '技能需要一句用途说明和至少几行做法' };
    const created = !prev;
    fs.mkdirSync(dir, { recursive: true });
    // 纯文字做法后来获得执行契约时，原笔记继续保留。
    const notes = prev?.notes ?? pending?.notes ?? (behavior !== undefined && prev?.behavior === undefined ? prev?.body : undefined);
    if (notes) {
      fs.writeFileSync(notesFile, notes + '\n');
      if (prev) this.skills.set(n, { ...prev, notes });
    }
    if (opts.candidate) {
      const file = path.join(dir, 'candidate.json');
      const old = this.candidates.get(n);
      if (old) {
        fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'versions', `v${(old.behavior as Record<string, unknown>).version}.json`), JSON.stringify(old, null, 1));
      }
      const skill: KnowSkill = { name: n, description: desc, body: text, notes, source: 'self', file, updatedAt: Date.now(), behavior: definition, mode: modeOf(definition) };
      fs.writeFileSync(file, JSON.stringify({ name: n, description: desc, body: text, behavior: definition }, null, 1));
      this.candidates.set(n, skill);
      this.changed();
      return { ok: true, skill, created };
    }
    const file = path.join(dir, 'SKILL.md');
    if (prev?.behavior) {
      fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
      const snapshot = { ...prev, behavior: { ...prev.behavior as Record<string, unknown>, version: previousVersion } };
      fs.writeFileSync(path.join(dir, 'versions', `v${previousVersion}.json`), JSON.stringify(snapshot, null, 1));
    }
    if (code) {
      const codeFile = path.join(dir, 'code.js');
      const old = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8') : hasCode(prev?.behavior) ? String((prev!.behavior as any).code) : null;
      if (old !== null && prev?.behavior) { fs.mkdirSync(path.join(dir, 'versions'), { recursive: true }); fs.writeFileSync(path.join(dir, 'versions', `v${previousVersion}.js`), old); }
      fs.writeFileSync(codeFile, code);
    } else if (fs.existsSync(path.join(dir, 'code.js'))) {
      fs.unlinkSync(path.join(dir, 'code.js'));
    }
    fs.writeFileSync(file, `---\nname: ${n}\ndescription: ${desc}\n---\n\n${text}\n`);
    const stored = code ? { ...(meta as Record<string, unknown>), code } : definition;
    const skill: KnowSkill = { name: n, description: desc, body: text, notes, source: 'self', file, updatedAt: Date.now(),
      ...(stored !== undefined ? { behavior: stored, mode: modeOf(stored) } : {}) };
    this.skills.set(n, skill);
    if (pending) {
      fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'versions', `v${(pending.behavior as Record<string, unknown>).version}.json`), JSON.stringify(pending, null, 1));
      fs.unlinkSync(pending.file);
      this.candidates.delete(n);
    }
    this.changed();
    return { ok: true, skill, created };
  }
}

export const hasCode = (behavior: unknown) => !!behavior && typeof behavior === 'object' && typeof (behavior as Record<string, unknown>).code === 'string';

export const normalizeSkillName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
