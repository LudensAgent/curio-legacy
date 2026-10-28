import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { repairLearnedSkills, skillSourceHash } from '../src/maintenance/learned-skills.ts';

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-repair-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data'), repairsDir = path.join(directory, 'repairs', '2026-10-28');
  fs.mkdirSync(repairsDir, { recursive: true });
  const book = new SkillBook(null, path.join(dataDir, 'skills'));
  for (const name of ['alpha-active', 'beta-retired']) {
    assert.ok(book.write(name, '原有移动做法', '原有目标和停止条件', { code: 'return {old:true};', verify: 'const s=await api.state(); return s.hp>0;' }).ok);
    const material = { name, expectedVersion: 1, expectedHash: skillSourceHash(path.join(dataDir, 'skills', name)), description: '修复原有移动反馈', body: '按原有委托移动，移动后立即停止并对照实际位置。',
      behavior: { code: 'await api.move({forward:true},50); return {moved:true};', verify: 'const s=await api.state(); return Math.hypot(s.pos.x-args.before.pos.x,s.pos.z-args.before.pos.z)>0.01;' } };
    fs.writeFileSync(path.join(repairsDir, `${name}.json`), JSON.stringify(material));
  }
  const originalStats = {
    'alpha-active': { fired: 0, ok: 0, fail: 0, lastAt: 0, writtenAt: 999 },
    'beta-retired': { fired: 1, ok: 2, fail: 7, lastAt: 100, retired: '已经合并', retiredAt: 400, disabled: false, candidatePermit: 1,
      byVersion: { '1': { ok: 2, fail: 7 } }, recent: [{ at: 300, ok: false, version: 1, summary: '真实历史失败' }] },
    'unrelated-history': { fired: 1, ok: 4, fail: 5, lastAt: 200, retired: '历史收起原因', disabled: false },
  };
  const statsFile = path.join(dataDir, 'skill-stats.json');
  fs.writeFileSync(statsFile, JSON.stringify(originalStats));
  return { dataDir, repairsDir, statsFile, originalStats };
}

test('默认只读，显式应用完整备份并仅安装候选，启用与退休状态分开处理', (t) => {
  const w = setup(t);
  const before = fs.readFileSync(w.statsFile, 'utf8');
  const dry = repairLearnedSkills(w);
  assert.equal(dry.apply, false);
  assert.equal(fs.readFileSync(w.statsFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(w.dataDir, 'skills', 'alpha-active', 'candidate.json')), false);
  assert.equal(fs.existsSync(path.join(w.dataDir, 'skill-repair-backups')), false);
  const applied = repairLearnedSkills({ ...w, apply: true });
  assert.ok('backupDir' in applied);
  assert.equal(fs.readFileSync(path.join(applied.backupDir!, 'skill-stats.json'), 'utf8'), before);
  const stats = JSON.parse(fs.readFileSync(w.statsFile, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.equal(stats['alpha-active'].disabled, true);
  assert.equal(stats['alpha-active'].candidatePermit, 2);
  assert.equal(stats['alpha-active'].lastUsedAt, undefined, '写下技能的时间不能伪装成实际使用时间');
  assert.equal(stats['beta-retired'].disabled, true);
  assert.equal(stats['beta-retired'].retired, '已经合并');
  assert.equal(stats['beta-retired'].candidatePermit, undefined);
  assert.equal(stats['beta-retired'].lastUsedAt, 300);
  assert.deepEqual(stats['beta-retired'].byVersion, w.originalStats['beta-retired'].byVersion);
  assert.deepEqual(stats['beta-retired'].recent, w.originalStats['beta-retired'].recent);
  assert.equal(stats['unrelated-history'].disabled, true);
  assert.equal(stats['unrelated-history'].retired, '历史收起原因');
  const book = new SkillBook(null, path.join(w.dataDir, 'skills'));
  assert.equal((book.get('alpha-active')?.behavior as { version: number }).version, 1);
  assert.equal((book.candidate('alpha-active')?.behavior as { version: number }).version, 2);
  assert.equal((book.definitionVersion('alpha-active', 1)?.behavior as { version: number }).version, 1);
  assert.ok(fs.existsSync(applied.receiptFile));
});

test('重复应用一致内容会跳过，修改素材或已装候选均拒绝覆盖', (t) => {
  const w = setup(t);
  repairLearnedSkills({ ...w, apply: true });
  const before = fs.readFileSync(w.statsFile, 'utf8');
  const repeated = repairLearnedSkills({ ...w, apply: true });
  assert.ok(repeated.entries.every((entry) => entry.status === 'installed'));
  assert.equal(fs.readdirSync(path.join(w.dataDir, 'skill-repair-backups')).length, 1);
  assert.equal(fs.readFileSync(w.statsFile, 'utf8'), before);
  const materialFile = path.join(w.repairsDir, 'alpha-active.json');
  const materialText = fs.readFileSync(materialFile, 'utf8');
  const material = JSON.parse(materialText) as { body: string };
  material.body = '被修改后的目标说明';
  fs.writeFileSync(materialFile, JSON.stringify(material));
  assert.throws(() => repairLearnedSkills({ ...w, apply: true }), /修复材料发生变化/);
  fs.writeFileSync(materialFile, materialText);
  const candidateFile = path.join(w.dataDir, 'skills', 'alpha-active', 'candidate.json');
  const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8')) as { behavior: { code: string } };
  candidate.behavior.code = 'return {changed:true};';
  fs.writeFileSync(candidateFile, JSON.stringify(candidate));
  assert.throws(() => repairLearnedSkills({ ...w, apply: true }), /已安装内容发生变化/);
  assert.equal(fs.readFileSync(w.statsFile, 'utf8'), before);
});

test('整批版本、hash与代码验收在任何写入之前完成', (t) => {
  const w = setup(t);
  const before = fs.readFileSync(w.statsFile, 'utf8');
  const materialFile = path.join(w.repairsDir, 'beta-retired.json');
  const material = JSON.parse(fs.readFileSync(materialFile, 'utf8')) as { expectedVersion: number; expectedHash: string; behavior: { code: string } };
  material.expectedVersion = 2;
  fs.writeFileSync(materialFile, JSON.stringify(material));
  assert.throws(() => repairLearnedSkills({ ...w, apply: true }), /原版本已变化/);
  material.expectedVersion = 1;
  fs.writeFileSync(materialFile, JSON.stringify(material));
  const changedSource = path.join(w.dataDir, 'skills', 'beta-retired', 'SKILL.md');
  fs.appendFileSync(changedSource, '\n');
  const changedBytes = fs.readFileSync(changedSource, 'utf8');
  assert.throws(() => repairLearnedSkills({ ...w, apply: true }), /hash 已变化/);
  assert.equal(fs.readFileSync(changedSource, 'utf8'), changedBytes);
  material.behavior.code = 'await api.noSuchMethod();';
  fs.writeFileSync(materialFile, JSON.stringify(material));
  assert.throws(() => repairLearnedSkills({ ...w, apply: true }), /未通过离线验收/);
  assert.equal(fs.readFileSync(w.statsFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(w.dataDir, 'skills', 'alpha-active', 'candidate.json')), false);
  assert.equal(fs.existsSync(path.join(w.dataDir, 'skill-repair-backups')), false);
});
