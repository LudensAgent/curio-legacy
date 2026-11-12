import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HandoffSpool } from '../src/spatial/handoff-spool.ts';

function withSpool(byteLimit: number): { spool: HandoffSpool; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-spool-'));
  const path = join(dir, 'spill.jsonl');
  return { spool: new HandoffSpool(path, byteLimit), dir, path };
}

test('追加与回放保持到达顺序，读取只消费完整行', async () => {
  const { spool, dir } = withSpool(1 << 20);
  try {
    spool.append(['{"n":1}', '{"n":2}']);
    await spool.flush();
    spool.append(['{"n":3}']);
    assert.deepEqual(await spool.readChunk(7), [], '不足一整行时不推进游标');
    assert.deepEqual(await spool.readChunk(16), ['{"n":1}', '{"n":2}'], '读到整行边界为止');
    assert.deepEqual(await spool.readChunk(1 << 20), ['{"n":3}'], '后续读取继续推进游标');
    assert.equal(spool.empty, true);
    await spool.compact();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('超过磁盘预算时丢弃并返回条数，未超预算的条目保持完整', async () => {
  const { spool, dir, path } = withSpool(20);
  try {
    const dropped = spool.append(['{"n":1}', '{"n":2}', '{"n":3}']);
    assert.deepEqual(dropped, [2], '返回被丢弃行的下标；大行被丢后小行仍可入队');
    await spool.flush();
    const text = readFileSync(path, 'utf8');
    assert.match(text, /\{"n":1\}/);
    assert.match(text, /\{"n":2\}/);
    assert.doesNotMatch(text, /\{"n":3\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('压缩保留未读尾部并重置游标；全部读完时清空文件', async () => {
  const { spool, dir } = withSpool(1 << 20);
  try {
    spool.append(Array.from({ length: 10 }, (_, i) => `{"n":${i}}`));
    await spool.flush();
    assert.equal((await spool.readChunk(1 << 20)).length, 10);
    await spool.compact();
    assert.equal(spool.empty, true);
    assert.deepEqual(await spool.readChunk(), [], '压缩后没有可读内容');

    spool.append(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
    await spool.flush();
    assert.deepEqual(await spool.readChunk(24), ['{"n":1}', '{"n":2}', '{"n":3}'], '24 字节只含三条完整行');
    spool.append(['{"n":5}']);
    await spool.flush();
    await spool.compact();
    assert.deepEqual(await spool.readChunk(1 << 20), ['{"n":4}', '{"n":5}'], '未读尾部在压缩后仍按顺序可读');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入失败不丢缓冲，清空后不再回放', async () => {
  const { dir } = withSpool(1 << 20);
  try {
    const blocked = new HandoffSpool(join(dir, 'missing', 'spill.jsonl'), 1 << 20);
    blocked.append(['{"n":1}']);
    await assert.rejects(blocked.flush(), '父目录不存在时保留原始错误');
    assert.equal(blocked.bytes > 0, true, '失败的写入仍留在缓冲里');
    await blocked.clear();
    assert.deepEqual(await blocked.readChunk(), [], '清空后不再回放');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按 maxRecords 截断时只推进已消费的行，剩余行仍可读', async () => {
  const { spool, dir } = withSpool(1 << 20);
  try {
    spool.append(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
    await spool.flush();
    assert.deepEqual(await spool.readChunk(1 << 20, 2), ['{"n":1}', '{"n":2}']);
    assert.deepEqual(await spool.readChunk(1 << 20, 10), ['{"n":3}', '{"n":4}']);
    assert.equal(spool.empty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
