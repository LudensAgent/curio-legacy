import { buildingArchiveFor } from './build.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderVisionPng } from '../perception/raster.ts';
import { rotatePosition } from '../building/spec.ts';
import type { Vision } from '../perception/vision.ts';
import { AbortedError, throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

/** Fixed camera raycast observations, acquired through the real vision pipeline without X-ray reads. */
export const buildingReview: Skill<{ projectId: string; cameras: ('front' | 'right' | 'back' | 'left')[] }> = {
  name: 'building_review',
  description: '走到作品固定视角，实际转头并保存射线帧、语义色PNG、真实站位和观测ID，供比较轮廓与环境。PNG来自真实遮挡观察，非原版材质截图。审美及使用反馈可用 building_archive 记录。',
  argsDoc: '{"projectId":"作品 ID","cameras"?:["front","right","back","left"]}',
  timeoutMs: 120000,
  movement: true,
  validate(raw) {
    const input = obj(raw), cameras = input.cameras ?? ['front', 'right', 'back', 'left'];
    if (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 100) return { ok: false, error: '需要 projectId' };
    if (!Array.isArray(cameras) || !cameras.length || cameras.length > 4 || new Set(cameras).size !== cameras.length || cameras.some((name) => !['front', 'right', 'back', 'left'].includes(name))) return { ok: false, error: 'cameras 需要不重复的 front/right/back/left' };
    return { ok: true, args: { projectId: input.projectId, cameras } };
  },
  async run(ctx, args) {
    const archive = buildingArchiveFor(ctx.memory), project = archive.get(args.projectId);
    if (!project) return fail('NOT_FOUND', '作品不存在');
    const start = ctx.adapter.state();
    if (start.worldId !== project.worldId || start.dim !== project.dimension) return fail('WRONG_DIMENSION', '需要到作品所在的世界和维度实际观察');
    if (!start.observationReady || !start.connected || !start.alive) return fail('NOT_CONNECTED', '等待有效的现场观测');
    const senses = ctx.senses as Partial<Pick<Vision, 'summary' | 'scan' | 'frame'>> & typeof ctx.senses;
    if (typeof senses.summary !== 'function' || typeof senses.scan !== 'function') return fail('ERROR', 'MISSING_CAPABILITY:真实视觉摘要及强制扫描接口未接入；不能合成观察记录');
    const spec = project.versions.at(-1)!.spec;
    const positions = {
      front: { x: Math.floor(spec.width / 2), y: 0, z: -5 },
      right: { x: spec.width + 4, y: 0, z: Math.floor(spec.depth / 2) },
      back: { x: Math.floor(spec.width / 2), y: 0, z: spec.depth + 4 },
      left: { x: -5, y: 0, z: Math.floor(spec.depth / 2) },
    };
    const center = rotatePosition({ x: (spec.width - 1) / 2, y: spec.height / 2, z: (spec.depth - 1) / 2 }, project.origin, project.rotation);
    const captured: string[] = [], failures: { camera: string; reason: string }[] = [];
    for (const camera of args.cameras) {
      try {
        throwIfAborted(ctx.signal);
        if (Date.now() >= ctx.deadline - 1000) break;
        const requested = rotatePosition(positions[camera], project.origin, project.rotation);
        await ctx.adapter.moveTo({ kind: 'near', pos: requested, range: 1 }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(25000, ctx.deadline - Date.now())) });
        throwIfAborted(ctx.signal);
        const state = ctx.adapter.state(), eye = ctx.adapter.eye();
        if (state.sessionId !== start.sessionId || state.worldId !== project.worldId || state.dim !== project.dimension || !state.observationReady) throw new AbortedError('观察会话已经改变');
        if (!eye || Math.hypot(state.pos.x - requested.x, state.pos.y - requested.y, state.pos.z - requested.z) > 2) { failures.push({ camera, reason: '固定视角不可达，未保存伪造观察' }); continue; }
        const yaw = Math.atan2(-(center.x - eye.x), -(center.z - eye.z));
        const pitch = Math.atan2(center.y - eye.y, Math.hypot(center.x - eye.x, center.z - eye.z));
        await ctx.adapter.look(yaw, pitch);
        throwIfAborted(ctx.signal);
        // refresh() deliberately throttles at 150 ms; a fixed camera review must acquire
        // a fresh frame after this exact look, even when two cameras were reached quickly.
        senses.scan!();
        const observed = ctx.adapter.state();
        if (observed.sessionId !== start.sessionId || observed.worldId !== project.worldId || observed.dim !== project.dimension || !observed.observationReady) throw new AbortedError('观察会话已经改变');
        let pixelImage: string | null = null;
        if (senses.frame && ctx.memory.dataDirectory) {
          throwIfAborted(ctx.signal);
          const imageDir = path.join(ctx.memory.dataDirectory, 'building-views');
          fs.mkdirSync(imageDir, { recursive: true });
          pixelImage = path.join(imageDir, `${randomUUID()}.png`);
          fs.writeFileSync(pixelImage, renderVisionPng(senses.frame));
        }
        archive.observationView(project.id, camera, { kind: 'raycast_summary', pixelSource: 'raycast_semantic_colors', worldId: observed.worldId, dimension: observed.dim, sessionId: observed.sessionId, observationId: observed.observationId, requestedPosition: requested, actualPosition: observed.pos, eye: ctx.adapter.eye(), vision: senses.summary!(observed.pos), raycastFrame: senses.frame ? structuredClone(senses.frame) : null, pixelImage });
        captured.push(camera);
        ctx.progress(captured.length / args.cameras.length, `已实地观察 ${camera}`);
      } catch (error) { if (isAbort(error)) throw error; failures.push({ camera, reason: `${codeFromError(error)}:${(error as Error).message}` }); }
    }
    const data = { projectId: project.id, captured, failures, views: captured.length ? archive.get(project.id)!.views.slice(-captured.length) : [], pixelBackend: 'raycast_semantic_colors' };
    return captured.length === args.cameras.length ? ok('已保存固定视角的真实视觉摘要；请基于观察选择设计并记录主观反馈', data) : fail('ERROR', `只取得 ${captured.length}/${args.cameras.length} 个实际视角`, data);
  },
};
