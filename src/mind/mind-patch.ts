import fs from 'node:fs';
import path from 'node:path';

/** Apply an explicit correction before SelfModel loads, preserving the original patch as a receipt. */
export function applyMindPatch(directory: string): string | null {
  const patchFile = path.join(directory, 'mind-patch.json');
  if (!fs.existsSync(patchFile)) return null;
  const patch: unknown = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
  if (!patch || typeof patch !== 'object' || !('id' in patch) || !('expectedText' in patch) || !('text' in patch)
    || typeof patch.id !== 'string' || !patch.id || typeof patch.expectedText !== 'string' || !patch.expectedText
    || typeof patch.text !== 'string' || !patch.text.trim()) throw new Error('mind-patch.json 需要 id、expectedText 和 text');

  const mindFile = path.join(directory, 'mind.json');
  const mind: unknown = JSON.parse(fs.readFileSync(mindFile, 'utf8'));
  if (!mind || typeof mind !== 'object' || !('version' in mind) || mind.version !== 1 || !('knowHow' in mind) || !Array.isArray(mind.knowHow)) {
    throw new Error('mind.json 格式不正确');
  }
  const entries: unknown[] = mind.knowHow;
  const entry = entries.find((item): item is Record<string, unknown> => !!item && typeof item === 'object' && 'id' in item && item.id === patch.id);
  if (!entry || entry.text !== patch.expectedText) throw new Error(`窍门 ${patch.id} 不存在或原文已改变，未套用补丁`);
  entry.text = patch.text;
  entry.wins = 0;
  entry.losses = 0;
  entry.unverified = true;
  delete entry.signature;
  fs.writeFileSync(mindFile + '.tmp', JSON.stringify(mind));
  fs.renameSync(mindFile + '.tmp', mindFile);
  fs.renameSync(patchFile, path.join(directory, `mind-patch.applied-${Date.now()}.json`));
  return `已修正窍门 ${patch.id}；原成败记录不再用于验证新文字`;
}
