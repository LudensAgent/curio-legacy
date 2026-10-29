import fs from 'node:fs';
import path from 'node:path';

/**
 * 运行时禁用的内置技能名：在 dashboard 手动禁用后，立即从 LLM 可见目录和执行入口消失，
 * 并持久化到 disabled-skills.json（重启后仍禁用，直到手动启用）。
 * 自学技能（行为 code skills）不在这里管，它们走 behaviors 引擎的 retire/restore。
 */
const disabled = new Set<string>();
let dataDir: string | null = null;

export function isSkillDisabled(name: string): boolean {
  return disabled.has(name);
}

export function disabledSkills(): string[] {
  return [...disabled].sort();
}

/** 启动时读入已禁用的技能；读不到或损坏就当作没有。 */
export function loadDisabledSkills(dir: string): string[] {
  dataDir = dir;
  disabled.clear();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'disabled-skills.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.skills) ? (raw as any).skills : [];
    for (const name of list) if (typeof name === 'string' && name.trim()) disabled.add(name.trim());
  } catch { /* 首次运行或文件损坏：没有禁用项 */ }
  return disabledSkills();
}

/** 打开/关闭一个内置技能的禁用；返回是否有变化。 */
export function setSkillDisabled(name: string, on: boolean): boolean {
  const changed = on ? !disabled.has(name) : disabled.delete(name);
  if (changed && dataDir) save();
  return changed;
}

function save() {
  if (!dataDir) return;
  try { fs.writeFileSync(path.join(dataDir, 'disabled-skills.json'), JSON.stringify(disabledSkills(), null, 2)); } catch { /* ignore */ }
}
