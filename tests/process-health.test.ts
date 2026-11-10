import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installProcessHealth } from '../src/observer/process-health.ts';

const bus = () => { const evs: any[] = []; return { evs, publish: (type: string, severity: string, msg: string, data?: unknown) => evs.push({ type, severity, msg, data }) } as any; };
const reading = (ratio: number) => () => ({ rss: 1, heapUsed: ratio * 100, heapLimit: 100, ratio });

test('sends heartbeats and logs memory', () => {
  const b = bus(); const sent: any[] = [];
  const h = installProcessHealth(b, { onShutdown() {}, onMemoryRestart() {}, read: reading(0.3), send: (m) => sent.push(m) });
  h.check(); h.dispose();
  assert.equal(sent[0].type, 'hb');
  assert.equal(b.evs.filter((e: any) => e.type === 'process_memory').length, 1);
});

test('near the heap limit it asks for a planned restart once, only when supervised', () => {
  const b = bus(); let restarts = 0;
  const h = installProcessHealth(b, { onShutdown() {}, onMemoryRestart() { restarts++; }, read: reading(0.95), send: () => {} });
  h.check(); h.check(); h.dispose();
  assert.equal(restarts, 1);
  assert.equal(b.evs.filter((e: any) => e.type === 'memory_restart').length, 1);

  const b2 = bus(); let r2 = 0;
  const h2 = installProcessHealth(b2, { onShutdown() {}, onMemoryRestart() { r2++; }, read: reading(0.95), send: null });
  h2.check(); h2.dispose();
  assert.equal(r2, 0);
  assert.match(b2.evs.find((e: any) => e.type === 'memory_high').msg, /supervise/);
});

test('logs off-heap memory and module stats, and writes one heap snapshot past the threshold', () => {
  const b = bus(); const files: string[] = [];
  const read = () => ({ rss: 3 << 30, heapUsed: 1.5 * 2 ** 30, heapLimit: 4 * 2 ** 30, ratio: 0.375, external: 64 << 20, arrayBuffers: 32 << 20 });
  const h = installProcessHealth(b, { onShutdown() {}, onMemoryRestart() {}, read, send: null,
    extra: () => ({ sseClients: 2, sseBacklog: 300 << 20, sandboxWorkers: 1 }),
    snapshotAtBytes: 2 ** 30, snapshotDir: 'snaps', writeSnapshot: (f) => { files.push(f); return f; } });
  h.check(); h.check(); h.dispose();
  const log = b.evs.find((e: any) => e.type === 'process_memory');
  assert.match(log.msg, /堆外 64 MB/);
  assert.match(log.msg, /sseBacklog=300 MB/);
  assert.equal(log.data.sseClients, 2);
  assert.equal(files.length, 1);
  assert.match(files[0], /heap-.*\.heapsnapshot$/);
});

test('skips the heap snapshot when the directory already has one from the cooldown window (across restarts)', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-cooldown-'));
  try {
    fs.writeFileSync(path.join(dir, 'heap-earlier.heapsnapshot'), '');
    const b = bus(); const files: string[] = [];
    const read = () => ({ rss: 1, heapUsed: 1.5 * 2 ** 30, heapLimit: 4 * 2 ** 30, ratio: 0.375 });
    const h = installProcessHealth(b, { onShutdown() {}, onMemoryRestart() {}, read, send: null,
      snapshotAtBytes: 2 ** 30, snapshotDir: dir, writeSnapshot: (f) => { files.push(f); return f; } });
    h.check(); h.check(); h.dispose();
    assert.equal(files.length, 0);
    assert.equal(b.evs.filter((e: any) => e.type === 'memory_snapshot').length, 1, '只说一次为什么没写');
    const old = Date.now() / 1000 - 2 * 86_400;
    fs.utimesSync(path.join(dir, 'heap-earlier.heapsnapshot'), old, old);
    const h2 = installProcessHealth(bus(), { onShutdown() {}, onMemoryRestart() {}, read, send: null,
      snapshotAtBytes: 2 ** 30, snapshotDir: dir, writeSnapshot: (f) => { files.push(f); return f; } });
    h2.check(); h2.dispose();
    assert.equal(files.length, 1, '旧快照超过冷却期，照常写');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
