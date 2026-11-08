import type { PathFragment } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from './shared-session.ts';

/** 旧 passage 归档时间；归档记录仍可能留在 fragments 里，查询/规划默认不把它当现行路线。 */
export const fragmentArchivedAt = (fragment: PathFragment): number | undefined => {
  const curio = (fragment.metadata as { curio?: { archivedAt?: unknown } } | undefined)?.curio;
  return typeof curio?.archivedAt === 'number' ? curio.archivedAt : undefined;
};

/** 分页读取共享空间记忆的 fragments；只读、按 nextAfter 前进，超限/取消/期限都如实标记。 */
export function pageFragments(
  spatial: Pick<SharedSpatialSession, 'query'>,
  opts: {
    dim?: string;
    kinds?: PathFragment['kind'][];
    maxFragments: number;
    signal: AbortSignal;
    deadline: number;
  },
): { items: PathFragment[]; pages: number; truncated: boolean; partial: boolean } {
  const items: PathFragment[] = [];
  const kinds: (PathFragment['kind'] | undefined)[] = opts.kinds?.length ? opts.kinds : [undefined];
  let pages = 0;
  let truncated = false;
  let partial = false;
  for (const kind of kinds) {
    let after: string | undefined;
    const cursors = new Set<string>();
    while (opts.signal.aborted === false && Date.now() < opts.deadline) {
      const remaining = opts.maxFragments - items.length;
      if (remaining <= 0) { truncated = true; break; }
      const result = spatial.query({
        kind: 'fragments',
        ...(opts.dim === undefined ? {} : { dim: opts.dim }),
        ...(kind === undefined ? {} : { fragmentKind: kind }),
        limit: Math.min(1000, remaining),
        ...(after === undefined ? {} : { after }),
      });
      pages += 1;
      if (result.status !== 'ok' && result.status !== 'partial') { partial = true; break; }
      if (result.data?.kind !== 'fragments') { partial = true; break; }
      items.push(...result.data.items);
      if (result.status === 'partial') { partial = true; break; }
      const next = result.nextAfter ?? result.data.nextAfter;
      if (next === undefined) break;
      // 库的游标必须前进；同一游标重复出现时停下并如实报告 partial，避免空转。
      if (cursors.has(next)) { partial = true; break; }
      cursors.add(next);
      after = next;
    }
    if (opts.signal.aborted || Date.now() >= opts.deadline) { partial = true; break; }
    if (truncated || partial) break;
  }
  return { items: items.slice(0, opts.maxFragments), pages, truncated: truncated || items.length > opts.maxFragments, partial };
}
