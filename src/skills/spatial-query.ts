/**
 * spatial_query：只读查询共享空间记忆中已经记录的事实。
 *
 * 只读宿主共享会话的 voxel / history / topology 投影，不观察、不移动、不刷新证据，
 * 也不触碰 adapter、感官或任何写入入口。查询完成即成功；not_found、unknown、
 * 预算耗尽与作用域不符都作为查询事实返回，绝不改写成当前世界状态或通行结论。
 */
import { blockToSection } from 'curio-minecraft-3d-memory';
import type { MoveMode } from 'curio-minecraft-3d-memory';
import type { GameAdapter } from '../adapter/types.ts';
import { fail, ok, type Skill } from './types.ts';

const MAX_DIM_LENGTH = 128;
const MAX_ID_LENGTH = 256;
const MAX_CELLS = 32;
const MAX_IDS = 8;
const FRAGMENT_FIELD_MAX = 32;
const FRAGMENT_FIELD_DEFAULT = 16;
const FRAGMENTS_PAGE_MAX = 8;
const FRAGMENTS_PAGE_DEFAULT = 4;
const TRAVERSALS_PAGE_MAX = 8;
const TRAVERSALS_PAGE_DEFAULT = 4;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

const MOVE_MODES: readonly MoveMode[] = ['walk', 'jump', 'sneak', 'swim', 'climb', 'ladder', 'drop'];

/** 原库 route 预算的公开上限。零值按原值传递。 */
const ROUTE_BUDGET_MAX = {
  maxNodes: 64,
  maxEdges: 512,
  maxHistoryReads: 256,
  maxDiagnostics: 16,
} as const;

/** 显式传入的默认预算；原库自身缺省上限过大，不能依赖。 */
const ROUTE_BUDGET_DEFAULT = {
  maxNodes: 32,
  maxEdges: 128,
  maxHistoryReads: 64,
  maxDiagnostics: 8,
} as const;

type RouteBudgetKey = keyof typeof ROUTE_BUDGET_MAX;

type Position = { x: number; y: number; z: number };
type FragmentField = 'polyline' | 'entrances' | 'links';

export type SpatialQueryArgs =
  | { kind: 'cells'; dim: string; positions: Position[] }
  | { kind: 'fragment'; dim: string; fragmentId: string; field?: FragmentField; offset?: number; limit?: number }
  | { kind: 'traversals'; dim: string; ids: string[] }
  | { kind: 'traversals'; dim: string; fragmentId: string; after?: string; limit?: number }
  | { kind: 'nodes'; dim: string; ids: string[] }
  | {
      kind: 'route';
      dim: string;
      fromNodeId: string;
      toNodeId: string;
      mode?: MoveMode;
      maxNodes?: number;
      maxEdges?: number;
      maxHistoryReads?: number;
      maxDiagnostics?: number;
    }
  | { kind: 'fragments'; dim: string; after?: string; limit: number };

