import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSpatialSession } from '../../src/spatial/shared-session.ts';

export const WORLD = 'shared-fixture-world';
export const DIM = 'overworld';
export const SESSION_1 = 's1';

export class FixtureClock {
  private clock: number;
  frame = 0;

  constructor(start = 0) {
    this.clock = start;
  }

  readonly now = (): number => this.clock;

  set(value: number): void {
    this.clock = value;
  }

  tickFrame(): number {
    this.frame += 1;
    return this.frame;
  }
}

/** 在真实会话上运行；只有确认 close 干净才删除临时目录。 */
export async function withSharedSession<T>(
  now: () => number,
  run: (session: SharedSpatialSession) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-spatial-fixture-'));
  const session = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: join(dir, 'memory.db'),
    now,
    timeoutMs: 10_000,
  });
  try {
    return await run(session);
  } finally {
    const result = await session.shutdown();
    if (result.close?.completed === true && result.close.error === null) rmSync(dir, { recursive: true, force: true });
  }
}
