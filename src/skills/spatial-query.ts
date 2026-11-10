/**
 * spatial_query：契约查询端口的薄适配（契约 §5，Curio 计划 v2 §3.3 C1–C3）。
 *
 * 宿主不维护第二套查询投影，也不复刻库的请求 schema：各 kind 的字段、枚举、
 * 上限与未知字段都由库自己的 validator 在 `SharedSpatialSession.query` 的委托
 * 边界上校验（`invalid_request`）。本技能只做 skill 边界（参数必须是对象）、
 * 生命周期检查、调用委托和结果信封转发。
 *
 * 查询只读：不观察、不移动、不加载 Section、不刷新证据时间、不写库。历史几何与
 * 观测证据都不代表当前可通行性；容器内容永远不进入空间库。
 *
 * Frontier（D-V4-026）：库 0.10.1-workflow.8 的 validator 已接受 additive `frontiers`，
 * 但宿主没有 `frontierSource` 注入点，也没有 `WalkSearchSnapshot` 生产者。因此宿主能力位
 * 固定 false，`{kind:"frontiers"}` 得到库的结构化 unsupported（精确缺失能力），而不是候选
 * 或空列表；宿主不建影子地图/索引，也不在查询内启动搜索。
 *
 * 路线/片段/拓扑查询（fragments/traversals/historyRoute/components/segments/edges）已不再是
 * 导航依据；宿主在入口返回结构化 unsupported + reason:"route_retired"，不调用库、也不返回
 * 空列表冒充“没有记录”。语义查询 nodes/resourceAnchors/containerAnchors 只读 facts；传送门端点用 nodes tag:portal，旧路线锚点和旧 portal edges 查询退役。
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
    // 路线/片段/拓扑写入入口已退役；宿主不再声明这些写能力（键本身已删除，
    // 不存在即未接线，不以 false 占位）。
    checkpoint: true,
    flush: false,
    close: true,
  },
  query: {
    cells: true,
    // 路线/片段/拓扑查询不再作为导航依据暴露；宿主在 run 边界返回结构化 unsupported。
    fragments: false,
    traversals: false,
    nodes: true,
    edges: false,
    historyRoute: false,
    anchors: false,
    components: false,
    segments: false,
    portals: false,
    resourceAnchors: true,
    containerAnchors: true,
    containerContents: false,
    // D-V4-026：库 .8 接受该 kind，但宿主未注入 `frontierSource`（SharedSpatialSession
    // 构造 SpatialMemoryStoreImpl 时没有该参数），也没有快照生产者；查询返回库的
    // 结构化 unsupported，能力位如实为 false，不建第二张地图/索引或查询内搜索。
    frontiers: false,
  },
  plan: {
    // 宿主不再用库的 walkSearch/routeId 规划；navigate_to/advance 直接消费 VoxelMap。
    walkSearch: false,
    walkHistory: false,
    walkAuto: false,
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

/** 已退役的路线/片段/拓扑查询 kind；返回结构化 unsupported，不返回空列表冒充无记录。 */
const RETIRED_QUERY_KINDS = new Set(['fragments', 'traversals', 'historyRoute', 'components', 'segments', 'edges', 'anchor', 'portals']);

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
    '只读查询共享空间记忆的契约端口（契约 §5）：cells、nodes、places、resourceAnchors、containerAnchors、containerContents、snapshot、capabilities。'
    + '路线/片段/拓扑 kind（fragments、traversals、historyRoute、components、segments、edges、anchor、portals）已退役，返回结构化 unsupported + reason:"route_retired"，不返回空列表冒充无记录；导航请用 navigate_to/advance。'
    + '返回契约 SpatialQueryResult 信封（status/contract/worldId/dim/sessionId/computedAt/readOnly:true/executable:false/data/problem/total/nextAfter）；data 是库的原样分页/投影，不再由宿主改写。'
    + '历史几何与最近观测都不代表当前可通行、可执行或在线观察；不观察、不移动、不加载 Section、不刷新证据时间、不写库。'
    + 'containerContents 固定 unsupported + problem.kind:"host_ledger"（不会用 items:[] 冒充空箱）；containerAnchors 只读 facts 中未消失的精确容器/熔炉锚点，contents 仍由宿主精确账本回答。resourceAnchors 默认排除已标 gone 的资源；需要历史记录时显式 includeGone:true。'
    + 'places 是仅地点流的有界分页（tag/label/source/includeGone/after/limit），data.pageSource="memory" 表示回答来自内存事实权威，不是持久化冷页读取；没有逐页冷读接口，宿主不伪造。'
    + '分页统一用 after/limit；旧 fragment/route/historyRoute 查询已随路线片段读面退役。'
    + 'kind==="capabilities" 时，库报告原样在信封的 data.capabilities；信封顶层另加 hostComposed（与信封 data 同级、owner:"host_composed"）列出宿主真实能力。',
  argsDoc:
    '所有字段/枚举/未知字段/上限（列表默认 100、最大 1000；cells 最多 4096 个整数坐标）由库 validator 校验，非法请求返回 invalid_request（技能映射为 BAD_ARGS）。'
    + '{"kind":"cells","dim":"overworld","positions":[{"x":0,"y":64,"z":0}]}  // observed 为 false 时看 residency/unobservedReason/gap\n'
    + '{"kind":"nodes","dim":"overworld","tag":"base|...|portal","label":"x","source":"agent|program","after":"cursor","limit":100}  // 语义节点；旧路线节点不作为导航依据\n'
    + '{"kind":"nodes","tag":"portal","after":"cursor","limit":100}  // 传送门端点，不推断连接\n'
    + '{"kind":"places","dim":"overworld","tag":"base","label":"x","source":"agent|program","includeGone":false,"after":"cursor","limit":100}  // 地点专用分页；pageSource:"memory" 是内存事实权威，不是持久化冷读\n'
    + '路线/片段/拓扑 kind（fragments、traversals、historyRoute、components、segments、edges、anchor、portals）已退役，传入会返回 unsupported；导航请用 navigate_to/advance。\n'
    + '{"kind":"resourceAnchors","dim":"overworld","tag":"...","label":"x","includeGone":false,"after":"cursor","limit":100}  // 默认排除 gone；includeGone:true 才返回历史\n'
    + '{"kind":"containerAnchors","dim":"overworld","after":"cursor","limit":100}  // exact 容器/熔炉锚点；默认排除 gone\n'
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
    // 退役的路线查询在宿主入口明确拒绝，不调用库、也不返回空列表冒充“没有记录”。
    if (typeof args.kind === 'string' && RETIRED_QUERY_KINDS.has(args.kind)) {
      return ok(`${args.kind} 查询已退役：路线/片段/拓扑不再作为导航依据；需要移动请用 navigate_to/advance`, {
        status: 'unsupported', contract: 'memory-host-contract/1', kind: args.kind, reason: 'route_retired',
        readOnly: true, executable: false,
      });
    }

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