function validDim(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DIM_LENGTH && value !== 'unknown';
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export const spatialQuery: Skill<SpatialQueryArgs> = {
  name: 'spatial_query',
  description:
    '只读查询共享空间记忆里已记录的事实：指定方块的最近观测证据与 Section 驻留状态、单个历史片段（polyline/entrances/links）的元数据分页、指定 traversal 记录（明确 ID 集合，或按 fragmentId 分页）、指定 node 记录、历史拓扑路线，以及按维度分页的片段索引。'
    + '返回的是历史几何或最近一次观测，不代表当前世界状态、当前可通行性、可执行点列或在线观察；不观察、不移动、不写入、不刷新证据时间。'
    + 'fragment 的 polyline 是原历史几何，按 geometrySource 区分来源；本次 Curio 行走 producer 输出的已确认 nominal 走廊前缀不是实测轨迹，不能仅由 geometrySource 推定具体生产者。对所有片段均不声称当前 passable。'
    + 'traversal 证据独立保存原起终点、时间、会话、执行、任务关联与 source，原样返回，不表示当前可通行。'
    + 'fragment 的 links 缺失只表示该数组未记录，不证明没有连接；route 的 FOUND 仅是历史连接证据，不代表现在可走。'
    + 'fragments 与 fragmentId 模式的 traversal 会在当前库的完整索引上按 dim（traversal 还按 fragmentId）过滤、排序后分页；limit 只限制本页返回条数，不是每页扫描量或 O(page)。',
  argsDoc:
    '{"kind":"cells","dim":"overworld","positions":[{"x":0,"y":64,"z":0}]}  // 1..32 格，safe integer 坐标；返回原坐标、section、residency 与原 CellEvidence\n'
    + '{"kind":"fragment","dim":"overworld","fragmentId":"id","field":"polyline|entrances|links","offset":0,"limit":16}  // field 默认 polyline；offset≥0；limit 1..32，超出拒绝不 clamp\n'
    + '{"kind":"traversals","dim":"overworld","ids":["t1"]}  // 与 fragmentId 互斥；1..8 个明确 ID，按原顺序逐个查询；不接受 after/limit\n'
    + '{"kind":"traversals","dim":"overworld","fragmentId":"id","after":"cursor","limit":4}  // 与 ids 互斥；after 为上一页 nextAfter；limit 默认 4、范围 1..8，超出拒绝不 clamp；返回 total/nextAfter/returned 与逐条原证据\n'
    + '{"kind":"nodes","dim":"overworld","ids":["n1"]}  // 1..8 个明确 ID，保留 agent/program 来源；node 无观测时间/会话\n'
    + '{"kind":"route","dim":"overworld","fromNodeId":"n1","toNodeId":"n2","mode":"walk","maxNodes":32,"maxEdges":128,"maxHistoryReads":64,"maxDiagnostics":8}  // 缺省用原库 32/128/64/8；显式值 0..64/512/256/16，零值按原值；mode 仅历史过滤；历史证据，非当前通行\n'
    + '{"kind":"fragments","dim":"overworld","after":"cursor","limit":4}  // limit 1..8；after 为上一页 nextAfter；只返回元数据与点数/首末点，不返回完整几何',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate(raw, _adapter) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'spatial_query 参数必须是对象' };
    const o = raw as Record<string, unknown>;
    if (!validDim(o.dim)) {
      return { ok: false, error: `dim 必须是非空、长度 ≤${MAX_DIM_LENGTH} 的具体维度，且不能是 unknown` };
    }
    const dim = o.dim;

    switch (o.kind) {
      case 'cells': {
        const positions = o.positions;
        if (!Array.isArray(positions) || positions.length < 1 || positions.length > MAX_CELLS) {
          return { ok: false, error: `cells.positions 需要 ${1}..${MAX_CELLS} 个位置` };
        }
        const parsed: Position[] = [];
        for (const p of positions) {
          if (p === null || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'positions 每项必须是 {x,y,z}' };
          const { x, y, z } = p as Record<string, unknown>;
          if (!validCoord(x) || !validCoord(y) || !validCoord(z)) {
            return { ok: false, error: 'positions 坐标必须是安全整数（不取整、不受理非有限值）' };
          }
          parsed.push({ x, y, z });
        }
        return { ok: true, args: { kind: 'cells', dim, positions: parsed } };
      }
      case 'fragment': {
        if (!validId(o.fragmentId)) return { ok: false, error: `fragmentId 必须是非空、长度 ≤${MAX_ID_LENGTH} 的字符串` };
        const field = o.field === undefined ? 'polyline' : o.field;
        if (field !== 'polyline' && field !== 'entrances' && field !== 'links') {
          return { ok: false, error: 'field 必须是 polyline、entrances 或 links' };
        }
        const offset = o.offset === undefined ? 0 : o.offset;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
          return { ok: false, error: 'offset 必须是非负安全整数' };
        }
        const limit = o.limit === undefined ? FRAGMENT_FIELD_DEFAULT : o.limit;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > FRAGMENT_FIELD_MAX) {
          return { ok: false, error: `limit 必须是 1..${FRAGMENT_FIELD_MAX} 的安全整数，超出时拒绝而不 clamp` };
        }
        return { ok: true, args: { kind: 'fragment', dim, fragmentId: o.fragmentId, field, offset, limit } };
      }
      case 'traversals': {
        const hasIds = o.ids !== undefined;
        const hasFragmentId = o.fragmentId !== undefined;
        if (hasIds === hasFragmentId) {
          return { ok: false, error: 'traversals 必须且只能提供 ids 或 fragmentId 之一' };
        }
        if (hasIds) {
          if (o.after !== undefined || o.limit !== undefined) {
            return { ok: false, error: 'ids 模式不接受 after/limit；分页控制仅用于 fragmentId 模式' };
          }
          const ids = o.ids;
          if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) {
            return { ok: false, error: `ids 需要 1..${MAX_IDS} 个明确 ID` };
          }
          const parsed: string[] = [];
          for (const id of ids) {
            if (!validId(id)) return { ok: false, error: `ids 每项必须是非空、长度 ≤${MAX_ID_LENGTH} 的字符串` };
            parsed.push(id);
          }
          return { ok: true, args: { kind: 'traversals', dim, ids: parsed } };
        }
        if (!validId(o.fragmentId)) return { ok: false, error: `fragmentId 必须是非空、长度 ≤${MAX_ID_LENGTH} 的字符串` };
        const after = o.after;
        if (after !== undefined && !validId(after)) {
          return { ok: false, error: `after 必须是非空、长度 ≤${MAX_ID_LENGTH} 的游标字符串` };
        }
        const limit = o.limit === undefined ? TRAVERSALS_PAGE_DEFAULT : o.limit;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > TRAVERSALS_PAGE_MAX) {
          return { ok: false, error: `limit 必须是 1..${TRAVERSALS_PAGE_MAX} 的安全整数，超出时拒绝而不 clamp` };
        }
        return {
          ok: true,
          args: { kind: 'traversals', dim, fragmentId: o.fragmentId, ...(after !== undefined ? { after } : {}), limit },
        };
      }
      case 'nodes': {
        const ids = o.ids;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) {
          return { ok: false, error: `ids 需要 1..${MAX_IDS} 个明确 ID` };
        }
        const parsed: string[] = [];
        for (const id of ids) {
          if (!validId(id)) return { ok: false, error: `ids 每项必须是非空、长度 ≤${MAX_ID_LENGTH} 的字符串` };
          parsed.push(id);
        }
        return { ok: true, args: { kind: 'nodes', dim, ids: parsed } };
      }
      case 'route': {
        if (!validId(o.fromNodeId)) return { ok: false, error: `fromNodeId 必须是非空、长度 ≤${MAX_ID_LENGTH} 的字符串` };
        if (!validId(o.toNodeId)) return { ok: false, error: `toNodeId 必须是非空、长度 ≤${MAX_ID_LENGTH} 的字符串` };
        const mode = o.mode;
        if (mode !== undefined && !MOVE_MODES.includes(mode as MoveMode)) {
          return { ok: false, error: `mode 必须是 ${MOVE_MODES.join('、')} 之一` };
        }
        const budgets: Partial<Record<RouteBudgetKey, number>> = {};
        for (const key of Object.keys(ROUTE_BUDGET_MAX) as RouteBudgetKey[]) {
          const value = o[key];
          if (value === undefined) continue;
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            return { ok: false, error: `${key} 必须是非负安全整数（零按原值传递）` };
          }
          if (value > ROUTE_BUDGET_MAX[key]) {
            return { ok: false, error: `${key} 不能超过公开上限 ${ROUTE_BUDGET_MAX[key]}` };
          }
          budgets[key] = value;
        }
        return {
          ok: true,
          args: {
            kind: 'route',
            dim,
            fromNodeId: o.fromNodeId,
            toNodeId: o.toNodeId,
            ...(mode !== undefined ? { mode: mode as MoveMode } : {}),
            ...budgets,
          },
        };
      }
      case 'fragments': {
        const after = o.after;
        if (after !== undefined && !validId(after)) {
          return { ok: false, error: `after 必须是非空、长度 ≤${MAX_ID_LENGTH} 的游标字符串` };
        }
        const limit = o.limit === undefined ? FRAGMENTS_PAGE_DEFAULT : o.limit;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > FRAGMENTS_PAGE_MAX) {
          return { ok: false, error: `limit 必须是 1..${FRAGMENTS_PAGE_MAX} 的安全整数` };
        }
        return { ok: true, args: { kind: 'fragments', dim, ...(after !== undefined ? { after } : {}), limit } };
      }
      default:
        return { ok: false, error: 'kind 必须是 cells、fragment、traversals、nodes、route 或 fragments' };
    }
  },

  async run(ctx, args) {
    if (ctx.signal.aborted) return { status: 'cancelled', summary: '空间查询已取消', data: { reason: 'aborted' } };
    if (Date.now() >= ctx.deadline) return fail('TIMEOUT', 'spatial_query 超过调用期限', { reason: 'deadline_exceeded' });

    const spatial = ctx.spatial;
    if (!spatial) return fail('ERROR', 'spatial_query 需要宿主共享空间会话（ctx.spatial）', { reason: 'spatial_session_unavailable' });
    if (spatial.closing) return fail('ERROR', '共享空间会话正在关闭，未执行查询', { reason: 'spatial_session_closing' });
    if (spatial.session.lifecycle !== 'open') {
      return fail('ERROR', '共享空间会话不在 open 生命周期，未执行查询', {
        reason: 'spatial_session_not_open',
        lifecycle: spatial.session.lifecycle,
      });
    }

    const worldId = spatial.worldId;
    const scope = { worldId, dim: args.dim };
    const history = spatial.session.history;
    const topology = spatial.session.topology;
    let query: Record<string, unknown>;
    let summary: string;

    switch (args.kind) {
      case 'cells': {
        const assessedAt = Date.now();
        const results = args.positions.map((pos) => {
          const section = blockToSection(pos.x, pos.y, pos.z);
          const residency = spatial.session.voxel.sectionResidency({
            worldId,
            dim: args.dim,
            cx: section.cx,
            cz: section.cz,
            sy: section.sy,
          });
          const cell = spatial.session.voxel.cellAt(args.dim, pos.x, pos.y, pos.z);
          const sectionCoords = { cx: section.cx, cz: section.cz, sy: section.sy };
          if (!cell.observed) {
            const unavailable = residency.residency === 'not_resident' || residency.residency === 'loading' || residency.residency === 'load_failed';
            return {
              pos,
              section: sectionCoords,
              residency,
              availability: unavailable ? 'unavailable_history' : 'unknown',
            };
          }
          const effectiveFreshness = cell.evidence.freshness === 'STALE'
            ? 'STALE'
            : assessedAt > cell.evidence.validUntil
              ? 'EXPIRED'
              : 'FRESH';
          return {
            pos,
            section: sectionCoords,
            residency,
            availability: 'observed',
            effectiveFreshness,
            ...(cell.evidence.staleReason !== undefined ? { staleReason: cell.evidence.staleReason } : {}),
            evidence: cell.evidence,
          };
        });
        query = {
          kind: 'cells',
          scope,
          assessedAt,
          requested: args.positions.length,
          returned: results.length,
          freshnessNote: 'effectiveFreshness 由 assessedAt 与原 freshness/validUntil 派生；原 evidence 与时间未被改写',
          results,
        };
        summary = `查询了 ${results.length} 格的已记录空间事实（观测/未知/历史不可用）`;
        break;
      }
      case 'fragment': {
        const field = args.field ?? 'polyline';
        const offset = args.offset ?? 0;
        const limit = args.limit ?? FRAGMENT_FIELD_DEFAULT;
        const requested = { fragmentId: args.fragmentId, field, offset, limit };
        const fragmentScope = history.getFragmentScope(args.fragmentId);
        if (!fragmentScope) {
          query = { kind: 'fragment', scope, requested, found: false, reason: 'not_found' };
          summary = `未找到历史片段 ${args.fragmentId}`;
          break;
        }
        if (fragmentScope.worldId !== worldId || fragmentScope.dim !== args.dim) {
          query = {
            kind: 'fragment',
            scope,
            requested,
            found: false,
            reason: 'scope_mismatch',
            actualScope: { worldId: fragmentScope.worldId, dim: fragmentScope.dim },
          };
          summary = `历史片段 ${args.fragmentId} 的作用域与请求不符`;
          break;
        }
        const fragment = history.getFragment(args.fragmentId);
        if (!fragment) {
          query = { kind: 'fragment', scope, requested, found: false, reason: 'not_found' };
          summary = `未找到历史片段 ${args.fragmentId}`;
          break;
        }
        const selected = field === 'links' ? fragment.links : fragment[field];
        const total = selected?.length ?? 0;
        const page = selected === undefined ? [] : selected.slice(offset, offset + limit);
        const nextOffset = selected !== undefined && offset + page.length < total ? offset + page.length : undefined;
        query = {
          kind: 'fragment',
          scope,
          requested,
          found: true,
          fragment: {
            id: fragment.id,
            worldId: fragment.worldId,
            dim: fragment.dim,
            kind: fragment.kind,
            geometrySource: fragment.geometrySource,
            createdAt: fragment.createdAt,
            lastUsedAt: fragment.lastUsedAt,
            uses: fragment.uses,
            deepestY: fragment.deepestY,
            [field]: {
              recorded: selected !== undefined,
              total,
              offset,
              returned: page.length,
              ...(nextOffset !== undefined ? { nextOffset } : {}),
              items: page,
              ...(field === 'links' && selected === undefined
                ? { note: '该片段的 links 数组未记录；这不证明没有连接' }
                : {}),
            },
            observation: { known: false, sessionId: null, observedAt: null },
            currentPassability: 'unknown',
            provenance: 'history_geometry',
          },
        };
        summary = `读取历史片段 ${fragment.id} 的 ${field}（${page.length}/${total}，按 offset/${limit}）`;
        break;
      }
      case 'traversals': {
        if ('ids' in args) {
          const items = args.ids.map((id) => {
            const record = history.getTraversal(id);
            if (!record) return { id, status: 'not_found' as const };
            if (record.worldId !== worldId || record.dim !== args.dim) {
              return {
                id,
                status: 'scope_mismatch' as const,
                actualScope: { worldId: record.worldId, dim: record.dim },
                record,
              };
            }
            return { id, status: 'found' as const, record };
          });
          query = { kind: 'traversals', mode: 'ids', scope, requested: args.ids.length, returned: items.length, items };
          summary = `逐个查询 ${items.length} 个 traversal ID（保留原顺序与缺失/作用域不符）`;
          break;
        }

        const limit = args.limit ?? TRAVERSALS_PAGE_DEFAULT;
        const requested = {
          selector: 'fragmentId',
          fragmentId: args.fragmentId,
          after: args.after ?? null,
          limit,
        };
        const fragmentScope = history.getFragmentScope(args.fragmentId);
        if (!fragmentScope) {
          query = {
            kind: 'traversals',
            mode: 'fragment',
            scope,
            requested,
            found: false,
            reason: 'not_found',
            note: '未找到该 fragmentId 的 scope；未跨维度枚举 traversal',
          };
          summary = `未找到历史片段 ${args.fragmentId}，未执行 traversal 分页`;
          break;
        }
        if (fragmentScope.worldId !== worldId || fragmentScope.dim !== args.dim) {
          query = {
            kind: 'traversals',
            mode: 'fragment',
            scope,
            requested,
            found: false,
            reason: 'scope_mismatch',
            actualScope: { worldId: fragmentScope.worldId, dim: fragmentScope.dim },
            note: '片段作用域与请求不符；未跨维度枚举 traversal',
          };
          summary = `历史片段 ${args.fragmentId} 的作用域与请求不符，未执行 traversal 分页`;
          break;
        }

        const page = history.traversals({
          dim: args.dim,
          fragmentId: args.fragmentId,
          ...(args.after !== undefined ? { after: args.after } : {}),
          limit,
        });
        const items = page.items.map((record) => ({ id: record.id, status: 'found' as const, record }));
        query = {
          kind: 'traversals',
          mode: 'fragment',
          scope,
          requested,
          found: true,
          fragmentId: args.fragmentId,
          page: {
            after: args.after ?? null,
            limit,
            total: page.total,
            returned: items.length,
            ...(page.nextAfter !== undefined ? { nextAfter: page.nextAfter } : {}),
            scan: 'full_traversal_index_filter_sort',
            scanNote: '0.7.6 在当前 traversal 索引上按 dim/fragmentId 过滤、按 id 排序后取一页；limit 只限制返回条数，不是每页扫描量或恒定 CPU。当前 SharedSession 默认 maxTraversals=10000，查询工作量受该索引容量约束。',
          },
          items,
          interpretation: {
            historicalEvidence: true,
            currentPassability: 'not_assessed',
            note: '返回的是历史 traversal 证据；页面为空或来源/时间未知不代表从未经过或当前不通，不能当作当前 passability',
          },
        };
        summary = `按片段 ${args.fragmentId} 分页查询历史 traversal：返回 ${items.length}/${page.total}（after=${args.after ?? 'null'}，limit=${limit}）`;
        break;
      }
      case 'nodes': {
        const items = args.ids.map((id) => {
          const node = topology.getNode(id);
          if (!node) return { id, status: 'not_found' as const };
          const observation = { known: false, sessionId: null, observedAt: null };
          if (node.worldId !== worldId || node.dim !== args.dim) {
            return {
              id,
              status: 'scope_mismatch' as const,
              actualScope: { worldId: node.worldId, dim: node.dim },
              node,
              observation,
            };
          }
          return { id, status: 'found' as const, node, observation };
        });
        query = { kind: 'nodes', scope, requested: args.ids.length, returned: items.length, items };
        summary = `逐个查询 ${items.length} 个空间节点（保留 agent/program 来源；观测时间/会话未知）`;
        break;
      }
      case 'route': {
        const budgets = {
          maxNodes: args.maxNodes ?? ROUTE_BUDGET_DEFAULT.maxNodes,
          maxEdges: args.maxEdges ?? ROUTE_BUDGET_DEFAULT.maxEdges,
          maxHistoryReads: args.maxHistoryReads ?? ROUTE_BUDGET_DEFAULT.maxHistoryReads,
          maxDiagnostics: args.maxDiagnostics ?? ROUTE_BUDGET_DEFAULT.maxDiagnostics,
        };
        const requested = {
          fromNodeId: args.fromNodeId,
          toNodeId: args.toNodeId,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          budgets,
        };
        const interpretation = {
          historicalRecordedConnections: true,
          currentPassability: 'not_assessed',
          executablePointList: false,
          note: 'FOUND 仅表示历史连接证据成立，不代表当前可通行或可执行',
        };
        let metadataReads = 0;
        const from = topology.getNode(args.fromNodeId);
        metadataReads += 1;
        if (!from) {
          query = { kind: 'route', scope, requested, metadataReads, result: 'not_found', start: { status: 'not_found' }, interpretation };
          summary = `历史路线未查询：起点节点 ${args.fromNodeId} 不存在`;
          break;
        }
        if (from.worldId !== worldId || from.dim !== args.dim) {
          query = {
            kind: 'route',
            scope,
            requested,
            metadataReads,
            result: 'scope_mismatch',
            start: { status: 'scope_mismatch', actualScope: { worldId: from.worldId, dim: from.dim } },
            interpretation,
          };
          summary = `历史路线未查询：起点节点作用域与请求不符`;
          break;
        }
        const to = topology.getNode(args.toNodeId);
        metadataReads += 1;
        if (!to) {
          query = {
            kind: 'route',
            scope,
            requested,
            metadataReads,
            result: 'not_found',
            start: { status: 'ok' },
            target: { status: 'not_found' },
            interpretation,
          };
          summary = `历史路线未查询：终点节点 ${args.toNodeId} 不存在`;
          break;
        }
        if (to.worldId !== worldId || to.dim !== args.dim) {
          query = {
            kind: 'route',
            scope,
            requested,
            metadataReads,
            result: 'scope_mismatch',
            start: { status: 'ok' },
            target: { status: 'scope_mismatch', actualScope: { worldId: to.worldId, dim: to.dim } },
            interpretation,
          };
          summary = `历史路线未查询：终点节点作用域与请求不符`;
          break;
        }
        const route = topology.route(args.fromNodeId, args.toNodeId, {
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...budgets,
        });
        query = {
          kind: 'route',
          scope,
          requested,
          metadataReads,
          route,
          interpretation,
        };
        summary = `历史路线查询完成：${route.status}；仅表示已记录连接证据，不代表当前通行`;
        break;
      }
      case 'fragments': {
        const page = history.fragments({
          dim: args.dim,
          ...(args.after !== undefined ? { after: args.after } : {}),
          limit: args.limit,
        });
        const fragments = page.items.map((fragment) => ({
          id: fragment.id,
          worldId: fragment.worldId,
          dim: fragment.dim,
          kind: fragment.kind,
          geometrySource: fragment.geometrySource,
          createdAt: fragment.createdAt,
          lastUsedAt: fragment.lastUsedAt,
          uses: fragment.uses,
          deepestY: fragment.deepestY,
          polyline: {
            points: fragment.polyline.length,
            first: fragment.polyline[0] ?? null,
            last: fragment.polyline.at(-1) ?? null,
          },
          entrances: {
            points: fragment.entrances.length,
            first: fragment.entrances[0] ?? null,
            last: fragment.entrances.at(-1) ?? null,
          },
          links: fragment.links === undefined
            ? { recorded: false, note: 'links 数组未记录；不证明没有连接' }
            : {
                recorded: true,
                points: fragment.links.length,
                first: fragment.links[0] ?? null,
                last: fragment.links.at(-1) ?? null,
              },
          observation: { known: false, sessionId: null, observedAt: null },
          currentPassability: 'unknown',
          provenance: 'history_geometry',
        }));
        query = {
          kind: 'fragments',
          scope,
          page: {
            after: args.after ?? null,
            limit: args.limit,
            total: page.total,
            returned: fragments.length,
            ...(page.nextAfter !== undefined ? { nextAfter: page.nextAfter } : {}),
            scan: 'full_index_filter_sort',
            scanNote: '当前库先对完整片段索引按 dim 过滤、排序，再取一页；limit 只限制返回条数，不是每页扫描量或 O(page)',
          },
          fragments,
        };
        summary = `片段索引查询完成：返回 ${fragments.length}/${page.total}（dim=${args.dim}，limit=${args.limit}）`;
        break;
      }
    }

    const data = { spatialQuery: query };
    const serializedBytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (serializedBytes > OUTPUT_LIMIT_BYTES) {
      return fail('ERROR', `空间查询结果序列化 ${serializedBytes} 字节，超过 ${OUTPUT_LIMIT_BYTES} 字节预算；未返回任何截断证据`, {
        spatialQuery: {
          kind: args.kind,
          scope,
          result: 'result_too_large',
          serializedBytes,
          limitBytes: OUTPUT_LIMIT_BYTES,
          truncated: false,
        },
      });
    }
    return ok(summary, data);
  },
};
