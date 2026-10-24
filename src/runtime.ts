import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Identifies the sources actually loaded at startup, without reading .env. */
export function sourceFingerprint(root = fileURLToPath(new URL('.', import.meta.url))): string {
  const hash = createHash('sha256');
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        hash.update(path.relative(root, file).replaceAll('\\', '/')).update('\0').update(fs.readFileSync(file)).update('\0');
      }
    }
  };
  visit(root);
  return hash.digest('hex').slice(0, 16);
}

export const runtime = { pid: process.pid, startedAt: Date.now(), node: process.version, sourceFingerprint: sourceFingerprint() };
