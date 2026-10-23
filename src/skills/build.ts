import type { Vec3Like } from '../adapter/types.ts';
import { sleep } from '../util.ts';
import { PLACEABLE } from './survival.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

/** 蓝图：相对坐标列表（dx 向右、dz 向前、dy 向上，原点在角色前方） */
interface Blueprint {
  name: string;
  description: string;
  cells: [number, number, number][];
  /** 建成后在这里设为基地（相对坐标） */
  home?: [number, number, number];
}

function hut(size: number, height: number): Blueprint {
  const cells: [number, number, number][] = [];
  const mid = Math.floor(size / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        const edge = x === 0 || z === 0 || x === size - 1 || z === size - 1;
        if (!edge) continue;
        if (z === 0 && x === mid && y < 2) continue; // 门洞（朝向角色的一面）
        cells.push([x, y, z]);
      }
    }
  }
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) cells.push([x, height, z]); // 屋顶
  return { name: `hut_${size}x${size}`, description: `${size}×${size} 小屋，墙高 ${height}，正面留门洞`, cells, home: [mid, 0, mid] };
}

export const BLUEPRINTS: Record<string, Blueprint> = {
  hut: hut(5, 3),
  big_hut: hut(7, 3),
  pillar: { name: 'pillar', description: '3 格高的柱子（做标记/瞭望）', cells: [[0, 0, 0], [0, 1, 0], [0, 2, 0]] },
  wall: { name: 'wall', description: '5 格长 2 格高的墙（挡怪）', cells: Array.from({ length: 10 }, (_, i) => [i % 5 - 2, Math.floor(i / 5), 0] as [number, number, number]) },
};

