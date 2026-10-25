import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 技能书：一份份写成 Markdown 的“做法和原则”（SKILL.md），像现在的 agent 那样按需加载：
 * 平时只把每份的名字和一句用途放进提示词，真要用时再把全文读进这一次思考。
 *
 * - 内置技能放在仓库的 skills/<名字>/SKILL.md（你可以自己添加、修改）；
 * - 自己写的技能放在 data/skills/<名字>/SKILL.md：回想时总结出一套成体系的做法，就写成一份，下次直接查。
 */
export interface KnowSkill { name: string; description: string; body: string; source: 'builtin' | 'self'; file: string; updatedAt: number }

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
export const BUILTIN_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');

export function parseSkillMarkdown(text: string): { name?: string; description?: string; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: meta.name, description: meta.description, body: m[2].trim() };
}

export class SkillBook {
  private skills = new Map<string, KnowSkill>();
  constructor(private builtinDir: string | null = BUILTIN_SKILLS_DIR, private selfDir: string | null = null) { this.reload(); }

  reload() {
    this.skills.clear();
    for (const [dir, source] of [[this.builtinDir, 'builtin'], [this.selfDir, 'self']] as const) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = parseSkillMarkdown(fs.readFileSync(file, 'utf8'));
          const name = (parsed.name ?? entry.name).trim();
          if (!NAME.test(name) || !parsed.body) continue;
          // 内置的同名技能优先：自己写的不能悄悄覆盖人写的说明
          if (source === 'self' && this.skills.get(name)?.source === 'builtin') continue;
          this.skills.set(name, { name, description: (parsed.description ?? '').slice(0, 200), body: parsed.body.slice(0, 12000), source, file, updatedAt: fs.statSync(file).mtimeMs });
        } catch { /* 读不了的技能跳过 */ }
      }
    }
  }

  list(): KnowSkill[] { return [...this.skills.values()].sort((a, b) => Number(a.source === 'self') - Number(b.source === 'self') || a.name.localeCompare(b.name)); }
  get(name: string): KnowSkill | undefined { return this.skills.get(name); }
  /** 提示词里的索引：每份一行 */
  index(): string[] { return this.list().map((s) => `${s.name}${s.source === 'self' ? '（我自己写的）' : ''}：${s.description}`); }

  /** 写一份自己的技能（或修订自己写过的）；不能改内置技能 */
  write(name: string, description: string, body: string): { ok: true; skill: KnowSkill; created: boolean } | { ok: false; error: string } {
    if (!this.selfDir) return { ok: false, error: '没有地方保存自己写的技能' };
    const n = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!NAME.test(n)) return { ok: false, error: '技能名只能用小写英文、数字和连字符（2–41 个字符）' };
    if (this.skills.get(n)?.source === 'builtin') return { ok: false, error: `${n} 是内置技能，不能改；换个名字写自己的版本` };
    const desc = description.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const text = body.trim().slice(0, 6000);
    if (desc.length < 4 || text.length < 20) return { ok: false, error: '技能需要一句用途说明和至少几行做法' };
    const created = !this.skills.has(n);
    const dir = path.join(this.selfDir, n);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, `---\nname: ${n}\ndescription: ${desc}\n---\n\n${text}\n`);
    const skill: KnowSkill = { name: n, description: desc, body: text, source: 'self', file, updatedAt: Date.now() };
    this.skills.set(n, skill);
    return { ok: true, skill, created };
  }
}
