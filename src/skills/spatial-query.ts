/**
 * spatial_query：契约查询端口的薄适配（契约 §5，Curio 计划 v2 §3.3 C1–C3）。
 *
 * 宿主不维护第二套查询投影，也不复刻库的请求 schema：15 种 kind 的字段、枚举、
 * 上限与未知字段都由库自己的 validator 在 `SharedSpatialSession.query` 的委托
 * 边界上校验（`invalid_request`）。本技能只做 skill 边界（参数必须是对象）、
 * 生命周期检查、调用委托和结果信封转发。
 *
 * 查询只读：不观察、不移动、不加载 Section、不刷新证据时间、不写库。历史几何与
 * 观测证据都不代表当前可通行性；容器内容永远不进入空间库。
 */
import type { SpatialQueryResult, SpatialQueryStatus } from 'curio-minecraft-3d-memory';
import { fail, ok, type Skill } from './types.ts';

/** 宿主响应体积保护：超过即如实失败，不截断。不是对 limit 的静默 clamp。 */
const OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * 宿主组合能力：与库的 `capabilities` 报告使用同一组键（contract/memory/query/
 * plan/execute/persistence），便于逐键取交集；额外 `owner`/`note` 明确标为宿主。
 * 值只反映宿主当前真实接线，未接线一律 false，不冒充库能力。
 */
const HOST_COMPOSED_CAPABILITIES = {
  owner: 'host_composed',
  note: '宿主真实接线；未接线/未知为 false，不是库 SpatialQueryPort 的报告',
  contract: 'memory-host-contract/1',
  memory: {
    observeBatch: true,
    beginSession: true,
    markStale: true,
    markTraversed: true,
    markModified: true,
    saveFragment: true,
    addTraversal: true,
    recordNode: true,
    // 宿主边写入经 SharedSpatialSession.session.topology.saveEdge（保留 directed/modes）；
    // MemoryIngest.upsertEdge facade 会丢弃二者，但库 upsertEdge 能力本身可用。
    upsertEdge: true,
    savePortalEdge: false,
    checkpoint: true,
    flush: false,
    close: true,
  },
  query: {
    cells: true,
    fragments: true,
    traversals: true,
    nodes: true,
    edges: true,
    historyRoute: true,
    anchors: true,
    components: true,
    segments: true,
    portals: true,
    resourceAnchors: true,
    containerAnchors: false,
    containerContents: false,
  },
  plan: {
    walkSearch: true,
    walkHistory: true,
    walkAuto: true,
    nearArrival: false,
    reachBlockArrival: false,
    digPlaceTower: false,
    swim: false,
    boat: false,
  },
  execute: {
    walk: true,
    groundedArrival: true,
    invalidation: true,
    cancellation: true,
    swim: false,
    boat: false,
  },
  persistence: {
    sqlite: true,
    manualResidency: true,
    workingSet: true,
    migrationAuthoritySwitch: false,
  },
} as const;

export type SpatialQueryArgs = Record<string, unknown>;

function kindOf(request: Record<string, unknown>): string {
  return typeof request.kind === 'string' ? request.kind : '未知 kind';
}

function summaryOf(kind: string, result: SpatialQueryResult): string {
  const total = result.total === undefined ? '' : `，共 ${result.total}`;
  const detail = result.problem !== undefined && 'detail' in result.problem ? `：${result.problem.detail}` : '';
  const status: SpatialQueryStatus = result.status;
  switch (status) {
    case 'ok':
      return `${kind} 查询完成${total}；只读历史/观测事实，不代表当前可通行或可执行`;
    case 'partial':
      return `${kind} 查询部分完成：部分 Section 未驻留${total}；未返回的格不是空气`;
    case 'not_found':
      return `${kind} 未找到记录${detail}`;
    case 'unsupported':
      return `${kind} 不支持${detail}`;
    case 'scope_mismatch':
      return `${kind} 作用域不符${detail}`;
    case 'invalid_request':
      return `${kind} 参数无效${detail}`;
  }
}

