/**
 * 退役心智、保留世界：清掉 DATA_DIR 里会进入新版本运行的旧心智数据，保留空间记忆、容器账、世界事实和角色身份。
 *
 * 保留：spatial/（主库与迁移回执）、containers.json、ledger.json、skill-game-clock.json、agent.json、
 *       building-artifacts.json、design-drafts.json、world-memory.json 的世界事实（worldId/seen/deaths/digs/notes/lastHand）。
 * 退役：mind.json（只留 traits/visited）、world-memory.json 的旧窍门与目标、experience.json、method-library.json、
 *       skills/ 与技能统计/寿命/替代关系、control-knowledge.json、body-limits.jsonl、memory/ 本地情景档案。
 * 归档：logs/、scorecard.json、run-stats.json 先拷进项目 archives/ 再删；旧 spatial 快照与 backups/ 清理。
 *
 * 默认只预览；确认 Agent 已退出后加 --apply，会先备份到 DATA_DIR/backups/retire-mind-<时间>/ 再写入。
 * 用法：npx tsx scripts/retire-mind.ts [--data <数据目录>] [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { assertResetOffline } from '../src/maintenance/offline.ts';

const argv = process.argv.slice(2);
const dataIndex = argv.indexOf('--data');
const explicitData = dataIndex >= 0 ? argv[dataIndex + 1] : undefined;
if (dataIndex >= 0 && (!explicitData || explicitData.startsWith('--'))) throw new Error('--data 后需要数据目录');
const args = new Set(argv.filter((_arg, i) => i !== dataIndex && i !== dataIndex + 1));
const unknown = [...args].find((arg) => !['--apply', '--dry-run', '--help', '--data'].includes(arg));
if (unknown) throw new Error(`未知参数 ${unknown}；支持 --dry-run（默认）、--apply 与 --data <目录>`);
if (args.has('--help')) {
  console.log('npx tsx scripts/retire-mind.ts [--data <目录>] [--apply]；先退出 Agent。默认预览，--apply 会先备份再写入。');
  process.exit(0);
}

const apply = args.has('--apply');
const dataDir = path.resolve(explicitData ?? config.dataDir);
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = (name: string) => path.join(dataDir, name);
const has = (target: string) => fs.existsSync(target);
const readJson = (target: string) => has(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown> : null;
const writeJson = (target: string, value: unknown) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value));
  fs.renameSync(`${target}.tmp`, target);
};
const remove = (target: string) => {
  if (!has(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
};

if (!has(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error(`数据目录不存在：${dataDir}`);

/** 会被改写或删除、需要先备份的文件/目录 */
const backupNames = [
  'mind.json', 'world-memory.json', 'experience.json', 'method-library.json', 'skills',
  'skill-stats.json', 'skill-lifetimes.json', 'skill-lifetimes-substitutions.json', 'skill-owners.json',
  'control-knowledge.json', 'body-limits.jsonl', 'memory', 'excursions.json', 'skill-library.json',
];
/** 先归档再删的复盘材料 */
const archiveNames = ['logs', 'scorecard.json', 'run-stats.json'];
/** 旧空间快照：只留 spatial.sqlite 主库（-wal/-shm 跟随主库） */
const snapshot = (name: string) => /^spatial\.sqlite\.pre-/.test(name);

const backupDir = path.join(dataDir, 'backups', `retire-mind-${stamp}`);
const archiveDir = path.join(projectDir, 'archives', `retire-mind-${stamp}`);
const spatialDir = file('spatial');
const oldSnapshots = has(spatialDir) ? fs.readdirSync(spatialDir, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(spatialDir, entry.name);
  if (entry.isFile()) return snapshot(entry.name) ? [target] : [];
  if (!entry.isDirectory()) return [];
  return fs.readdirSync(target).filter((name) => /\.sqlite$/.test(name)).map((name) => path.join(target, name));
}) : [];
const oldBackups = has(file('backups'))
  ? fs.readdirSync(file('backups')).map((name) => path.join(file('backups'), name)).filter((target) => target !== backupDir)
  : [];

