import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { EventBus } from '../events.ts';
import type { BehaviorEngine } from './behaviors.ts';

/** 仅成功监听控制台的进程消费明确请求，避免同端口已有进程时改写其内存状态。 */
export function installSkillRestoreRequest(server: Pick<EventEmitter, 'once'>, engine: BehaviorEngine, bus: EventBus, file: string) {
  server.once('listening', () => {
    if (!fs.existsSync(file)) return;
    try {
      const request: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!request || typeof request !== 'object' || !('entries' in request) || !Array.isArray(request.entries) || !request.entries.length
        || !request.entries.every((e: unknown) => !!e && typeof e === 'object' && 'name' in e && typeof e.name === 'string'
          && 'retiredAt' in e && typeof e.retiredAt === 'number' && Number.isFinite(e.retiredAt))) throw new Error('恢复请求需要非空 entries，包含 name 和 retiredAt');
      const entries = request.entries as { name: string; retiredAt: number }[];
      if (new Set(entries.map((e) => e.name)).size !== entries.length) throw new Error('恢复请求包含重复技能');
      const restored = engine.restoreRetired(entries);
      fs.unlinkSync(file);
      bus.publish('skill_restored', 'P2', `已按明确请求恢复 ${restored.length} 项技能：${restored.join('、')}`, { names: restored });
    } catch (error) {
      bus.publish('skill_restore_failed', 'P1', `技能恢复请求未完成：${error instanceof Error ? error.message : String(error)}`, { file });
    }
  });
}
