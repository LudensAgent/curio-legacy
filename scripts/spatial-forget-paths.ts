/**
 * 从共享空间库里移除路径历史（矿道/走过的路/搭的桥/建造路径），保留其它一切。
 *
 * 移除：指定 kind 的 PathFragment（连同它拥有的 traversal evidence，由库的 forgetFragment
 * 负责）、引用这些片段的拓扑边，以及因此不再被任何边引用的通道节点（`walk:` 命名空间的
 * program 节点，只是路径的端点）。
 * 保留：地标/资源/容器/基地等节点、体素 Section、放置方块、区块访问、传送门记录。
 *
 * 离线一次性工具：默认 dry-run 只报数；--execute 先用 VACUUM INTO 做一致备份，再经库写入、
 * checkpoint，重新打开核对：目标片段为 0，其余节点与账本计数不变。
 *
 *   tsx scripts/spatial-forget-paths.ts <spatial.sqlite> <worldId> [--kinds dug,walked,bridge,built] [--execute]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { PathFragment } from 'curio-minecraft-3d-memory';
import { DEFAULT_SNAPSHOT_MAX_MB, MAX_FRAGMENT_LINKS } from '../src/spatial/shared-session.ts';

const KINDS = ['dug', 'walked', 'bridge', 'built'] as const;
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const kindsArg = args[args.indexOf('--kinds') + 1];
const kinds = args.includes('--kinds') ? (kindsArg ?? '').split(',') : [...KINDS];
const [database, worldId] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--kinds');
if (!database || !worldId || kinds.some((k) => !(KINDS as readonly string[]).includes(k))) {
  process.stderr.write('usage: spatial-forget-paths <spatial.sqlite> <worldId> [--kinds dug,walked,bridge,built] [--execute]\n');
  process.exit(1);
}
const db = resolve(database);
if (!existsSync(db)) throw new Error(`database not found: ${db}`);

const open = () => openSpatialSession({
  databasePath: db, worldId, timeoutMs: 30_000,
  snapshotLimits: { maxBytes: DEFAULT_SNAPSHOT_MAX_MB * 1024 * 1024 }, fragmentOptions: { maxLinks: MAX_FRAGMENT_LINKS },
});

const pages = <T>(read: (after?: string) => { items: T[]; nextAfter?: string }) => {
  const out: T[] = [];
  for (let after: string | undefined, guard = 0; guard < 100_000; guard++) {
    const page = read(after);
    out.push(...page.items);
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
};
const census = (session: SpatialSession) => {
  const fragments = pages((after) => session.history.fragments({ limit: 100, ...(after ? { after } : {}) }));
  const byKind: Record<string, number> = {};
  for (const f of fragments) byKind[`${f.dim}/${f.kind}`] = (byKind[`${f.dim}/${f.kind}`] ?? 0) + 1;
  return {
    fragments, byKind,
    nodes: pages((after) => session.topology.nodes({ limit: 100, ...(after ? { after } : {}) })),
    edges: pages((after) => session.topology.edges({ limit: 100, ...(after ? { after } : {}) })),
    ledger: { placed: session.ledger.placedBlocks().length, visits: session.ledger.chunkVisits().length, portalTraversals: session.ledger.portalTraversals().length },
  };
};

const session = await open();
const before = census(session);
const targets = before.fragments.filter((f: PathFragment) => (kinds as string[]).includes(f.kind));
const targetIds = new Set(targets.map((f) => f.id));
const edges = before.edges.filter((e) => e.fragmentId !== undefined && targetIds.has(e.fragmentId));
const plan = {
  database: db, worldId, kinds, execute,
  before: { fragments: before.byKind, nodes: before.nodes.length, edges: before.edges.length, ledger: before.ledger },
  remove: { fragments: targets.length, links: targets.reduce((n, f) => n + (f.links?.length ?? 0), 0), edges: edges.length },
};
if (!execute) {
  await session.close();
  process.stdout.write(`${JSON.stringify({ ...plan, note: 'dry-run：没有写入；加 --execute 执行' }, null, 2)}\n`);
  process.exit(0);
}
await session.close();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${db}.pre-forget-paths-${stamp}.sqlite`;
const raw = new DatabaseSync(db, { readOnly: true });
raw.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
raw.close();

const writer = await open();
for (const e of edges) writer.topology.forgetEdge(e.id);
for (const id of targetIds) writer.history.forgetFragment(id);
// 只清掉因此成了孤点的通道端点；地标/资源/容器节点不是 walk: 命名空间，不动
const orphanCorridorNodes = before.nodes.filter((n) => n.source === 'program' && n.id.startsWith('walk:') && writer.topology.incidentEdgeIds(n.id).length === 0);
for (const n of orphanCorridorNodes) writer.topology.forgetNode(n.id);
const checkpoint = await writer.checkpoint();
await writer.close();

const verify = await open();
const after = census(verify);
await verify.close();
const leftover = after.fragments.filter((f) => (kinds as string[]).includes(f.kind)).length;
const nodesKept = after.nodes.length === before.nodes.length - orphanCorridorNodes.length;
const ledgerKept = JSON.stringify(after.ledger) === JSON.stringify(before.ledger);
process.stdout.write(`${JSON.stringify({
  ...plan, backup, checkpoint: { id: checkpoint.checkpointId, fragmentRevision: checkpoint.fragmentRevision },
  removed: { fragments: targets.length, edges: edges.length, corridorNodes: orphanCorridorNodes.length },
  after: { fragments: after.byKind, nodes: after.nodes.length, edges: after.edges.length, ledger: after.ledger },
  verified: { leftoverFragments: leftover, nodesKept, ledgerKept },
}, null, 2)}\n`);
if (leftover !== 0 || !nodesKept || !ledgerKept) process.exitCode = 1;
