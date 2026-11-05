/**
 * 把旧 WorldMemory / curio-map-data 里的通道几何转换成 memory-patch.json 的 archivePassages。
 *
 * 该脚本只读来源文件，默认 dry-run；加 --execute 才写出补丁。补丁由 WorldMemory 在下次启动时
 * 通过 applyPatch 一次读入历史归档，不直接改正在运行的 world-memory.json。
 *
 * 用法：
 *   node --import tsx scripts/legacy-passage-archive.ts \
 *     --source=/path/to/curio/curio-map-data/data.json \
 *     --target-world-id=curio-local-test-01 \
 *     --out=/path/to/curio/data/local-test-01/memory-patch.json --execute
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { PassageRecord } from '../src/memory/store.ts';

interface Cli {
  source: string;
  targetWorldId: string;
  out: string;
  execute: boolean;
  force: boolean;
  limit: number | null;
  existing: string | null;
}

function usage(): string {
  return [
    'legacy-passage-archive — 生成 memory-patch.json 的 archivePassages',
    '',
    '  --source=<path>            必需：curio-map-data/data.json 或 world-memory.json',
    '  --target-world-id=<id>     必需：写入补丁的目标世界 ID（来源世界 ID 不直接沿用）',
    '  --out=<path>               必需：要生成的 memory-patch.json 路径',
    '  --existing=<path>          可选：目标世界当前 world-memory.json；其中已有的通道 ID 不再放入归档',
    '  --limit=<n>                可选：最多取多少条来源记录',
    '  --execute                  真正写文件；默认只打印统计',
    '  --force                    允许覆盖已存在的 --out',
  ].join('\n');
}

function parseCli(argv: string[]): Cli {
  const values = new Map<string, string>();
  let execute = false, force = false;
  for (const arg of argv) {
    if (arg === '--execute') { execute = true; continue; }
    if (arg === '--force') { force = true; continue; }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`不认识的参数：${arg}`);
    values.set(match[1], match[2]);
  }
  const source = values.get('source');
  const targetWorldId = values.get('target-world-id');
  const out = values.get('out');
  if (!source || !targetWorldId || !out) throw new Error(usage());
  if (!/^[^\s/\\]+$/.test(targetWorldId)) throw new Error('target-world-id 不能含路径分隔符');
  const rawLimit = values.get('limit');
  const limit = rawLimit === undefined ? null : Number(rawLimit);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit 需要正整数');
  return { source, targetWorldId, out, execute, force, limit, existing: values.get('existing') ?? null };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vec = (value: unknown): Vec3Like | null => {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.z)) return null;
  return { x: value.x, y: value.y, z: value.z };
};
const vecList = (value: unknown): Vec3Like[] => Array.isArray(value) ? value.flatMap((item) => { const v = vec(item); return v ? [v] : []; }) : [];
const linkList = (value: unknown): { a: Vec3Like; b: Vec3Like }[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const a = vec(item.a), b = vec(item.b);
    return a && b ? [{ a, b }] : [];
  });
};
const oreCounts = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => finite(entry[1]) && entry[1] >= 0));
};

function passageRecord(value: unknown, targetWorldId: string): PassageRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.dim !== 'string' || !value.dim.trim()) return null;
  const pathPoints = vecList(value.path);
  if (!pathPoints.length) return null;
  const kind = value.kind === 'walked' || value.kind === 'bridge' ? value.kind : 'dug';
  const deepestY = finite(value.deepestY) ? value.deepestY : Math.min(...pathPoints.map((point) => point.y));
  const createdAt = finite(value.createdAt) ? value.createdAt : 0;
  const lastUsedAt = finite(value.lastUsedAt) ? value.lastUsedAt : createdAt;
  return {
    id: value.id.trim(),
    worldId: targetWorldId,
    dim: value.dim,
    kind,
    entrances: vecList(value.entrances),
    path: pathPoints,
    ...(Array.isArray(value.links) ? { links: linkList(value.links) } : {}),
    deepestY,
    dug: finite(value.dug) ? Math.max(0, value.dug) : 0,
    ores: oreCounts(value.ores),
    createdAt,
    lastUsedAt,
    uses: finite(value.uses) ? Math.max(0, value.uses) : 1,
  };
}

function readSource(file: string): { passages: unknown[]; sourceWorldIds: string[]; kind: 'map' | 'world-memory' } {
  const root: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(root)) throw new Error('来源根必须是对象');
  const current = Array.isArray(root.passages) ? root.passages : [];
  const historical = Array.isArray(root.historicalSnapshots)
    ? root.historicalSnapshots.flatMap((snapshot) => isRecord(snapshot) && Array.isArray(snapshot.passages) ? snapshot.passages : [])
    : [];
  const sourceWorldIds = [...new Set([...current, ...historical].flatMap((item) => isRecord(item) && typeof item.worldId === 'string' ? [item.worldId] : []))];
  return { passages: [...current, ...historical], sourceWorldIds, kind: Array.isArray(root.historicalSnapshots) ? 'map' : 'world-memory' };
}

function liveRecordIds(file: string): Set<string> {
  const root: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(root) || !Array.isArray(root.passages)) return new Set();
  return new Set(root.passages.flatMap((record) => isRecord(record) && typeof record.id === 'string' ? [record.id] : []));
}

function main(): number {
  const cli = parseCli(process.argv.slice(2));
  const source = readSource(cli.source);
  const existing = cli.existing ? liveRecordIds(cli.existing) : new Set<string>();
  const byId = new Map<string, PassageRecord>();
  let skipped = 0, alreadyLive = 0;
  for (const raw of source.passages) {
    const record = passageRecord(raw, cli.targetWorldId);
    if (!record) { skipped++; continue; }
    if (existing.has(record.id)) { alreadyLive++; continue; }
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  const records = [...byId.values()].slice(0, cli.limit ?? undefined);
  const patch = {
    _source: {
      file: path.resolve(cli.source),
      kind: source.kind,
      sourceWorldIds: source.sourceWorldIds,
      targetWorldId: cli.targetWorldId,
      generatedAt: new Date().toISOString(),
      records: records.length,
      skipped,
    },
    archivePassages: records,
  };
  const out = path.resolve(cli.out);
  process.stdout.write([
    `source: ${path.resolve(cli.source)} (${source.kind})`,
    `source worldIds: ${source.sourceWorldIds.join(', ') || 'none'}`,
    `target worldId: ${cli.targetWorldId}`,
    `existing live IDs: ${existing.size}${cli.existing ? ` (${path.resolve(cli.existing)})` : ''}`,
    `passages: ${byId.size} unique, ${records.length} selected, ${skipped} skipped, ${alreadyLive} already live`,
    `points: ${records.reduce((sum, record) => sum + record.path.length, 0)}, links: ${records.reduce((sum, record) => sum + (record.links?.length ?? 0), 0)}`,
    `out: ${out}${cli.execute ? '' : ' (dry-run)'}`,
  ].join('\n') + '\n');
  if (!cli.execute) return 0;
  if (fs.existsSync(out) && !cli.force) throw new Error(`输出已存在，未覆盖：${out}（确认后加 --force）`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(patch, null, 2)}\n`);
  fs.renameSync(tmp, out);
  process.stdout.write('written\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