export const spatialQuery: Skill<SpatialQueryArgs> = {
  name: 'spatial_query',
  description:
    '只读查询共享空间记忆的契约端口（契约 §5）：15 种 kind —— cells、fragments、traversals、nodes、edges、historyRoute、anchor、components、segments、portals、resourceAnchors、containerAnchors、containerContents、snapshot、capabilities。'
    + '返回契约 SpatialQueryResult 信封（status/contract/worldId/dim/sessionId/computedAt/readOnly:true/executable:false/data/problem/total/nextAfter）；data 是库的原样分页/投影，不再由宿主改写。'
    + '历史几何与最近观测都不代表当前可通行、可执行或在线观察；不观察、不移动、不加载 Section、不刷新证据时间、不写库。'
    + 'containerContents 固定 unsupported + problem.kind:"host_ledger"（不会用 items:[] 冒充空箱）；本宿主未配置容器分类器，containerAnchors 如实 unsupported。'
    + '旧 kind 已移除：fragment 改用 fragments（含完整 polyline），route 改用 historyRoute 或 nodes/edges，ids 模式改用过滤条件 + after/limit。'
    + 'kind==="capabilities" 时，库报告原样在信封的 data.capabilities；信封顶层另加 hostComposed（与信封 data 同级、owner:"host_composed"）列出宿主真实能力。',
  argsDoc:
    '15 种 kind 与契约 §5.2 相同；所有字段/枚举/未知字段/上限（列表默认 100、最大 1000；cells 最多 4096 个整数坐标）由库 validator 校验，非法请求返回 invalid_request（技能映射为 BAD_ARGS）。'
    + '{"kind":"cells","dim":"overworld","positions":[{"x":0,"y":64,"z":0}]}  // observed 为 false 时看 residency/unobservedReason/gap\n'
    + '{"kind":"fragments","dim":"overworld","fragmentKind":"walked|dug|bridge|built","geometrySource":"traversal|observed_structure|legacy","after":"cursor","limit":100}  // 库原样 PathFragment 页（含 polyline）\n'
    + '{"kind":"traversals","dim":"overworld","fragmentId":"f1","after":"cursor","limit":100}\n'
    + '{"kind":"nodes","dim":"overworld","tag":"base|...|portal","label":"x","source":"agent|program","after":"cursor","limit":100}\n'
    + '{"kind":"edges","dim":"overworld","from":"n1","to":"n2","type":"HORIZONTAL|...","basis":"candidate|traversed","after":"cursor","limit":100}\n'
    + '{"kind":"historyRoute","dim":"overworld","from":{"x":0,"y":64,"z":0},"to":{"x":10,"y":64,"z":0},"near":5}  // historicalGeometry:true、executable:false、currentPassability:"UNKNOWN"\n'
    + '{"kind":"anchor","dim":"overworld","here":{"x":0,"y":64,"z":0},"order":"surface|deepest","near":6}  // null 是有效答案\n'
    + '{"kind":"components","dim":"overworld"}  // 只读重算，不写组件缓存\n'
    + '{"kind":"segments","fragmentId":"f1"}  // 未知片段返回 not_found\n'
    + '{"kind":"portals","after":"cursor","limit":100}\n'
    + '{"kind":"resourceAnchors","dim":"overworld","tag":"...","label":"x","after":"cursor","limit":100}\n'
    + '{"kind":"containerAnchors","dim":"overworld","after":"cursor","limit":100}  // 本宿主无分类器，固定 unsupported\n'
    + '{"kind":"containerContents","dim":"overworld"}  // 固定 unsupported + host_ledger，无 data\n'
    + '{"kind":"snapshot"}\n'
    + '{"kind":"capabilities"}  // 技能结果 data.data.capabilities 是库报告；技能结果 data.hostComposed（信封顶层，与信封 data 同级）是宿主组合报告（owner:"host_composed"）\n'
    + '宿主响应超过 64 KiB 时返回结构化 result_too_large，不截断证据。',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate(raw) {
    // 只做 skill 边界检查；请求 schema 由库在唯一委托点校验。
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'spatial_query 参数必须是对象' };
    }
    return { ok: true, args: raw as Record<string, unknown> };
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

    // 请求原样交给会话；库 validator 是唯一的 schema 边界。
    const result = spatial.query(args);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(result)).length;
    if (serializedBytes > OUTPUT_LIMIT_BYTES) {
      return fail('ERROR', `空间查询结果序列化 ${serializedBytes} 字节，超过 ${OUTPUT_LIMIT_BYTES} 字节预算；未返回任何截断证据`, {
        kind: kindOf(args),
        status: result.status,
        result: 'result_too_large',
        serializedBytes,
        limitBytes: OUTPUT_LIMIT_BYTES,
        truncated: false,
      });
    }

    const envelope: Record<string, unknown> = { ...result };
    // 双报告：库信封与形状原样保留，宿主组合能力单独标注 owner。
    if (result.data?.kind === 'capabilities') envelope.hostComposed = HOST_COMPOSED_CAPABILITIES;
    if (result.status === 'invalid_request') {
      return fail('BAD_ARGS', summaryOf(kindOf(args), result), envelope);
    }
    return ok(summaryOf(kindOf(args), result), envelope);
  },
};
