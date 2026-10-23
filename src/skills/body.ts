import { DIRS } from '../perception/perception.ts';
import { DIR_OFFSETS, isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { dirOfYaw } from '../perception/vision.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { hasPlaceable } from './survival.ts';

/**
 * 身体的基本动作：对着某个方向挖（玩家按住左键）、原地垫方块往上爬（跳起来往脚下放方块）。
 * 被困在坑里、洞里、头顶被封住时，玩家就是这么出去的。程序只负责动作本身和不挖进岩浆/水里。
 */

const floor = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** 挖开这一格会不会让液体流进来（它的邻格有水/岩浆） */
function liquidNext(ctx: SkillCtx, c: { x: number; y: number; z: number }): string | null {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = ctx.adapter.blockAt({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
    if (n && LIQUID_BLOCKS.has(n)) return n;
  }
  return null;
}

async function breakCell(ctx: SkillCtx, c: { x: number; y: number; z: number }): Promise<string | null> {
  const name = ctx.adapter.blockAt(c);
  if (isSoftBlock(name)) return null;
  if (name && LIQUID_BLOCKS.has(name)) throw new Error(`LIQUID:${name}`);
  if (name === 'bedrock') throw new Error('BEDROCK');
  const wet = liquidNext(ctx, c);
  if (wet) throw new Error(`LIQUID_NEAR:${wet}`);
  const r = await ctx.adapter.dig(c, ctx.signal);
  if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
  return name;
}

const why = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (m.startsWith('LIQUID_NEAR:')) return `再挖 ${m.slice(12)} 就会流进来，停下了`;
  if (m.startsWith('LIQUID:')) return `那边是 ${m.slice(7)}`;
  if (m === 'BEDROCK') return '碰到基岩，挖不动';
  return m;
};

// ------------------------------------------------------------------ dig
export const dig: Skill<{ dir: string; blocks: number }> = {
  name: 'dig',
  description: '对着一个方向挖：up 挖开头顶，down 挖脚下，N/E/S/W/forward 挖出一人高的通道并走进去；不会挖进水或岩浆旁边',
  argsDoc: '{"dir": "up|down|N|E|S|W|forward", "blocks"?: 1-6}',
  timeoutMs: 60000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    let dir = String(a.dir ?? a.direction ?? '').trim();
    dir = /^(up|down|forward)$/i.test(dir) ? dir.toLowerCase() : dir.toUpperCase();
    if (!['up', 'down', 'forward', ...Object.keys(DIR_OFFSETS)].includes(dir)) return { ok: false, error: 'dir 必须是 up/down/forward/N/E/S/W' };
    return { ok: true, args: { dir, blocks: clampInt(a.blocks ?? a.count, 1, 6, dir === 'up' ? 2 : 1) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const dug: string[] = [];
    try {
      if (args.dir === 'up') {
        const me = floor(adapter.state().pos);
        for (let i = 0; i < args.blocks; i++) {
          const n = await breakCell(ctx, { x: me.x, y: me.y + 2 + i, z: me.z });
          if (n) dug.push(n);
        }
        return ok(`挖开了头顶 ${dug.length ? dug.join('、') : '（本来就空着）'}｜${surroundings(adapter).text}`, { dug });
      }
      if (args.dir === 'down') {
        for (let i = 0; i < args.blocks; i++) {
          const me = floor(adapter.state().pos);
          const c = { x: me.x, y: me.y - 1, z: me.z };
          const under = adapter.blockAt({ x: c.x, y: c.y - 1, z: c.z });
          if (isSoftBlock(under) || (under && LIQUID_BLOCKS.has(under))) return dug.length ? ok(`往下挖了 ${dug.length} 格，再下面是 ${under ?? '空的'}，停下`, { dug }) : fail('BAD_ARGS', `脚下再往下是 ${under ?? '空的'}，往下挖会掉下去`);
          const n = await breakCell(ctx, c);
          if (n) dug.push(n);
          await adapter.moveTo({ kind: 'xyz', x: c.x, y: c.y, z: c.z }, { signal, timeoutMs: 4000 }).catch((e) => { if (isAbort(e)) throw e; });
        }
        return ok(`往下挖了 ${dug.length} 格（${dug.join('、')}）｜${surroundings(adapter).text}`, { dug });
      }
      const dirKey = args.dir === 'forward' ? dirOfYaw(adapter.eye()?.yaw ?? 0).replace(/^(N|S)[EW]$/, '$1') : args.dir;
      const [dx, dz] = DIR_OFFSETS[dirKey] ?? DIRS[dirKey] ?? [0, -1];
      let walked = 0;
      for (let i = 0; i < args.blocks; i++) {
        const me = floor(adapter.state().pos);
        const feet = { x: me.x + dx, y: me.y, z: me.z + dz };
        for (const c of [{ ...feet, y: feet.y + 1 }, feet]) {
          const n = await breakCell(ctx, c);
          if (n) dug.push(n);
        }
        await adapter.moveTo({ kind: 'xyz', ...feet }, { signal, timeoutMs: 5000 });
        walked++;
      }
      return ok(`往 ${dirKey} 挖了 ${walked} 格（${dug.length ? dug.join('、') : '本来就通'}）｜${surroundings(adapter).text}`, { dug, walked });
    } catch (e) {
      if (isAbort(e)) throw e;
      const msg = why(e);
      return dug.length ? ok(`挖了 ${dug.join('、')}，然后${msg}｜${surroundings(adapter).text}`, { dug }) : fail(msg.includes('流进来') || msg.includes('基岩') || msg.startsWith('那边是') ? 'BAD_ARGS' : codeFromError(e), `${msg}｜${surroundings(adapter).text}`);
    }
  },
};

// ------------------------------------------------------------------ climb_up
export const climbUp: Skill<{ height: number; untilSky: boolean }> = {
  name: 'climb_up',
  description: '原地垫方块往上爬（头顶挡着会先挖开），until_sky 为 true 时一直爬到看得见天空；需要背包里有泥土/圆石等方块',
  argsDoc: '{"height"?: 1-24, "until_sky"?: true}',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const untilSky = a.until_sky === true || a.untilSky === true || a.height === undefined;
    return { ok: true, args: { height: clampInt(a.height, 1, 24, untilSky ? 16 : 3), untilSky } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!hasPlaceable(adapter.state().inventory)) return fail('MISSING_MATERIALS', '背包里没有能垫脚的方块（泥土/圆石/石头/木板）');
    const start = adapter.state().pos.y;
    let climbed = 0;
    for (let i = 0; i < args.height && Date.now() < ctx.deadline - 1000; i++) {
      if (args.untilSky && surroundings(adapter).sky) break;
      const me = floor(adapter.state().pos);
      try {
        // 头顶的方块先挖开（不挖液体旁边的）
        await breakCell(ctx, { x: me.x, y: me.y + 2, z: me.z });
        await adapter.moveTo({ kind: 'xyz', x: me.x, y: me.y + 1, z: me.z }, { signal, timeoutMs: 8000 });
      } catch (e) {
        if (isAbort(e)) throw e;
        const msg = why(e);
        climbed = Math.round(adapter.state().pos.y - start);
        return climbed > 0 ? ok(`往上爬了 ${climbed} 格后停下：${msg}｜${surroundings(adapter).text}`, { climbed })
          : fail('STUCK', `爬不上去：${msg}｜${surroundings(adapter).text}`);
      }
      if (!hasPlaceable(adapter.state().inventory)) break;
    }
    climbed = Math.round(adapter.state().pos.y - start);
    const around = surroundings(adapter);
    return ok(`往上爬了 ${climbed} 格${around.sky ? '，看得见天空了' : ''}｜${around.text}`, { climbed, sky: around.sky });
  },
};

export const bodySkills = [dig, climbUp];
