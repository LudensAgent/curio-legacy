/** One-shot consistent SQLite backup helper shared by offline tools. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 一致性备份：VACUUM INTO 生成独立快照，不改写来源库。 */
export function backupDatabase(databasePath: string, backupPath: string): { path: string; size: number; sha256: string } {
  const source = resolve(databasePath), target = resolve(backupPath);
  if (!existsSync(source)) throw new Error(`database not found: ${source}`);
  if (existsSync(target)) throw new Error(`backup already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  db.exec(`VACUUM INTO '${target.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  db.close();
  const info = statSync(target);
  return { path: target, size: info.size, sha256: sha256(target) };
}
