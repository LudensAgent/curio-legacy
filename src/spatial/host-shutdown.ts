/**
 * 宿主关停结果分类与结构化诊断。
 *
 * D1 的 SharedSpatialSession.shutdown 已经负责 flush、最终 checkpoint 校验和真实
 * close；这里只读取它返回的结果，判断能否算作“已保存并关闭”，并把主保存错误、
 * 取消失败、次关闭错误分开保留原始 kind/name/message，避免 JSON.stringify(Error)
 * 丢掉全部信息。不复制保存协议，也不重新执行任何持久化操作。
 */
import type { ShutdownResult } from './shared-session.ts';

/** 原始错误的可序列化事实；非 Error 抛出值也保留类型与字符串内容。 */
export interface ErrorFacts {
  kind: string | null;
  name: string;
  message: string;
  code?: string | number;
}

export function errorFacts(error: unknown): ErrorFacts {
  if (typeof error === 'object' && error !== null) {
    const facts = error as { kind?: unknown; name?: unknown; message?: unknown; code?: unknown };
    return {
      kind: typeof facts.kind === 'string' ? facts.kind : null,
      // 普通对象没有可信的 name/message 时退回真实类型与 String 值，不臆造错误类别。
      name: typeof facts.name === 'string' ? facts.name : 'object',
      message: typeof facts.message === 'string' ? facts.message : String(error),
      ...(typeof facts.code === 'string' || typeof facts.code === 'number' ? { code: facts.code } : {}),
    };
  }
  return { kind: null, name: typeof error, message: String(error) };
}

/** 关停是否完整：最终 checkpoint 存在且被 close 确认，没有主保存/取消/关闭错误。 */
export interface ShutdownClassification {
  ok: boolean;
  problems: string[];
}

export function classifySpatialShutdown(result: ShutdownResult, expectedWorldId?: string): ShutdownClassification {
  const problems: string[] = [];
  if (result.error !== null) problems.push('primary_save_error');
  if (result.cancelError !== null) problems.push('cancel_error');
  if (result.closeError !== null) problems.push('close_error');
  if (result.checkpoint === null) {
    problems.push('missing_checkpoint');
  } else {
    if (!result.checkpoint.checkpointId) problems.push('missing_checkpoint_id');
    if (expectedWorldId !== undefined && result.checkpoint.worldId !== expectedWorldId) problems.push('checkpoint_world_mismatch');
  }
  if (result.close === null) {
    problems.push('missing_close_result');
  } else {
    if (result.close.error !== null) problems.push('close_reported_error');
    if (!result.close.completed) problems.push('close_incomplete');
    if (result.close.unconfirmedRequest) problems.push('close_unconfirmed_request');
    if (result.close.dirty) problems.push('close_dirty');
    if (result.checkpoint !== null && result.close.lastConfirmedCheckpointId !== result.checkpoint.checkpointId) {
      problems.push('checkpoint_not_confirmed_by_close');
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 给日志用的结构化关停诊断：主保存、取消、次关闭、最终 checkpoint 各自独立。 */
export interface SpatialShutdownDiagnostics extends ShutdownClassification {
  expectedWorldId?: string;
  checkpoint: {
    checkpointId: string;
    worldId: string;
    voxelRevision: number;
    journalRevision: number;
    ledgerRevision: number;
    factsRevision: number;
    factsCommitted: boolean;
  } | null;
  primarySaveError: ErrorFacts | null;
  cancelError: ErrorFacts | null;
  closeError: ErrorFacts | null;
  close: {
    completed: boolean;
    lastConfirmedCheckpointId: string | null;
    unconfirmedRequest: boolean;
    dirty: boolean;
    error: ErrorFacts | null;
  } | null;
}

export function spatialShutdownDiagnostics(result: ShutdownResult, expectedWorldId?: string): SpatialShutdownDiagnostics {
  const classification = classifySpatialShutdown(result, expectedWorldId);
  return {
    ...classification,
    ...(expectedWorldId === undefined ? {} : { expectedWorldId }),
    checkpoint: result.checkpoint === null ? null : {
      checkpointId: result.checkpoint.checkpointId,
      worldId: result.checkpoint.worldId,
      voxelRevision: result.checkpoint.voxelRevision,
      journalRevision: result.checkpoint.journalRevision,
      ledgerRevision: result.checkpoint.ledgerRevision,
      factsRevision: result.checkpoint.factsRevision,
      factsCommitted: result.checkpoint.factsCommitted,
    },
    primarySaveError: result.error === null ? null : errorFacts(result.error),
    cancelError: result.cancelError === null ? null : errorFacts(result.cancelError),
    closeError: result.closeError === null ? null : errorFacts(result.closeError),
    close: result.close === null ? null : {
      completed: result.close.completed,
      lastConfirmedCheckpointId: result.close.lastConfirmedCheckpointId,
      unconfirmedRequest: result.close.unconfirmedRequest,
      dirty: result.close.dirty,
      error: result.close.error === null ? null : errorFacts(result.close.error),
    },
  };
}
