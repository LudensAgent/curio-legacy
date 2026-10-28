import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { repairLearnedSkills } from '../src/maintenance/learned-skills.ts';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--apply' && arg !== '--dry-run' && !arg.startsWith('--data-dir=') && !arg.startsWith('--repairs-dir='));
if (unknown.length || args.includes('--apply') && args.includes('--dry-run')) throw new Error('用法：repair-learned-skills.ts [--apply|--dry-run] [--data-dir=路径] [--repairs-dir=路径]；执行 --apply 前先停止 Agent');
const result = repairLearnedSkills({
  dataDir: path.resolve(args.find((arg) => arg.startsWith('--data-dir='))?.slice('--data-dir='.length) || config.dataDir),
  repairsDir: path.resolve(args.find((arg) => arg.startsWith('--repairs-dir='))?.slice('--repairs-dir='.length) || path.join(projectDir, 'maintenance', 'skill-repairs', '2026-10-28')),
  apply: args.includes('--apply'),
});
console.log(JSON.stringify({ ...result, entries: result.entries.map(({ name, expectedVersion, version, retired, canTrial, status }) => ({ name, fromVersion: expectedVersion, version, retired, canTrial, status })),
  backfilled: result.backfilled.length }, null, 2));
if (!result.apply) console.log('只读预检完成，未写入 data。应用前先停止 Agent，再使用 --apply；新候选尚未获得游戏成功证据。');
