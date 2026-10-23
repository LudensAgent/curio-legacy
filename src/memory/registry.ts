import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MemoryBackendRegistration { baseUrl: string; bankId: string }

/** This deliberately stores endpoint identities only; credentials belong in configuration. */
export function readMemoryRegistry(dataDir: string): MemoryBackendRegistration[] {
  inspectRegistryPath(dataDir);
  const file = path.join(dataDir, 'memory', 'backends.json');
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Invalid memory backend registry');
  return parsed.map(validate);
}

/** Registry reads/writes must never follow links out of the memory directory. */
function inspectRegistryPath(dataDir: string): void {
  for (const [target, directory] of [[path.join(dataDir, 'memory'), true], [path.join(dataDir, 'memory', 'backends.json'), false]] as const) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('记忆服务登记目录或文件不能是链接或异常类型，拒绝清理或覆盖。');
    }
  }
}

function validate(value: unknown): MemoryBackendRegistration {
  if (!value || typeof value !== 'object') throw new Error('Invalid memory backend registration');
  const { baseUrl, bankId } = value as MemoryBackendRegistration;
  if (typeof baseUrl !== 'string' || typeof bankId !== 'string' || !bankId.trim()) throw new Error('Invalid memory backend registration');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Memory endpoint must be an HTTP URL without embedded credentials or query parameters');
  }
  return { baseUrl: url.toString().replace(/\/+$/, ''), bankId };
}

export function registerMemoryBackend(dataDir: string, entry: MemoryBackendRegistration): void {
  const validated = validate(entry);
  const entries = readMemoryRegistry(dataDir);
  if (entries.some((e) => e.baseUrl === validated.baseUrl && e.bankId === validated.bankId)) return;
  entries.push(validated);
  writeRegistry(dataDir, entries);
}

/** Remove only a bank whose remote deletion has already been confirmed. */
export function unregisterMemoryBackend(dataDir: string, entry: MemoryBackendRegistration): void {
  const validated = validate(entry);
  const entries = readMemoryRegistry(dataDir).filter((e) => e.baseUrl !== validated.baseUrl || e.bankId !== validated.bankId);
  writeRegistry(dataDir, entries);
}

function writeRegistry(dataDir: string, entries: MemoryBackendRegistration[]): void {
  inspectRegistryPath(dataDir);
  const file = path.join(dataDir, 'memory', 'backends.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.backends-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(entries, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
