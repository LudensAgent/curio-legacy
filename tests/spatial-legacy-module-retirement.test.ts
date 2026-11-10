import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceFiles = (function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
})(path.join(ROOT, 'src'));

const references = (symbol: string) => sourceFiles
  .filter((file) => fs.readFileSync(file, 'utf8').includes(symbol))
  .map((file) => path.relative(ROOT, file));

test('生产源码不再引用已退役的路线模块与 passage 查询面', () => {
  for (const symbol of [
    'TraversalRecorder',
    'event-adapter',
    'journal-producer',
    'nearbyPaths',
    'savePassage',
    'allPassages',
    'pageFragments',
    'buildPathGraph',
  ]) {
    assert.deepEqual(references(symbol), [], `src 不得再引用 ${symbol}`);
  }
});

test('semantic-store 只写 facts/ledger，不写 fragment 路线或 topology', () => {
  const file = path.join(ROOT, 'src/spatial/semantic-store.ts');
  const text = fs.readFileSync(file, 'utf8');
  for (const call of ['saveFragment(', 'updateFragment(', 'forgetFragment(', 'topology.']) {
    assert.equal(text.includes(call), false, `semantic-store 不得调用 ${call}`);
  }
});
