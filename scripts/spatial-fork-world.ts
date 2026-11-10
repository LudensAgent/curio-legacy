/**
 * 把一份共享空间库复制成另一个 worldId 的副本（例如 live → 本地测试世界）。
 *
 * 离线一次性工具：来源库只读，用 `VACUUM INTO` 得到一致快照，再把快照里所有
 * TEXT 列中出现的来源 worldId 原样替换成目标 worldId（world_id 列、payload JSON、
 * 由 worldId 拼成的 id/key、传送门端点）。worldId 若出现在非 TEXT 列，拒绝执行，
 * 不猜它的编码。替换后用与运行时相同的上限经库打开并做 integrity_check，计数逐表
 * 比对；任何一步失败都不覆盖目标。
 *
 * 不改写来源库；目标已存在时必须显式 --replace，原目标先改名留作备份。
 *
 *   tsx scripts/spatial-fork-world.ts <source.sqlite> <target.sqlite> <fromWorld> <toWorld> [--replace]
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { DEFAULT_SNAPSHOT_MAX_MB } from '../src/spatial/shared-session.ts';

/** 离线迁移工具自己的 legacy 路径 links 上限；运行时路线写入已退役，故不从 src 反向导入。 */
const OFFLINE_LEGACY_MAX_FRAGMENT_LINKS = 16_384;

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [source, target, fromWorld, toWorld] = args.filter((a) => !a.startsWith('--'));
if (!source || !target || !fromWorld || !toWorld) {
  process.stderr.write('usage: spatial-fork-world <source.sqlite> <target.sqlite> <fromWorld> <toWorld> [--replace]\n');
  process.exit(1);
}
const src = resolve(source), dst = resolve(target);
if (!existsSync(src)) throw new Error(`source not found: ${src}`);
if (src === dst) throw new Error('source and target must differ');
if (existsSync(dst) && !replace) throw new Error(`target exists: ${dst}（确认要覆盖时加 --replace，原目标会改名备份）`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const work = `${dst}.fork-${stamp}.tmp`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const sourceDb = new DatabaseSync(src, { readOnly: true });
sourceDb.exec(`VACUUM INTO '${work.replaceAll("'", "''")}'`);
const tables = sourceDb.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((r) => String(r.name));
const countsOf = (db: DatabaseSync) => Object.fromEntries(tables.map((t) => [t, Number(db.prepare(`select count(*) n from ${quote(t)}`).get()!.n)]));
const sourceCounts = countsOf(sourceDb);
sourceDb.close();

const db = new DatabaseSync(work);
const touched: Record<string, number> = {};
db.exec('BEGIN');
for (const table of tables) {
  const columns = db.prepare(`pragma table_info(${quote(table)})`).all().map((c) => ({ name: String(c.name), type: String(c.type).toUpperCase() }));
  for (const column of columns) {
    const hits = Number(db.prepare(`select count(*) n from ${quote(table)} where instr(CAST(${quote(column.name)} AS BLOB), CAST(? AS BLOB)) > 0`).get(fromWorld)!.n);
    if (hits === 0) continue;
    if (column.type !== 'TEXT') {
      db.exec('ROLLBACK');
      db.close();
      rmSync(work, { force: true });
      throw new Error(`${table}.${column.name}（${column.type || '无类型'}）含来源 worldId，不是 TEXT，拒绝猜测编码`);
    }
    db.prepare(`update ${quote(table)} set ${quote(column.name)} = replace(${quote(column.name)}, ?, ?) where instr(${quote(column.name)}, ?) > 0`).run(fromWorld, toWorld, fromWorld);
    touched[`${table}.${column.name}`] = hits;
  }
}
db.exec('COMMIT');
const integrity = String(db.prepare('pragma integrity_check').get()!.integrity_check);
const leftover = tables.flatMap((t) => db.prepare(`pragma table_info(${quote(t)})`).all()
  .filter((c) => Number(db.prepare(`select count(*) n from ${quote(t)} where instr(CAST(${quote(String(c.name))} AS BLOB), CAST(? AS BLOB)) > 0`).get(fromWorld)!.n) > 0)
  .map((c) => `${t}.${String(c.name)}`));
const forkCounts = countsOf(db);
db.close();
const countDiff = tables.filter((t) => forkCounts[t] !== sourceCounts[t]);
if (integrity !== 'ok' || leftover.length || countDiff.length) {
  rmSync(work, { force: true });
  throw new Error(`fork check failed: integrity=${integrity} leftover=${leftover.join(',')} countDiff=${countDiff.join(',')}`);
}

// 与运行时同样的上限经库打开：能打开、目标世界里读得到片段才算可用
const session = await openSpatialSession({
  databasePath: work, worldId: toWorld, timeoutMs: 30_000,
  snapshotLimits: { maxBytes: DEFAULT_SNAPSHOT_MAX_MB * 1024 * 1024 }, fragmentOptions: { maxLinks: OFFLINE_LEGACY_MAX_FRAGMENT_LINKS },
});
const fragments = session.history.fragments({ limit: 1 }).items.length;
await session.close();
if (sourceCounts.path_fragments > 0 && fragments === 0) {
  rmSync(work, { force: true });
  throw new Error(`fork opened as ${toWorld} but no fragments are visible`);
}

const backup = existsSync(dst) ? `${dst}.pre-fork-${stamp}.sqlite` : null;
if (backup) {
  renameSync(dst, backup);
  for (const suffix of ['-wal', '-shm']) if (existsSync(dst + suffix)) renameSync(dst + suffix, backup + suffix);
}
renameSync(work, dst);
for (const suffix of ['-wal', '-shm']) if (existsSync(work + suffix)) renameSync(work + suffix, dst + suffix);
process.stdout.write(`${JSON.stringify({ source: src, target: dst, fromWorld, toWorld, backup, integrity, touched, counts: forkCounts }, null, 2)}\n`);
