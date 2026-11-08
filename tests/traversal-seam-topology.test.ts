import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';

const WORLD = 'seam-world';
const DIM = 'overworld';
const SESSION = 'seam-session';

test('连续走 >8 格后，分段处由同一个 exact 节点连接，拓扑仍连通', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-topology-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    let now = 0;
    const rec = new TraversalRecorder(svc, () => ++now);
    for (let x = 0; x < 10; x++) rec.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION, pos: { x, y: 64, z: 0 } });
    rec.flush();

    const nodes = svc.query({ kind: 'nodes', dim: DIM, limit: 100 });
    const edges = svc.query({ kind: 'edges', dim: DIM, limit: 100 });
    assert.equal(nodes.status, 'ok');
    assert.equal(edges.status, 'ok');
    const nodeIds = (nodes.data as { items: { id: string }[] }).items.map((node) => node.id);
    const edgeIds = (edges.data as { items: { id: string }[] }).items.map((edge) => edge.id);
    assert.equal(nodeIds.length, 10, 'x=0..9 的共享 x=7 节点只应有一个');
    assert.equal(edgeIds.length, 9);
    const has = (a: number, b: number) => edgeIds.some((id) => id.includes(`${a},64,0`) && id.includes(`${b},64,0`));
    assert.ok(has(6, 7), '第一段末尾 6→7 边仍存在');
    assert.ok(has(7, 8), '新段 seam 7→8 边存在');
    assert.ok(has(8, 9), '新段后续 8→9 边存在');
  } finally {
    try { shutdown = await svc.shutdown(); } catch { /* preserve fixture */ }
    if (shutdown?.close?.completed === true && shutdown.close.error === null) rmSync(dir, { recursive: true, force: true });
  }
});
