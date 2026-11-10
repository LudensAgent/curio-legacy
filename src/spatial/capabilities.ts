/**
 * 宿主能力协商（契约 §2.3、§13.1；Curio 计划 v2 B1/B6）。
 *
 * 唯一来源是库的 `capabilities` 查询：`SharedSpatialSession.query({kind:'capabilities'})`
 * 返回的 `MemoryHostCapabilities` 是库对自身实际实现的事实报告，`false` 是契约事实。
 * 宿主只读它、按它门禁，不维护第二份“库能力”副本；共享会话真正拥有的持久化
 * 生命周期（checkpoint/flush/close）单独标注为宿主组合，避免把它误认为库的 memory 能力。
 *
 * 启动日志只输出有界摘要（契约版本与各域 false 键），完整报告按需查询。
 *
 * 路线/片段/拓扑写入已随旧导航体系退役：`MemoryWriteCapability` 只列共享会话
 * 仍真正接线并使用的体素写与观测入口；库报告里的历史写键不再由生产组合提供，
 * 宿主也不再声明、不再调用。生产查询组合只读 `session.voxel` 与 `session.facts`
 * （`shared-session.ts`），不经过旧 fragment/topology 域。
 */
import {
  CAPABILITY_DOMAINS,
  composeCapabilities,
  CONTRACT_VERSION,
  type ComposedCapabilityReport,
  type MemoryHostCapabilities,
  type SpatialQueryResult,
} from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from './shared-session.ts';

/**
 * 宿主执行能力。v0.11 库不再报告 `execute` 域，也不再执行身体移动：
 * 这些位是宿主自己的接线事实，不能伪装成库能力或库交集。
 */
export type HostExecutionCapability = 'walk' | 'groundedArrival' | 'invalidation' | 'cancellation' | 'swim' | 'boat';
export type HostExecutionReport = Record<HostExecutionCapability, boolean>;

/** 库能力域 + 宿主独有的 execute 扩展（不属于 MemoryHostCapabilities）。 */
export type CapabilityDomain = keyof Omit<MemoryHostCapabilities, 'contract'> | 'execute';

/**
 * 共享会话仍接线的库 memory 写入能力名（契约 §2.3 的子集）：观测准入与体素写。
 * 路线/片段/拓扑写入键（saveFragment/addTraversal/recordNode/upsertEdge/
 * savePortalEdge）已随旧体系退役，不再由宿主声明或调用。
 */
export type MemoryWriteCapability =
  | 'beginSession' | 'observeBatch' | 'markStale' | 'markTraversed' | 'markModified';

/**
 * 宿主组合报告：库报告逐键 + 宿主真正拥有的持久化生命周期与执行接线。
 *
 * `library` 是库的事实，原样保留；`host` 是宿主自己的接线事实。库能力的
 * `effective` 仍是 `library AND host`；`effective.execute` 是宿主自己的扩展，
 * 不与已删除的库 execute 域取交集，也不冒充库实现。
 */
export interface HostCapabilityReport {
  owner: 'host_composed';
  contract: MemoryHostCapabilities['contract'];
  /** 库报告原样；宿主不得改写其中任何值，包括把 false 改成 true。 */
  library: MemoryHostCapabilities;
  /** 共享会话真正实现的生命周期方法与宿主身体移动接线。 */
  host: { checkpoint: true; flush: true; close: true; execute: HostExecutionReport };
  /** 库能力交集 + 宿主 execute 扩展；所有调用门禁读这里。 */
  effective: MemoryHostCapabilities & { execute: HostExecutionReport };
  /** 宿主声明为 true、库报告为 false 的能力（诊断用，不会放宽 effective）。 */
  overclaims: ComposedCapabilityReport['overclaims'];
}

/** 调用点的能力门禁：库报告为 false 时不得调用，也不得回退到更宽的旧后端；execute 只读宿主接线。 */
export type CapabilityGate = (domain: CapabilityDomain, name: string) => boolean;

/** 启动时读取一次能力报告；查询失败或契约版本不符时抛错，不静默当成全 false。 */
export function readHostCapabilities(spatial: Pick<SharedSpatialSession, 'query'>): HostCapabilityReport {
  const result: SpatialQueryResult = spatial.query({ kind: 'capabilities' });
  if (result.status !== 'ok' || result.data?.kind !== 'capabilities') {
    const detail = result.problem !== undefined && 'detail' in result.problem ? `：${result.problem.detail}` : '';
    throw new Error(`memory host capabilities are unavailable (${result.status})${detail}`);
  }
  const library = result.data.capabilities;
  if (library.contract !== CONTRACT_VERSION) {
    throw new Error(`memory host contract "${library.contract}" is not ${CONTRACT_VERSION}`);
  }
  // 宿主身体移动由 runSkill(navigate_to) → coordinator/segment → adapter 执行；
  // 库不执行行走。swim/boat 仍无宿主执行器，按 false 报告。
  const execute: HostExecutionReport = {
    walk: true,
    groundedArrival: true,
    invalidation: true,
    cancellation: true,
    swim: false,
    boat: false,
  };
  // 库能力只按 library 自报，宿主声明为空；execute 不参与库交集。
  const composed = composeCapabilities(library);
  return {
    owner: 'host_composed',
    contract: library.contract,
    library,
    host: { checkpoint: true, flush: true, close: true, execute: { ...execute } },
    effective: { ...composed.effective, execute: { ...execute } },
    overclaims: composed.overclaims,
  };
}

/** 逐域读取一个能力位；execute 只读宿主实际接线，其它域读库/宿主交集。 */
export function capabilityGate(report: HostCapabilityReport): CapabilityGate {
  return (domain, name) => {
    if (domain === 'execute') return report.host.execute[name as HostExecutionCapability] === true;
    // Effective is already library AND host, but intersecting with the live
    // library value again keeps a test/controlled override of `library` from
    // being masked by a stale precomputed `effective`.
    const library = report.library[domain] as Record<string, boolean | undefined>;
    const effective = report.effective[domain] as Record<string, boolean | undefined>;
    return library[name] === true && effective[name] === true;
  };
}

/** 执行能力门禁：宿主未提供时抛结构化 unsupported，不进入身体调用。 */
export function requireExecutionCapability(report: HostCapabilityReport, name: string): void {
  if (report.host.execute[name as HostExecutionCapability] === true) return;
  throw Object.assign(new Error(`host execution capability "${name}" is not available`), {
    code: 'unsupported', domain: 'execute', capability: name,
  });
}

/** 启动日志摘要：契约版本与各域为 false 的能力名（有界，不打印整份报告）。 */
export function capabilitySummary(report: HostCapabilityReport) {
  const summaryOf = (source: MemoryHostCapabilities) => Object.fromEntries(
    CAPABILITY_DOMAINS.map((domain) => [domain, Object.entries(source[domain]).filter(([, value]) => value !== true).map(([name]) => name)]),
  ) as Record<Exclude<CapabilityDomain, 'execute'>, string[]>;
  return {
    contract: report.contract,
    owner: report.owner,
    library: summaryOf(report.library),
    effective: summaryOf(report.effective),
    host: { checkpoint: report.host.checkpoint, flush: report.host.flush, close: report.host.close, execute: { ...report.host.execute } },
  };
}