export const build: Skill<{ blueprint: string; cells?: [number, number, number][] }> = {
  name: 'build',
  description: `按蓝图用背包里的方块（木板/圆石/泥土/原木）在面前建造。内置蓝图：${Object.entries(BLUEPRINTS).map(([k, b]) => `${k}=${b.description}（${b.cells.length} 块）`).join('；')}；也可用 "custom" + cells 自定义（最多 150 块）。建好的小屋会成为新基地`,
  argsDoc: '{"blueprint": "hut|big_hut|pillar|wall|custom", "cells"?: [[dx,dy,dz],...]}',
  timeoutMs: 300000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const bp = String(a.blueprint ?? 'hut');
    if (bp === 'custom') {
      if (!Array.isArray(a.cells) || !a.cells.length || a.cells.length > 150) return { ok: false, error: 'custom 需要 1-150 个 [dx,dy,dz]' };
      const cells: [number, number, number][] = [];
      for (const c of a.cells) {
        if (!Array.isArray(c) || c.length !== 3 || c.some((v: unknown) => !Number.isInteger(v) || Math.abs(Number(v)) > 12)) return { ok: false, error: 'cells 每项必须是绝对值 ≤12 的整数三元组' };
        cells.push([c[0], c[1], c[2]]);
      }
      return { ok: true, args: { blueprint: 'custom', cells } };
    }
    if (!BLUEPRINTS[bp]) return { ok: false, error: `未知蓝图 ${bp}，可用：${Object.keys(BLUEPRINTS).join('/')}/custom` };
    return { ok: true, args: { blueprint: bp } };
  },
  async run(ctx, args) {
    const { adapter, signal, memory } = ctx;
    const bp: Blueprint = args.blueprint === 'custom' ? { name: 'custom', description: '自定义', cells: args.cells! } : BLUEPRINTS[args.blueprint];
    const s0 = adapter.state();
    const eye = adapter.eye();
    if (!eye) return fail('NOT_CONNECTED', '未连接');

    // 以角色面朝的方向为“前”，把蓝图放在前方 2 格处
    const yaw = eye.yaw;
    const fx = Math.round(-Math.sin(yaw)), fz = Math.round(-Math.cos(yaw)); // 前
    const rx = -fz, rz = fx; // 右（俯视顺时针 90°）
    const width = Math.max(...bp.cells.map((c) => c[0])) - Math.min(...bp.cells.map((c) => c[0]));
    const bx = Math.floor(s0.pos.x) + fx * 2 - rx * Math.floor(width / 2);
    const bz = Math.floor(s0.pos.z) + fz * 2 - rz * Math.floor(width / 2);
    const by = Math.floor(s0.pos.y);
    const toWorld = (c: [number, number, number]): Vec3Like => ({ x: bx + rx * c[0] + fx * c[2], y: by + c[1], z: bz + rz * c[0] + fz * c[2] });

    const targets = bp.cells.map(toWorld).filter((p) => (adapter.blockAt(p) ?? 'air') === 'air' || adapter.blockAt(p) === 'short_grass' || adapter.blockAt(p) === 'tall_grass');
    const have = s0.inventory.filter((i) => PLACEABLE.includes(i.name)).reduce((n, i) => n + i.count, 0);
    if (have < targets.length) {
      return fail('MISSING_MATERIALS', `建造 ${bp.name} 还需要 ${targets.length} 个方块，背包里只有 ${have} 个（可以先砍原木再合成木板，1 原木 = 4 木板）`, { need: targets.length, have });
    }
    // 自下而上、由近及远
    targets.sort((a, b) => a.y - b.y || Math.hypot(a.x - s0.pos.x, a.z - s0.pos.z) - Math.hypot(b.x - s0.pos.x, b.z - s0.pos.z));
    let placed = 0, failed = 0;
    for (const p of targets) {
      if (Date.now() > ctx.deadline - 3000) break;
      try {
        const st = adapter.state();
        if (Math.hypot(p.x + 0.5 - st.pos.x, p.y - st.pos.y, p.z + 0.5 - st.pos.z) > 4) {
          await adapter.moveTo({ kind: 'near', pos: p, range: 3 }, { signal, timeoutMs: 15000 });
        }
        const r = await adapter.placeBlockAt(p, PLACEABLE, signal);
        if (r.ok) placed++;
        else failed++;
        if (r.reason === 'NO_ITEM') break;
      } catch (e) {
        if (isAbort(e)) throw e;
        failed++;
        if (codeFromError(e) === 'NOT_CONNECTED') break;
      }
      ctx.progress((placed + failed) / targets.length, `建造 ${bp.name}：${placed}/${targets.length}`);
      await sleep(80, signal);
    }
    const doneRatio = placed / Math.max(1, targets.length);
    if (bp.home && doneRatio >= 0.8) {
      const h = toWorld(bp.home);
      memory.setBase(s0.dim, h);
      memory.addLandmark('discovery', `我的${bp.name}`, s0.dim, h, 4);
      ctx.bus.publish('built', 'P2', `建好了 ${bp.name}（${placed} 块），设为新基地 (${h.x}, ${h.y}, ${h.z})`);
    }
    return doneRatio >= 0.8
      ? ok(`建好 ${bp.name}：放置 ${placed} 块${failed ? `，${failed} 块没放上` : ''}`)
      : fail('ERROR', `${bp.name} 只完成了 ${placed}/${targets.length}（地形不平或缺少依附面）`);
  },
};

// ------------------------------------------------------------------ sleep
export const sleepSkill: Skill<{}> = {
  name: 'sleep',
  description: '夜里睡在身边的床上（没有就放下背包里的床），直接跳过黑夜并把重生点设在床边。床 = 3 羊毛 + 3 木板（羊毛来自羊）',
  argsDoc: '{}',
  timeoutMs: 120000,
  movement: false,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    const s = ctx.adapter.state();
    if (s.isDay) return fail('ERROR', '只能在夜里睡觉');
    try {
      const r = await ctx.adapter.sleepInBed(ctx.signal);
      if (!r.ok) return fail(r.reason === 'NO_BED' ? 'MISSING_MATERIALS' : 'ERROR', `睡不了：${r.reason}`);
      if (r.bedPos) {
        ctx.memory.setBase(s.dim, r.bedPos);
        ctx.memory.addLandmark('discovery', '我的床', s.dim, r.bedPos, 4);
      }
      return ok('睡了一觉，天亮了（重生点已设在床边）');
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `睡觉出错：${(e as Error).message}`);
    }
  },
};
