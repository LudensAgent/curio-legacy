/**
 * 学习链数据切换：停用旧计划/议程、清空经验与进展账本、把技能成败统计归零。
 * 保留世界地图、活动历史、死亡/位置、日志与技能定义；只改由本仓库学习链产生的数据。
 *
 * 默认只预览；确认 Agent 已退出后加 --apply 才会备份并写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, requireLocalMode } from '../src/config.ts';

const argv = process.argv.slice(2);
const dataIndex = argv.indexOf('--data');
const explicitData = dataIndex >= 0 ? argv[dataIndex + 1] : undefined;
if (dataIndex >= 0 && (!explicitData || explicitData.startsWith('--'))) throw new Error('--data 后需要数据目录');
const args = new Set(argv.filter((_arg, i) => i !== dataIndex && i !== dataIndex + 1));
const allowed = new Set(['--apply', '--dry-run', '--help', '--data']);
const unknown = [...args].find((arg) => !allowed.has(arg));
if (unknown) throw new Error(`未知参数 ${unknown}；支持 --dry-run（默认）、--apply 与 --data <目录>`);

if (args.has('--help')) {
  console.log('npm run mind:reset-pipeline [-- --apply] [-- --data <数据目录>]；先退出 Agent。默认预览，--apply 会先备份再写入。');
  process.exit(0);
}

requireLocalMode('切换学习链数据');
const dataDir = path.resolve(explicitData ?? config.dataDir);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = (file: string) => {
  const target = `${file}.bak-pipeline-reset-${stamp}`;
  if (args.has('--apply') && fs.existsSync(file)) fs.copyFileSync(file, target);
  return target;
};
const readJson = (file: string): unknown => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const writeJson = (file: string, value: unknown) => {
  if (!args.has('--apply')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
};

const mindFile = path.join(dataDir, 'mind.json');
const mind = readJson(mindFile) as Record<string, unknown> | null;
const plan: Record<string, unknown> = {};
if (mind) {
  // 保留 history/stream/diary/visited/likes/traits/habits/mood；只停用旧策略与经验。
  const next = { ...mind };
  delete next.plan;
  delete next.taskFacts;
  delete next.progressLedger;
  next.agenda = [];
  next.knowHow = [];
  next.insights = [];
  next.experiments = [];
  next.knowHowAtReflect = 0;
  next.reflectedAt = 0;
  const feel = next.feel;
  if (feel && typeof feel === 'object' && !Array.isArray(feel)) {
    next.feel = Object.fromEntries(Object.entries(feel as Record<string, unknown>).map(([name]) => [name, { ok: 0, fail: 0, ms: 0 }]));
  }
  plan.mind = {
    file: mindFile, plan: 'cleared', agenda: 'cleared', knowHow: 'cleared', insights: 'cleared', experiments: 'cleared',
    progressLedger: 'cleared', taskFacts: 'cleared', feel: 'zeroed', kept: ['history', 'stream', 'diary', 'visited', 'likes', 'traits', 'habits', 'mood'],
    backup: backup(mindFile),
  };
  writeJson(mindFile, next);
}

const experienceFile = path.join(dataDir, 'experience.json');
if (fs.existsSync(experienceFile)) {
  plan.experience = { file: experienceFile, action: 'clear episodes, keep version', backup: backup(experienceFile) };
  writeJson(experienceFile, { version: 1, episodes: {} });
}

const statsFile = path.join(dataDir, 'skill-stats.json');
const stats = readJson(statsFile) as Record<string, Record<string, unknown>> | null;
if (stats) {
  const next = Object.fromEntries(Object.entries(stats).map(([name, value]) => {
    const v: Record<string, unknown> = { ...value, fired: 0, ok: 0, fail: 0, lastAt: 0, recent: [] };
    delete v.lastError;
    delete v.advisory;
    if (v.byVersion && typeof v.byVersion === 'object') v.byVersion = Object.fromEntries(Object.keys(v.byVersion).map((key) => [key, { ok: 0, fail: 0 }]));
    if (v.byDim && typeof v.byDim === 'object') v.byDim = Object.fromEntries(Object.keys(v.byDim).map((key) => [key, { ok: 0, fail: 0 }]));
    return [name, v];
  }));
  plan['skill-stats'] = { file: statsFile, action: 'counts zeroed; disabled/retired/candidate flags kept', backup: backup(statsFile) };
  writeJson(statsFile, next);
}

const lifetimesFile = path.join(dataDir, 'skill-lifetimes.json');
if (fs.existsSync(lifetimesFile)) {
  plan['skill-lifetimes'] = { file: lifetimesFile, action: 'clear lifetime records; skill definitions untouched', backup: backup(lifetimesFile) };
  writeJson(lifetimesFile, {});
}

console.log(args.has('--apply') ? `学习链数据已切换；备份后缀 .bak-pipeline-reset-${stamp}` : '预览（未写入）；确认 Agent 已退出后加 --apply');
console.log(JSON.stringify(plan, null, 2));
