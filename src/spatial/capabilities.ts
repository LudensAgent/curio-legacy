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
 * 过渡期直读清单（D-070）：库执行环境与只读查询仍直接读 `session.voxel`/
 * `session.history`——`route.ts`（搜索/历史规划源）、`walk.ts`（执行环境 map）、
 * `spatial-query.ts`（只读查询）。它们不是写入入口，新增写入口必须走共享会话。
 */
import {
  composeCapabilities,
  CONTRACT_VERSION,
  requireCapability,
  type ComposedCapabilityReport,
  type HostCapabilityDeclaration,
  type MemoryHostCapabilities,
  type SpatialQueryResult,
} from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from './shared-session.ts';

export type CapabilityDomain = keyof Omit<MemoryHostCapabilities, 'contract'>;

/**
 * 库 memory 域的写入能力名；与契约 §2.3 的 `memory` 键逐键对应。
 * `MemoryIngest.addPortalTraversal` 没有独立能力键，依赖 `savePortalEdge`（传送边）。
 */
export type MemoryWriteCapability =
  | 'beginSession' | 'observeBatch' | 'markStale' | 'markTraversed' | 'markModified'
  | 'saveFragment' | 'addTraversal' | 'recordNode' | 'upsertEdge' | 'savePortalEdge';

/**
 * 宿主组合报告：库报告逐键 + 宿主真正拥有的持久化生命周期 + 两者交集。
 *
 * `library` 是库的事实，`host` 是宿主自己的接线事实；`effective` 是
 * `library AND host`，门禁只读它。宿主不能把库的 false 抬成 true，也不能把
 * 自己未接线的能力借库的 true 当成可用。
 */
export interface HostCapabilityReport {
  owner: 'host_composed';
  contract: MemoryHostCapabilities['contract'];
  /** 库报告原样；宿主不得改写其中任何值，包括把 false 改成 true。 */
  library: MemoryHostCapabilities;
  /** 共享会话真正实现的生命周期方法；不冒充库 memory 能力。 */
  host: { checkpoint: true; flush: true; close: true };
  /** 库与宿主接线的交集；所有调用门禁读这里。 */
  effective: MemoryHostCapabilities;
  /** 宿主声明为 true、库报告为 false 的能力（诊断用，不会放宽 effective）。 */
  overclaims: ComposedCapabilityReport['overclaims'];
}

/** 调用点的能力门禁：库报告为 false 时不得调用，也不得回退到更宽的旧后端。 */
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
  // What the host actually wires. Walk execution is wired in
  // `skills/movement/walk.ts` with a measured body port and shared-session
  // invalidation; near/reach-block arrival, swim and boat are not wired and are
  // deliberately omitted (omission means "no host claim", not "true").
  const declaration: HostCapabilityDeclaration = {
    execute: {
      walk: true,
      groundedArrival: true,
      invalidation: true,
      cancellation: true,
    },
  };
  const composed = composeCapabilities(library, declaration);
  return {
    owner: 'host_composed',
    contract: library.contract,
    library,
    host: { checkpoint: true, flush: true, close: true },
    effective: composed.effective,
    overclaims: composed.overclaims,
  };
}

/** 逐域读取一个能力位；未知键按 false（未接线不是已批准）。 */
export function capabilityGate(report: HostCapabilityReport): CapabilityGate {
  return (domain, name) => {
    // Effective is already library AND host, but intersecting with the live
    // library value again keeps a test/controlled override of `library` from
    // being masked by a stale precomputed `effective`.
    const library = report.library[domain] as Record<string, boolean | undefined>;
    const effective = report.effective[domain] as Record<string, boolean | undefined>;
    return library[name] === true && effective[name] === true;
  };
}

/** 执行能力门禁：false/未声明时抛结构化 unsupported，不进入身体调用。 */
export function requireExecutionCapability(report: HostCapabilityReport, name: string): void {
  requireCapability(report.effective, 'execute', name);
}

/** 启动日志摘要：契约版本与各域为 false 的能力名（有界，不打印整份报告）。 */
export function capabilitySummary(report: HostCapabilityReport) {
  const library = Object.fromEntries(
    (Object.keys(report.library) as (keyof MemoryHostCapabilities)[])
      .filter((key): key is CapabilityDomain => key !== 'contract')
      .map((domain) => [domain, Object.entries(report.library[domain]).filter(([, value]) => value !== true).map(([name]) => name)]),
  ) as Record<CapabilityDomain, string[]>;
  const effective = Object.fromEntries(
    (Object.keys(report.effective) as (keyof MemoryHostCapabilities)[])
      .filter((key): key is CapabilityDomain => key !== 'contract')
      .map((domain) => [domain, Object.entries(report.effective[domain]).filter(([, value]) => value !== true).map(([name]) => name)]),
  ) as Record<CapabilityDomain, string[]>;
  return { contract: report.contract, owner: report.owner, library, effective, host: { ...report.host } };
}
