import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SkillBook, type KnowSkill } from '../knowledge/skillbook.ts';
import { nextSkillVersion, normalizeSkillStates, validateBehavior, type BehaviorStats } from '../mind/behaviors.ts';

export interface LearnedSkillRepairOptions {
  dataDir: string;
  repairsDir: string;
  apply?: boolean;
  batchId?: string;
}

type CheckedDefinition = Exclude<ReturnType<typeof validateBehavior>, { error: string }>;
type ReceiptEntry = { name: string; expectedVersion: number; expectedHash: string; version: number; contentHash: string; retired: boolean; canTrial: boolean; snapshot: string };
type Receipt = { batchId: string; at: number; backupDir: string; entries: ReceiptEntry[]; normalized: string[]; backfilled: string[] };

/** Bind repairs to the exact original bytes, independently of repair-material edits. */
export function skillSourceHash(directory: string): string {
  const code = path.join(directory, 'code.js');
  return createHash('sha256').update(fs.readFileSync(path.join(directory, 'SKILL.md'))).update(Buffer.from([0]))
    .update(fs.existsSync(code) ? fs.readFileSync(code) : Buffer.alloc(0)).digest('hex');
}

function contentHash(definition: CheckedDefinition): string {
  const canonical = JSON.stringify({ name: definition.name, description: definition.description, body: definition.body, behavior: definition.behavior },
    (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Offline preflight is read-only; --apply installs unverified candidates and keeps every original. */
export function repairLearnedSkills(options: LearnedSkillRepairOptions) {
  const dataDir = path.resolve(options.dataDir), repairsDir = path.resolve(options.repairsDir);
  const batchId = options.batchId ?? path.basename(repairsDir);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(batchId)) throw new Error('batchId 只能包含英文、数字与连字符');
  const skillDirectory = path.join(dataDir, 'skills'), statsFile = path.join(dataDir, 'skill-stats.json');
  const statsText = fs.readFileSync(statsFile, 'utf8');
  const parsedStats: unknown = JSON.parse(statsText);
  if (!parsedStats || typeof parsedStats !== 'object' || Array.isArray(parsedStats)
    || Object.values(parsedStats).some((value) => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('技能统计不是有效的名称到统计记录映射');
  const stats = structuredClone(parsedStats) as Record<string, BehaviorStats>;
  const book = new SkillBook(null, skillDirectory);
  const receiptFile = path.join(dataDir, 'skill-repair-receipts', `${batchId}.json`);
  const receiptValue: unknown = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  let receipt: Receipt | null = null;
  if (receiptValue !== null) {
    if (!receiptValue || typeof receiptValue !== 'object' || Array.isArray(receiptValue)) throw new Error('修复回执格式无效');
    const value = receiptValue as Record<string, unknown>;
    if (value.batchId !== batchId || !Array.isArray(value.entries) || value.entries.some((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const item = entry as Record<string, unknown>;
      return typeof item.name !== 'string' || typeof item.expectedVersion !== 'number' || typeof item.expectedHash !== 'string'
        || typeof item.version !== 'number' || typeof item.contentHash !== 'string';
    })) throw new Error('修复回执的批次或条目无效');
    receipt = receiptValue as Receipt;
  }
  const files = fs.readdirSync(repairsDir).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) throw new Error('修复材料目录没有 JSON 文件');
  const names = new Set<string>();
  const plan = files.map((file) => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(repairsDir, file), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} 须为修复对象`);
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.name !== 'string' || file !== `${raw.name}.json` || !/^[a-z][a-z0-9-]{1,40}$/.test(raw.name)
      || typeof raw.expectedVersion !== 'number' || !Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 1
      || typeof raw.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedHash)
      || (raw.description !== undefined && typeof raw.description !== 'string') || typeof raw.body !== 'string' || !raw.body.trim()
      || !raw.behavior || typeof raw.behavior !== 'object' || Array.isArray(raw.behavior)) throw new Error(`${file} 的名称、版本、原始 hash 或完整契约无效`);
    if (names.has(raw.name)) throw new Error(`修复名称重复：${raw.name}`);
    names.add(raw.name);
    const current = book.get(raw.name);
    if (!current?.behavior || typeof current.behavior !== 'object') throw new Error(`${raw.name} 缺少原技能，拒绝新造技能`);
    const checked = validateBehavior({ ...raw.behavior, name: raw.name, description: raw.description ?? current.description, body: raw.body });
    if ('error' in checked) throw new Error(`${raw.name} 未通过离线验收：${checked.error}`);
    if (checked.disable || !checked.behavior.code || !checked.behavior.verify) throw new Error(`${raw.name} 修复材料须包含代码和观测验收，不能代替启停指令`);
    const hash = contentHash(checked);
    const previous = receipt?.entries.find((entry) => entry.name === raw.name);
    if (previous) {
      if (previous.expectedHash !== raw.expectedHash || previous.expectedVersion !== raw.expectedVersion || previous.contentHash !== hash) throw new Error(`${raw.name} 已安装后的修复材料发生变化，拒绝覆盖`);
      const installed = [book.candidate(raw.name), current].find((entry) => entry && (entry.behavior as Record<string, unknown>).version === previous.version);
      if (!installed) throw new Error(`${raw.name} 已安装版本不存在或已被其他版本替换，拒绝重做旧修复`);
      const restored = validateBehavior({ ...installed.behavior as Record<string, unknown>, name: installed.name, description: installed.description,
        body: installed.body.replace(/```behavior[\s\S]*?```/, '').trim() });
      if ('error' in restored || contentHash(restored) !== hash) throw new Error(`${raw.name} 已安装内容发生变化，拒绝覆盖`);
      return { checked, entry: previous, installed: true, original: current };
    }
    if (receipt) throw new Error(`${raw.name} 不在已完成批次回执中，拒绝扩充旧批次`);
    const originalVersion = Number((current.behavior as Record<string, unknown>).version)
      || (typeof (current.behavior as Record<string, unknown>).code === 'string' ? 1 : stats[raw.name]?.rev ?? 1);
    if (originalVersion !== raw.expectedVersion) throw new Error(`${raw.name} 原版本已变化：预期 v${raw.expectedVersion}，当前 v${originalVersion}`);
    const directory = path.join(skillDirectory, raw.name);
    if (skillSourceHash(directory) !== raw.expectedHash) throw new Error(`${raw.name} 原始内容 hash 已变化，拒绝覆盖`);
    if (book.candidate(raw.name)) throw new Error(`${raw.name} 已有未记录的候选，拒绝覆盖；请先审查现有候选`);
    const retired = !!stats[raw.name]?.retired;
    const version = nextSkillVersion(book, raw.name, stats[raw.name]);
    const standardSnapshot = path.join(directory, 'versions', `v${originalVersion}.json`);
    const snapshot = fs.existsSync(standardSnapshot)
      ? path.join(directory, 'versions', `before-repair-v${originalVersion}-${raw.expectedHash.slice(0, 12)}.json`) : standardSnapshot;
    const entry = { name: raw.name, expectedVersion: originalVersion, expectedHash: raw.expectedHash, version, contentHash: hash,
      retired, canTrial: !retired && !stats[raw.name]?.disabled, snapshot };
    return { checked, entry, installed: false, original: current };
  });
  if (receipt && receipt.entries.length !== plan.length) throw new Error('修复材料条目数量与已完成回执不一致');
  const normalized = normalizeSkillStates(stats);
  const backfilled = Object.entries(stats).flatMap(([name, st]) => {
    const at = Math.max(st.lastAt ?? 0, ...(st.recent ?? []).map((run) => run.at));
    if (!Number.isFinite(at) || at <= (st.lastUsedAt ?? 0)) return [];
    st.lastUsedAt = at;
    return [name];
  });
  const pending = plan.filter((item) => !item.installed);
  const summary = { apply: options.apply === true, batchId, entries: plan.map(({ entry, installed }) => ({ ...entry, status: installed ? 'installed' : 'candidate' })),
    normalized: receipt ? [] : normalized, backfilled: receipt ? [] : backfilled, receiptFile };
  if (!options.apply || receipt) return summary;
  // Recheck every original and the statistics together before the first write.
  if (fs.readFileSync(statsFile, 'utf8') !== statsText || pending.some(({ entry }) => skillSourceHash(path.join(skillDirectory, entry.name)) !== entry.expectedHash)) throw new Error('预检后技能或统计发生变化，请停止 Agent 后重新预检');
  const at = Date.now();
  const backupDir = path.join(dataDir, 'skill-repair-backups', `${batchId}-${at}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(backupDir, 'skills'), { recursive: true });
  fs.copyFileSync(statsFile, path.join(backupDir, 'skill-stats.json'));
  for (const { entry } of pending) fs.cpSync(path.join(skillDirectory, entry.name), path.join(backupDir, 'skills', entry.name), { recursive: true, errorOnExist: true, force: false });
  for (const { checked, entry, original } of pending) {
    const snapshot: KnowSkill = { ...original, behavior: { ...original.behavior as Record<string, unknown>, version: entry.expectedVersion } };
    fs.mkdirSync(path.dirname(entry.snapshot), { recursive: true });
    fs.writeFileSync(entry.snapshot, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    const saved = book.write(checked.name, checked.description, checked.body, checked.behavior, { candidate: true, version: entry.version });
    if (!saved.ok) throw new Error(`${entry.name} 写候选失败；原数据备份在 ${backupDir}：${saved.error}`);
    const st = stats[entry.name] ??= { fired: 0, ok: 0, fail: 0, lastAt: 0 };
    st.disabled = true;
    st.disabledAt ??= at;
    if (entry.canTrial) st.candidatePermit = entry.version;
    else delete st.candidatePermit;
  }
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 1) + '\n');
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  const savedReceipt: Receipt = { batchId, at, backupDir, entries: plan.map((item) => item.entry), normalized, backfilled };
  fs.writeFileSync(receiptFile, JSON.stringify(savedReceipt, null, 2) + '\n', { flag: 'wx' });
  return { ...summary, backupDir };
}