const plan = {
  dataDir,
  backupDir,
  archiveDir,
  keep: ['spatial/spatial.sqlite', 'containers.json', 'ledger.json', 'skill-game-clock.json', 'agent.json',
    'building-artifacts.json', 'design-drafts.json', 'world-memory.json 的 worldId/seen/deaths/digs/notes/lastHand'],
  mind: { keep: ['traits', 'visited'], clear: ['plan', 'agenda', 'knowHow', 'insights', 'experiments', 'diary', 'history',
    'stream', 'feel', 'habits', 'mood', 'stages', 'observedProgress', 'taskFacts', 'progressLedger', 'likes', 'reflectedAt', 'knowHowAtReflect'] },
  worldMemory: { keep: ['version', 'worldId', 'seen', 'deaths', 'lastDeath', 'digs', 'notes', 'lastHand', 'lastHandExplicit'],
    clear: ['lessons', 'objective', 'goals', 'preferences', 'intents', 'decisions', 'projects', 'evidence', 'skillStats', 'runtimePauseReasons'] },
  reset: [
    { file: file('experience.json'), to: '{ version: 1, episodes: {} }' },
    { file: file('method-library.json'), to: '{ version: 1, methods: [], gaps: [] }' },
    { file: file('skill-stats.json'), to: '{}' },
    { file: file('skill-lifetimes.json'), to: '[]' },
    { file: file('skill-owners.json'), to: '{}' },
  ].filter((entry) => has(entry.file)),
  delete: ['skills', 'skill-lifetimes-substitutions.json', 'control-knowledge.json', 'body-limits.jsonl',
    'excursions.json', 'skill-library.json',
    ...(has(file('memory')) ? fs.readdirSync(file('memory')).filter((name) => /^(episodes-.*\.jsonl|outbox-.*\.json)$/.test(name)).map((name) => `memory/${name}`) : [])]
    .filter((name) => has(file(name))),
  archive: archiveNames.filter((name) => has(file(name))),
  oldSnapshots,
  oldBackups: oldBackups.filter((target) => !target.includes(`${path.sep}retire-mind-`)),
};
console.log(apply ? `退役心智并保留世界：${dataDir}` : `预览（未写入）：${dataDir}`);
console.log(JSON.stringify(plan, null, 2));
if (!apply) {
  console.log('确认 Agent 已退出后加 --apply；会先备份到上述 backupDir。');
  process.exit(0);
}

await assertResetOffline([{ host: config.dashboard.host, port: config.dashboard.port, label: 'Agent 控制台' }]);

// 1) 复盘材料先归档，再删除。
fs.mkdirSync(archiveDir, { recursive: true });
for (const name of archiveNames) {
  if (!has(file(name))) continue;
  fs.cpSync(file(name), path.join(archiveDir, name), { recursive: true });
  remove(file(name));
}

// 2) 可能被删改的文件先备份。
fs.mkdirSync(backupDir, { recursive: true });
for (const name of backupNames) if (has(file(name))) fs.cpSync(file(name), path.join(backupDir, name), { recursive: true });

// 3) mind.json：只留性格与到访记录，其余交给新版本的默认值。
const mindFile = file('mind.json');
const mind = readJson(mindFile);
if (mind) writeJson(mindFile, { version: 1, ...(mind.traits ? { traits: mind.traits } : {}), ...(mind.visited ? { visited: mind.visited } : {}) });

// 4) world-memory.json：保留世界事实，清掉旧心智产物。
const worldFile = file('world-memory.json');
const world = readJson(worldFile);
if (world) {
  const keep = ['version', 'worldId', 'seen', 'deaths', 'lastDeath', 'digs', 'notes', 'lastHand', 'lastHandExplicit'];
  writeJson(worldFile, Object.fromEntries(keep.filter((key) => key in world).map((key) => [key, world[key]])));
}

// 5) 学习链产物归零/删除。
const experienceFile = file('experience.json');
if (has(experienceFile)) writeJson(experienceFile, { version: 1, episodes: {} });
const methodsFile = file('method-library.json');
if (has(methodsFile)) writeJson(methodsFile, { version: 1, methods: [], gaps: [] });
if (has(file('skill-stats.json'))) writeJson(file('skill-stats.json'), {});
if (has(file('skill-lifetimes.json'))) writeJson(file('skill-lifetimes.json'), []);
if (has(file('skill-owners.json'))) writeJson(file('skill-owners.json'), {});
for (const name of plan.delete) remove(file(name));

// 6) 旧空间快照与旧备份：主库之外不再保留可回滚副本。
for (const target of plan.oldSnapshots) remove(target);
for (const target of plan.oldBackups) remove(target);

writeJson(path.join(backupDir, 'receipt.json'), { at: Date.now(), dataDir, plan });
console.log(`已退役旧心智数据；备份在 ${backupDir}，复盘材料在 ${archiveDir}`);
