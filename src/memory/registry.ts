import fs from 'node:fs';
import path from 'node:path';

export interface MemoryBackendRegistration { baseUrl: string; bankId: string }

/** This deliberately stores endpoint identities only; credentials belong in configuration. */
export function readMemoryRegistry(dataDir: string): MemoryBackendRegistration[] {
  const file = path.join(dataDir, 'memory', 'backends.json');
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Invalid memory backend registry');
  return parsed.map(validate);
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
  const file = path.join(dataDir, 'memory', 'backends.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
}
