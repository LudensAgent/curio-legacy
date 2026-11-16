import type { Vec3Like } from '../adapter/types.ts';
import { supportCell } from '../perception/local.ts';
import { portalAgeText, travelStore, type PortalEndpoint } from '../travel/store.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const TERRAIN = new Set(['dirt', 'grass_block', 'stone', 'cobblestone', 'deepslate', 'netherrack', 'sand', 'gravel']);
/** 建门时允许消耗的施工支撑块（与 Agent 原有允许范围一致，不临时选别的材料） */
const SCAFFOLD = ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate'];
/** 方块交互距离：原地垫高只改变竖直高度，水平距离超过它时垫高不可能让目标进入交互范围。 */
const PLACE_REACH = 4.5;
/** 传送门记进常规记忆（地标）时用的中文名 */
const PORTAL_LABEL: Record<PortalEndpoint['kind'], string> = { nether_portal: '下界门', end_portal: '末地门', end_gateway: '末地折跃门' };

function visiblePortal(ctx: SkillCtx, positions: Vec3Like[], kinds: string[]) {
  for (let offset = 0; offset < positions.length; offset += 32) {
    const portal = ctx.senses.observeBlocks?.(positions.slice(offset, offset + 32)).find((block) => kinds.includes(block.name));
    if (portal) return portal;
  }
  return undefined;
}

/** 把当前世界已记录的门列成一行，供 agent 自己挑（不替它改选目标） */
function knownPortals(store: ReturnType<typeof travelStore>, worldId: string) {
  return store.snapshot(worldId).endpoints.map((e) =>
    `${e.id}（${e.dim} ${e.pos.x},${e.pos.y},${e.pos.z}，${e.portalObserved ? '门方块曾实际观察到' : '仅到达位置'}，记录于 ${portalAgeText(e.observedAt)}）`
  ).join('；') || '（还没有记录任何门）';
}

export const buildPortal: Skill<{ origin: Vec3Like; axis: 'x' | 'z'; allowTower: boolean }> = {
  name: 'build_portal',
  description: '在身边用 10 块黑曜石建最小下界门并用打火石点燃；逐块验收，记录实际门位置。需要少量施工支撑块。门框上段离地 2–3 格，站在地面看不到可贴的面；allowTower:true 时允许原地垫方块站高去放（消耗圆石/泥土/下界岩等，垫的柱子不拆，不往门框和门内放），不写则够不到就停下并报告是哪一格。',
  argsDoc: '{"origin"?:{"x":number,"y":number,"z":number},"axis"?:"x"|"z","allowTower"?:boolean}',
  timeoutMs: 180000, movement: true,
  validate(raw, adapter) {
    const value = obj(raw);
    const here = adapter.state().pos;
    const origin = value.origin ?? { x: Math.floor(here.x) + 3, y: Math.floor(here.y) - 1, z: Math.floor(here.z) };
    if (![origin.x, origin.y, origin.z].every(Number.isInteger) || dist3(origin, here) > 24) return { ok: false, error: 'origin 必须是 24 格内的整数坐标' };
    if (value.axis !== undefined && value.axis !== 'x' && value.axis !== 'z') return { ok: false, error: 'axis 必须是 x 或 z' };
    if (value.allowTower !== undefined && typeof value.allowTower !== 'boolean') return { ok: false, error: 'allowTower 必须是 true 或 false' };
    return { ok: true, args: { origin, axis: value.axis ?? 'x', allowTower: value.allowTower === true } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const state = adapter.state();
    if (state.dim === 'the_end') return fail('WRONG_DIMENSION', '末地不能激活下界门');
    if (!adapter.useBlockAt) return fail('ERROR', '适配器没有方块交互能力');
    if (!state.inventory.some((i) => i.name === 'flint_and_steel' && i.count > 0)) return fail('MISSING_MATERIALS', '缺少打火石');
    const at = (u: number, y: number): Vec3Like => ({ x: args.origin.x + (args.axis === 'x' ? u : 0), y: args.origin.y + y, z: args.origin.z + (args.axis === 'z' ? u : 0) });
    const frame = [[1, 0], [2, 0], ...[1, 2, 3].flatMap((y) => [[0, y], [3, y]]), [1, 4], [2, 4]].map(([u, y]) => at(u, y));
    const needed = frame.filter((p) => adapter.blockAt(p) !== 'obsidian').length;
    const partialLabel = `未完成的下界门框（axis=${args.axis}）`;
    // 这里已经摆过黑曜石（部分/完整门框）：无论这次缺不缺料都先记下位置，回来能补全；点着后清掉
    if (needed < frame.length) ctx.memory.addLandmark('discovery', partialLabel, state.dim, args.origin, 1);
    // 附近记得的其他未完成门框（位置 + 朝向），只作为事实回报，不替 Agent 改选门址。
    const otherFrames = ctx.memory.landmarks()
      .filter((l) => l.label.startsWith('未完成的下界门框') && l.dim === state.dim && dist3(l.pos, args.origin) > 0 && dist3(l.pos, state.pos) <= 32)
      .map((l) => `(${l.pos.x},${l.pos.y},${l.pos.z}) ${l.label.match(/axis=[xz]/)?.[0] ?? ''}`);
    const framesNote = otherFrames.length ? `；附近还记得未完成门框 origin ${otherFrames.slice(0, 3).join('、')}` : '';
    const frameNote = `本处门框（origin ${args.origin.x},${args.origin.y},${args.origin.z} axis=${args.axis}）已有 ${frame.length - needed}/${frame.length} 块黑曜石`;
    const have = state.inventory.find((i) => i.name === 'obsidian')?.count ?? 0;
    if (have < needed) return fail('MISSING_MATERIALS', `${frameNote}，还需 ${needed} 块，背包现有 ${have} 块${framesNote}`, { needed, have, otherFrames });
    // 门框格只能是空气或黑曜石，门内 2×3 只能是空气；四个角不属于门，放什么都不影响。
    const occupied = [1, 2, 3, 4].flatMap((y) => [0, 1, 2, 3].flatMap((u) => {
      if (y === 4 && (u === 0 || u === 3)) return [];
      const pos = at(u, y), name = adapter.blockAt(pos);
      const isFrame = frame.some((p) => dist3(p, pos) === 0);
      if (name && (AIR.has(name) || (isFrame && name === 'obsidian'))) return [];
      return [`${isFrame ? '门框' : '门内'} (${pos.x},${pos.y},${pos.z}) 是 ${name ?? '未加载'}`];
    }));
    if (occupied.length) return fail('BAD_ARGS', `${frameNote}；以下格子挡住了门：${occupied.join('、')}${framesNote}`, { occupied, otherFrames });
    // 这次要开始立框（新开工），也记下：中途失败/被中断都能回同一处补全
    ctx.memory.addLandmark('discovery', partialLabel, state.dim, args.origin, 1);
    let placed = 0, confirmedRises = 0;
    let lastPlacementTarget: Vec3Like | undefined;
    // 门框格与门内空间：垫脚时不能往这里放方块，否则门框错位或门内被堵。
    const keepClear = [0, 1, 2, 3, 4].flatMap((y) => [0, 1, 2, 3].map((u) => at(u, y)));
    const keepClearKeys = new Set(keepClear.map((p) => `${p.x},${p.y},${p.z}`));
    const scaffoldNames = () => SCAFFOLD.filter((n) => (adapter.state().inventory.find((i) => i.name === n)?.count ?? 0) > 0);
    // 显式垫高与落地等待受剩余绝对期限约束；只传信号，不替新的动作所有者 stopAll。
    const operationSignal = () => Number.isFinite(ctx.deadline)
      ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))])
      : signal;
    // 只做普通近距离移动；垫高与否由下面的显式 pillarUp 决定，不再交给寻路隐式搭柱/放块。
    const moveIntoPlaceReach = (pos: Vec3Like) => adapter.moveTo({ kind: 'place_block', pos },
      { signal, timeoutMs: Math.max(1, Math.min(20000, ctx.deadline - Date.now())) });
    const place = async (pos: Vec3Like, name: string) => {
      throwIfAborted(signal);
      lastPlacementTarget = pos;
      try {
        await moveIntoPlaceReach(pos);
      } catch (error) {
        if (isAbort(error)) throw error;
        const stance = adapter.state(), stancePos = stance.pos;
        const feet = Math.floor(stancePos.y);
        const horizontal = Math.hypot(stancePos.x - (pos.x + 0.5), stancePos.z - (pos.z + 0.5));
        const target = `(${pos.x},${pos.y},${pos.z})`;
        const failGap = (message: string, reason: string, facts: Record<string, unknown> = {}) =>
          Object.assign(new Error(message), { details: {
            target: pos, targetFeetY: pos.y, startFeetY: feet, reason, horizontalDistance: horizontal, reach: PLACE_REACH,
            position: { ...stancePos }, placed, confirmedRises, ...facts,
          } });
        const failTower = (message: string, facts: Record<string, unknown>) =>
          Object.assign(new Error(message), { details: {
            target: pos, targetFeetY: pos.y, startFeetY: feet, horizontalDistance: horizontal, reach: PLACE_REACH,
            position: { ...adapter.state().pos }, placed, confirmedRises, ...facts,
          } });
        if (!args.allowTower) {
          throw failGap(`${(error as Error).message}：${target} 比脚高 ${pos.y - feet} 格，本次未授权垫脚（allowTower 未开），没有找到能放下它的站位`, 'NO_TOWER');
        }
        if (typeof adapter.pillarUp !== 'function') {
          throw failTower(`${(error as Error).message}：当前适配器没有原地垫高能力，allowTower 无法执行，${target} 未放置`, { allowTower: true, reason: 'CAPABILITY_MISSING' });
        }
        // 正常接近失败不等于“高一点就够得到”：身体必须站在实地上，且水平距离必须已在交互范围内。
        if (!stance.onGround) throw failGap(`${(error as Error).message}：身体没有站在实地上，垫高不会把 ${target} 变成可放置`, 'UNSUPPORTED_STANCE');
        if (horizontal > PLACE_REACH) {
          throw failGap(`${(error as Error).message}：${target} 水平方向离身体 ${horizontal.toFixed(1)} 格（交互距离约 ${PLACE_REACH} 格），原地垫高不会缩短这段距离`, 'OUT_OF_REACH');
        }
        // 垫高只对“目标高于当前站位”有意义，且最多垫到目标脚高；每次垫完都先重试原有放置方式。
        const maxRises = Math.floor(pos.y) - feet;
        if (maxRises <= 0) throw failGap(`${(error as Error).message}：${target} 不在当前站立高度之上`, 'NOT_ABOVE');
        let rises = 0, lastError: Error | null = error as Error;
        for (; rises < maxRises; rises++) {
          throwIfAborted(signal);
          if (Date.now() >= ctx.deadline - 250) throw failTower(`建门垫高到期限：${lastError?.message ?? '原地移动未完成'}`, { rises });
          const current = adapter.state(), stancePosNow = current.pos;
          // pillarUp 会放进“脚下支撑格上面一格”；用实际放置格判断是否落在门框/门内。
          const stanceCell = { x: Math.floor(stancePosNow.x), y: supportCell(stancePosNow).y + 1, z: Math.floor(stancePosNow.z) };
          if (keepClearKeys.has(`${stanceCell.x},${stanceCell.y},${stanceCell.z}`)) {
            throw failTower(`够不到 ${target}，且垫高会填入门框/门内 (${stanceCell.x},${stanceCell.y},${stanceCell.z})，已停止`, { stance: stanceCell, rises });
          }
          const names = scaffoldNames();
          if (names.length === 0) {
            throw failTower(`够不到 ${target}，缺脚手架方块（${SCAFFOLD.join('/')}）`, { stance: stanceCell, rises });
          }
          const beforeY = stancePosNow.y;
          const pillar = await adapter.pillarUp(names, operationSignal());
          const supportedRise = () => {
            const now = adapter.state();
            return now.onGround && now.pos.y > beforeY + 0.45 && Math.floor(now.pos.y + 0.05) > Math.floor(beforeY + 0.05);
          };
          let supported = supportedRise();
          // 适配器可能在上跳途中返回：有界等待真正站稳，不把空中瞬时高度算成垫高。
          if (pillar.ok && !supported) {
            const until = Math.min(Date.now() + 1500, ctx.deadline);
            while (!supported && Date.now() < until) {
              await sleep(Math.max(1, Math.min(50, until - Date.now())), operationSignal());
              supported = supportedRise();
            }
          }
          if (supported) confirmedRises++;
          if (!pillar.ok || !supported) {
            const asked = pillar.ok ? '实测没有站在实地上（仍悬空或高度未上升）' : pillar.reason ?? '原地垫高未成功';
            const detail = pillar.clearanceDetail ? `；${pillar.clearanceDetail}` : '';
            throw failTower(`够不到 ${target}，原地垫高没成：${asked}${detail}`, {
              stance: stanceCell, rises,
              ...(pillar.ok ? {} : { pillarFailure: pillar.reason }),
              ...(pillar.clearanceDetail ? { clearanceDetail: pillar.clearanceDetail } : {}),
              ...(pillar.clearance ? { pillarClearance: pillar.clearance } : {}),
            });
          }
          try {
            throwIfAborted(operationSignal());
            if (Date.now() >= ctx.deadline) throw new AbortedError('DEADLINE');
            await moveIntoPlaceReach(pos);
            lastError = null;
            break;
          } catch (e) {
            if (isAbort(e)) throw e;
            lastError = e as Error;
          }
        }
        if (lastError) throw failTower(`${lastError.message}：原地垫高 ${rises} 格后仍够不到 ${target}`, { rises });
      }
      throwIfAborted(operationSignal());
      if (Date.now() >= ctx.deadline) throw new AbortedError('DEADLINE');
      const result = await adapter.placeBlockAt(pos, [name], signal);
      if (!result.ok || adapter.blockAt(pos) !== name) {
        throw Object.assign(new Error(result.reason ?? `PLACEMENT_MISMATCH:${name}`),
          { details: { target: pos, material: name, placed, confirmedRises, ...(result.ok ? {} : { reason: result.reason }) } });
      }
    };
    try {
      for (const u of [1, 2]) {
        const pos = at(u, 0);
        const name = adapter.blockAt(pos);
        if (name === 'obsidian') continue;
        if (name && !AIR.has(name)) {
          if (!TERRAIN.has(name)) return fail('BAD_ARGS', `门底部包含受保护方块 ${name}`);
          await adapter.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 20000 });
          const result = await adapter.dig(pos, signal);
          if (!result.ok) return fail('ERROR', `无法准备门底：${result.reason}`);
        }
      }
      const scaffold = () => adapter.state().inventory.find((i) => SCAFFOLD.includes(i.name) && i.count > 0)?.name;
      // 斜坡/坑地上底座悬空：给底座 4 列从实心地往上垫到 y=-1，让底座方块有处可贴
      for (let u = 0; u <= 3; u++) {
        let solid: number | null = null;
        for (let yy = 0; yy >= -8; yy--) {
          const n = adapter.blockAt(at(u, yy));
          if (n === null) continue;
          if (!AIR.has(n)) { solid = yy; break; }
        }
        if (solid === null) return fail('NOT_FOUND', `底座第 ${u} 列下方 8 格都是空的（太陡或悬空），换一块更平的地再立门`);
        for (let yy = solid + 1; yy <= -1; yy++) {
          const m = scaffold();
          if (!m) return fail('MISSING_MATERIALS', '底座悬空，缺脚手架方块（圆石/泥土）垫平');
          await place(at(u, yy), m);
        }
      }
      for (const [u, y] of [[0, 0], [3, 0]]) {
        const pos = at(u, y);
        const current = adapter.blockAt(pos);
        if (!current) return fail('NOT_FOUND', '支撑位置尚未加载');
        if (AIR.has(current)) { const material = scaffold(); if (!material) return fail('MISSING_MATERIALS', '缺少施工支撑块'); await place(pos, material); }
      }
      for (const pos of frame.slice(0, 8)) {
        if (adapter.blockAt(pos) !== 'obsidian') { await place(pos, 'obsidian'); placed++; }
        ctx.progress(placed / 11, '门框逐块验收');
      }
      // 门顶第一块只能贴在角上的施工块上；上次留下的施工块仍在就直接复用。
      if (AIR.has(adapter.blockAt(at(0, 4)) ?? '')) {
        const material = scaffold();
        if (!material) return fail('MISSING_MATERIALS', '门顶施工需要一块支撑材料', { placed });
        await place(at(0, 4), material);
      }
      for (const pos of frame.slice(8)) { if (adapter.blockAt(pos) !== 'obsidian') { await place(pos, 'obsidian'); placed++; } }
      if (frame.some((pos) => adapter.blockAt(pos) !== 'obsidian')) return fail('ERROR', '门框实际方块未通过验收', { placed });
      const ignited = await adapter.useBlockAt(at(1, 0), 'flint_and_steel', signal);
      if (!ignited.ok) return fail('ERROR', `无法点燃门：${ignited.reason}`, { placed });
      for (let tries = 0; tries < 10; tries++) {
        if (adapter.blockAt(at(1, 1)) === 'nether_portal') {
          const portal = travelStore(ctx.memory).observe(adapter.state(), at(1, 1), 'nether_portal');
          ctx.memory.addLandmark('discovery', `下界门 ${portal.id}`, state.dim, portal.pos, 4);
          for (const l of ctx.memory.landmarks()) {
            if (l.label === partialLabel && l.dim === state.dim && dist3(l.pos, args.origin) <= 1) ctx.memory.removeLandmark(l.id);
          }
          return ok(`下界门已点燃并验收：${portal.id}`, { portalId: portal.id, placed, obsidianFrame: frame });
        }
        await sleep(200, signal);
      }
      return fail('ERROR', '门框存在但没有观察到激活后的传送门', { placed });
    } catch (error) {
      if (isAbort(error)) {
        // 取消/超时也保留已经确认的放置与垫高，以及实测位置和原门址，不能只剩一个取消码。
        (error as Error & { partial?: Record<string, unknown> }).partial = {
          placed, confirmedRises, position: { ...adapter.state().pos },
          ...(lastPlacementTarget ? { target: lastPlacementTarget } : {}),
          portal: { origin: args.origin, axis: args.axis },
        };
        throw error;
      }
      const details = (error as Error & { details?: Record<string, unknown> }).details;
      return fail(codeFromError(error), `建门中断：${(error as Error).message}`, { placed, confirmedRises, ...(details ?? {}) });
    }
  },
};

export const observePortal: Skill<{}> = {
  name: 'observe_portal', description: '记录亲眼见过且当前能核对的下界门或末地门；不会猜测另一端的位置。只记录已激活的门方块：未点燃的黑曜石框不是门（框规则查 knowledge:obsidian-and-portal-building）', argsDoc: '{}', timeoutMs: 15000, movement: false,
  validate: () => ({ ok: true, args: {} }),
  async run(ctx) {
    ctx.senses.refresh();
    const state = ctx.adapter.state();
    const kinds = ['nether_portal', 'end_portal', 'end_gateway'];
    // 先扫当前视野里看得见的门（记忆可能因死亡/换维度而失效，眼前看得见的才是此刻能核对的），再看记忆里的门位置重验
    const here = state.pos;
    const feet = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
    // 身体高两格，直接站在门下时门方块可能在脚上方第 2–3 格；只扫 ±1 会漏掉“头顶上的门”。
    // 这里扩大扫描窗口，但仍由 observeBlocks 要求本次视野证据，不透视。
    const around = [-2, -1, 0, 1, 2].flatMap((dx) => [-1, 0, 1, 2, 3].flatMap((dy) => [-2, -1, 0, 1, 2].map((dz) =>
      ({ x: Math.floor(here.x) + dx, y: Math.floor(here.y) + dy, z: Math.floor(here.z) + dz }))));
    // 刚传送到门里时，门方块就在脚下/身上，视锥可能正好看不到它；只核对身体真正占据的脚/头两格，
    // 不把旁边一格的方块当“亲眼见过”（那会绕过视觉边界）。
    const touching = [feet, { ...feet, y: feet.y + 1 }]
      .map((pos) => ({ pos, name: ctx.adapter.blockAt(pos) }))
      .filter((b): b is { pos: Vec3Like; name: string } => !!b.name && kinds.includes(b.name));
    const remembered = [
      ...ctx.senses.knownBlocks(kinds, 8).map((block) => block.pos),
      ...travelStore(ctx.memory).snapshot(state.worldId).endpoints
        .filter((e) => e.dim === state.dim && e.portalObserved && dist3(e.pos, here) <= 8).map((e) => e.pos),
    ];
    // 本帧视线刚命中的门方块（如 4 格外的门洞）也是候选；仍由 visiblePortal 用本次视野核对。
    const inFrame = ctx.senses.currentBlockCandidates?.(kinds).map((block) => block.pos) ?? [];
    let portal: { pos: Vec3Like; name: string } | undefined = visiblePortal(ctx, around, kinds) ?? visiblePortal(ctx, inFrame, kinds)
      ?? visiblePortal(ctx, remembered, kinds) ?? touching[0];
    // 记得附近有门、但它不在当前视锥里：朝记得的门方块转头再看（最多 3 处），仍由本次视野核对，不透视。
    let turned = 0;
    for (const pos of remembered.slice(0, 3)) {
      if (portal) break;
      const eye = ctx.adapter.eye();
      if (!eye) break;
      const dx = pos.x + 0.5 - eye.x, dy = pos.y + 0.5 - eye.y, dz = pos.z + 0.5 - eye.z;
      await ctx.adapter.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      turned++;
      await sleep(200, ctx.signal);
      ctx.senses.refresh();
      portal = visiblePortal(ctx, [pos, { ...pos, y: pos.y - 1 }, { ...pos, y: pos.y + 1 }], kinds);
    }
    if (!portal) {
      return fail('NOT_FOUND', remembered.length
        ? `记得附近有门（${remembered.length} 处），转头看了 ${turned} 处，这次视野仍核对不到门方块（可能被挡住或已不在）；未点燃的黑曜石框不是门（框规则查 knowledge:obsidian-and-portal-building）`
        : '附近没有已观察并能核对的传送门；未点燃的黑曜石框不是门（框规则查 knowledge:obsidian-and-portal-building）', { remembered: remembered.slice(0, 3), turned });
    }
    // 身体 AABB 压着的门方块才是“我在门里”的触觉事实；优先用适配器按 AABB 算出的字段，
    // 拿不到时退回脚/头两格（end_gateway 不靠身体接触触发，不算）。
    const bodyPortal = state.bodyPortal ?? [feet, { ...feet, y: feet.y + 1 }]
      .map((pos) => ctx.adapter.blockAt(pos))
      .find((name): name is string => name === 'nether_portal' || name === 'end_portal');
    const endpoint = travelStore(ctx.memory).observe(state, portal.pos, portal.name as PortalEndpoint['kind']);
    // 也记进常规记忆（地标），让 recall / places 能找回来，不只是 travelStore 里的一份；下界门在下界这一端尤其要靠它记住
    ctx.memory.addLandmark('discovery', `${PORTAL_LABEL[endpoint.kind]} ${endpoint.id}`, state.dim, endpoint.pos, 4);
    // 门外站位是按门几何算出来的候选点（没站过、没验证），只作为事实回报给心智，不替它写进地标记忆。
    const stance = ctx.adapter.portalStance?.(portal.pos);
    const bodyNote = bodyPortal ? `；身体现在与门方块 ${bodyPortal} 重叠` : '';
    const stanceNote = stance ? `；按门几何算出的门外站位 (${stance.x},${stance.y},${stance.z})，未站过` : '';
    return ok(`记录传送门 ${endpoint.id}${bodyNote}${stanceNote}`, { portalId: endpoint.id, endpoint, ...(stance ? { stance } : {}), ...(bodyPortal ? { bodyPortal } : {}) });
  },
};

async function traverse(ctx: SkillCtx, endpoint: PortalEndpoint) {
  const { adapter, signal } = ctx;
  const state = adapter.state();
  if (endpoint.kind === 'end_gateway') return fail('BAD_ARGS', '末地折跃门使用 use_end_gateway 技能与末影珍珠');
  if (endpoint.dim !== state.dim) return fail('WRONG_DIMENSION', `门在 ${endpoint.dim}，没有跨维度自动寻路`);
  if (!endpoint.portalObserved) return fail('NOT_FOUND', '该端只有到达位置，尚未观察到可返回的门');
  if (!adapter.enterPortalAt) return fail('ERROR', '适配器没有传送门进入能力');
  try {
    const nowBlock = adapter.blockAt(endpoint.pos);
    if (nowBlock !== endpoint.kind) {
      // 直接读到门方块位置上的实际方块，是当前观测：门不在就作废这条记录，
      // 不再让 recall/observe_portal 把它当成“记录里仍是门方块”反复使用。
      // 未加载（null）只说明看不了，不能据此判定门已消失。
      const invalidated = nowBlock != null;
      if (invalidated) {
        ctx.memory.markGone(endpoint.kind, endpoint.dim, endpoint.pos, nowBlock);
        ctx.memory.markGone(`${PORTAL_LABEL[endpoint.kind]} ${endpoint.id}`, endpoint.dim, endpoint.pos, nowBlock);
      }
      return fail('NOT_FOUND', `门方块现在的实际方块是 ${nowBlock ?? '未加载'}，不是记录时的 ${endpoint.kind}（记录于 ${portalAgeText(endpoint.observedAt)}）${invalidated ? '；已作废这条门记录，不再列为可用门' : '；那片没加载，不能确认门已消失'}`, {
        portalId: endpoint.id, pos: endpoint.pos, expected: endpoint.kind, actual: nowBlock,
        portalObserved: endpoint.portalObserved, observedAt: endpoint.observedAt, invalidated,
      });
    }
    ctx.setStationaryWait?.(true);
    const result = await adapter.enterPortalAt(endpoint.pos, signal).catch((error: unknown) => {
      // 被取消/到期时把身体此刻的实测事实带回去：走到了哪、离门多远、在不在门方块里。
      if (isAbort(error)) {
        const now = adapter.state();
        const dist = Math.hypot(now.pos.x - (endpoint.pos.x + 0.5), now.pos.y - endpoint.pos.y, now.pos.z - (endpoint.pos.z + 0.5));
        Object.assign(error as object, { partial: {
          position: { ...now.pos }, portal: { ...endpoint.pos }, bodyPortal: now.bodyPortal ?? null,
          progressNote: `停下时脚位 (${now.pos.x.toFixed(1)},${now.pos.y.toFixed(1)},${now.pos.z.toFixed(1)})，距门方块 ${dist.toFixed(1)} 格，${now.bodyPortal ? `身体在 ${now.bodyPortal} 方块里` : '身体不在门方块里'}${now.dim === endpoint.dim ? '' : `，已在 ${now.dim}`}`,
        } });
      }
      throw error;
    });
    throwIfAborted(signal);
    // 把身体实际经历的时间线写给心智：它需要知道“开始就在门里 / 出去多久 / 在门里待了多久”，
    // 才能判断该不该先离开门再进，而不是只看到一个超时码。
    const timeline = result.transition
      ? [
          result.transition.startedInPortal ? '开始时身体已在门方块里' : '开始时不在门方块里',
          ...(result.transition.exitMs !== null ? [`退出门 ${(result.transition.exitMs / 1000).toFixed(1)}s`] : []),
          ...(result.transition.outsideMs !== null ? [`门外停留 ${(result.transition.outsideMs / 1000).toFixed(1)}s 后重新进入`] : []),
          result.transition.entered
            ? (result.transition.insideMs > 0 ? `在门方块里连续 ${(result.transition.insideMs / 1000).toFixed(1)}s` : '进入过门方块，结束时已不在门里')
            : '没有进入门方块',
          `维度 ${result.transition.endDim}`,
        ].join('；')
      : '';
    // 门内等待超时后给一句可执行的区分：如果身体确实在门方块里待了很久，问题更像
    // 传送冷却/服务器延迟/对端未就绪，不是站位；让心智先离开/换门，别连续重进。
    const insideMs = result.transition?.insideMs ?? 0;
    const transitionHint = result.reason === 'PORTAL_TRANSITION_TIMEOUT'
      ? insideMs >= 5000
        ? '；服务器在门方块内等了这么久仍未切换，更像传送冷却、服务器延迟或对端未就绪，不是门框位置问题；先离开门几秒再试，或改走另一扇已登记的门，不要连续重进'
        : '；身体没有稳定停在门方块里，先站进去再等'
      : '';
    if (!result.ok || !result.from || !result.to) {
      const end = adapter.state().pos;
      const where = `；结束时实测脚位 (${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)})，门方块 (${endpoint.pos.x},${endpoint.pos.y},${endpoint.pos.z})`;
      return fail('ERROR', `传送未验收（${result.reason}）${timeline ? `：${timeline}` : ''}${transitionHint}${where}`, { ...(result.transition ? { transition: result.transition } : {}), portalReason: result.reason, position: { ...end } });
    }
    const to = result.to;
    if (!to.observationReady || to.dim === state.dim || to.worldId !== state.worldId || to.sessionId === state.sessionId) return fail('ERROR', '没有获得新维度的有效观察');
    // Arrival is a fact; a nearby return portal still requires fresh sight.
    const positions = [-2, -1, 0, 1, 2].flatMap((dx) => [-1, 0, 1].flatMap((dy) => [-2, -1, 0, 1, 2].map((dz) => ({
      x: Math.floor(to.pos.x) + dx, y: Math.floor(to.pos.y) + dy, z: Math.floor(to.pos.z) + dz,
    }))));
    const observed = visiblePortal(ctx, positions, [endpoint.kind]);
    const store = travelStore(ctx.memory);
    const destination = store.observe(to, observed?.pos ?? to.pos, endpoint.kind, !!observed);
    store.record(endpoint.id, destination.id, result.from, to);
    const routes = store.snapshot(to.worldId).routes;
    const roundTripVerified = routes.some((r) => r.fromId === endpoint.id && r.toId === destination.id && r.returnVerified);
    // 快速往返是事实而不是结论：两次反向穿越间隔很短时如实说出，是否带回物品由背包账判断。
    // 当前这趟是 endpoint→destination，方向相反；反向记录不可能由本次刚写入，不必再排除“刚刚”。
    const reverse = routes.filter((r) => r.fromId === destination.id && r.toId === endpoint.id
      && Date.now() - r.ts < 10 * 60_000).sort((a, b) => b.ts - a.ts)[0];
    const quickReturn = reverse ? { msAgo: Date.now() - reverse.ts, fromId: destination.id, toId: endpoint.id } : null;
    ctx.memory.setWorld(to.worldId);
    const stand = result.stand ?? to;
    const leftPortal = result.leftPortal;
    // 只有确认身体已离开门方块（或适配器不检查）才记“门外站位”地标；仍在门里时不写 waypoint，
    // 避免把门方块本身标成可回去的落脚点。事实文字仍如实说明“到达后仍在门方块里”。
    if (leftPortal !== false) {
      const waypointLabel = leftPortal === undefined ? `传送到达 ${destination.id}` : `传送到达 ${destination.id} 门外站位`;
      ctx.memory.addLandmark('waypoint', waypointLabel, to.dim, stand.pos, 3);
    }
    // 离开门口以落点观测里的身体门接触状态为准；适配器的 leftPortal 只是执行回执，
    // 两者不一致时如实并列，不把“已离开门口”当成确认事实。
    const standBodyPortal = stand.bodyPortal ?? null;
    const leftPortalConfirmed = leftPortal === undefined ? null : standBodyPortal === null;
    const settleNote = leftPortal === undefined ? ''
      : leftPortalConfirmed
        ? `；已站到门外 (${stand.pos.x.toFixed(1)},${stand.pos.y.toFixed(1)},${stand.pos.z.toFixed(1)})，面朝离开门的方向`
        : leftPortal
          ? `；适配器报告已离开门口，但落点观测仍显示身体在 ${standBodyPortal} 里`
          : '；到达后仍在门方块里';
    const dwellNote = result.transition && result.transition.insideMs > 0 ? `；门内停留 ${(result.transition.insideMs / 1000).toFixed(1)}s 后切换` : '';
    const quickNote = quickReturn
      ? `；距上次反向穿越仅 ${quickReturn.msAgo < 120_000 ? `${Math.round(quickReturn.msAgo / 1000)}s` : `${Math.round(quickReturn.msAgo / 60_000)} 分钟`}（快速往返；是否带回物品看背包账，不能把穿越本身当成进展）`
      : '';
    return ok(`已通过实际传送到达 ${to.dim}，记录两端位置；返程入口 ${destination.id}${observed ? '' : ' 尚需寻找'}${roundTripVerified ? '；往返已验证' : ''}${dwellNote}${settleNote}${quickNote}`, { fromId: endpoint.id, toId: destination.id, from: result.from, to, stand: result.stand, leftPortal, standBodyPortal, leftPortalConfirmed, transition: result.transition, roundTripVerified, ...(quickReturn ? { quickReturn } : {}) });
  } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `传送失败：${(error as Error).message}（门离你约 ${Math.round(dist3(state.pos, endpoint.pos))} 格，在 ${endpoint.pos.x},${endpoint.pos.y},${endpoint.pos.z}）`); } finally { ctx.setStationaryWait?.(false); }
}

export const travelPortal: Skill<{ portalId: string; at?: Vec3Like }> = {
  name: 'travel_portal', description: '进入一个传送门，等待实际维度切换和新出生观察后记录真实出口。门用 portalId（observe_portal 记录的）或门方块坐标 at 指定；at 时该格此刻必须是 16 格内的下界门/末地门方块，会当场登记。身体先走到门前站位（导航不到就直接朝站位走，低一级会跳），再正面走进门洞并停留等传送；到达下界另一侧后会尝试把身体挪出目的地门方块（最多约 4 秒，leftPortal 如实报告）。', argsDoc: '{"portalId":"portal_id"} | {"at":[x,y,z]}（门方块坐标）', timeoutMs: 100000, movement: true,
  validate(raw) {
    const a = obj(raw);
    if (a.at !== undefined) {
      const at = a.at;
      if (!Array.isArray(at) || at.length !== 3 || !at.every((n) => Number.isInteger(n))) return { ok: false, error: 'at 需要门方块的整数坐标 [x,y,z]' };
      return { ok: true, args: { portalId: '', at: { x: at[0] as number, y: at[1] as number, z: at[2] as number } } };
    }
    const portalId = String(a.portalId ?? '').trim();
    return portalId ? { ok: true, args: { portalId } } : { ok: false, error: '缺少 portalId 或 at' };
  },
  async run(ctx, args) {
    if (args.at !== undefined) {
      const state = ctx.adapter.state();
      const name = ctx.adapter.blockAt(args.at);
      if (name !== 'nether_portal' && name !== 'end_portal') {
        return fail('NOT_FOUND', `(${args.at.x},${args.at.y},${args.at.z}) 现在是 ${name ?? '未加载'}，不是下界门或末地门方块；没有移动`, { at: { ...args.at }, actual: name });
      }
      if (dist3(state.pos, args.at) > 16) {
        return fail('BAD_ARGS', `门方块离身体 ${dist3(state.pos, args.at).toFixed(1)} 格，超过 16 格；先走近再进门`, { at: { ...args.at } });
      }
      const endpoint = travelStore(ctx.memory).observe(state, args.at, name);
      return traverse(ctx, endpoint);
    }
    const store = travelStore(ctx.memory);
    const state = ctx.adapter.state();
    const worldId = state.worldId;
    const requested = args.portalId.trim();
    const key = requested.toLowerCase();
    // The model repeatedly asked for "auto"/"nearest" after observe_portal.
    // Resolve those words deterministically to the nearest *observed* portal in
    // the current dimension; the agent still chose the selection rule, and the
    // resolved id is reported back.
    if (key === 'auto' || key === 'nearest') {
      const candidates = store.snapshot(worldId).endpoints
        .filter((endpoint) => endpoint.dim === state.dim && endpoint.portalObserved && endpoint.kind !== 'end_gateway')
        .sort((a, b) => dist3(state.pos, a.pos) - dist3(state.pos, b.pos) || a.id.localeCompare(b.id));
      const endpoint = candidates[0];
      if (!endpoint) {
        return fail('NOT_FOUND', `当前维度 ${state.dim} 没有已观察的可用传送门；先 observe_portal 或走近后再试。当前世界记得的门：${knownPortals(store, worldId)}`, {
          requestedPortalId: requested, dim: state.dim, candidates: [],
        });
      }
      const result = await traverse(ctx, endpoint);
      return {
        ...result,
        summary: `${result.summary}（按 ${key} 选择 ${endpoint.id}）`,
        data: { ...(result.data ?? {}), requestedPortalId: requested, resolvedPortalId: endpoint.id },
      };
    }
    const endpoint = store.get(requested, worldId);
    return endpoint
      ? traverse(ctx, endpoint)
      : fail('NOT_FOUND', `没有传送门 ${requested}；当前世界记得的门：${knownPortals(store, worldId)}`, { requestedPortalId: requested });
  },
};

export const recallPortal: Skill<{ returnId: string }> = {
  name: 'recall_portal', description: '从当前维度中已实际观察的返程门返回；反向穿越成功后才标记已验证往返。', argsDoc: '{"returnId":"portal_id"}', timeoutMs: 100000, movement: true,
  validate(raw) { const returnId = String(obj(raw).returnId ?? '').trim(); return returnId ? { ok: true, args: { returnId } } : { ok: false, error: '缺少 returnId' }; },
  async run(ctx, args) { const store = travelStore(ctx.memory); const worldId = ctx.adapter.state().worldId; const endpoint = store.get(args.returnId, worldId); return endpoint ? traverse(ctx, endpoint) : fail('NOT_FOUND', `没有返程门 ${args.returnId}；当前世界记得的门：${knownPortals(store, worldId)}`); },
};

export const activateEndPortal: Skill<{}> = {
  name: 'activate_end_portal', description: '只给已观察到的现成末地门框放末影之眼；逐框核对 eye 属性，确认真实末地门出现后记录。', argsDoc: '{}', timeoutMs: 120000, movement: true,
  validate: () => ({ ok: true, args: {} }),
  async run(ctx) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.blockStateAt || !adapter.useBlockAt) return fail('ERROR', '适配器缺少门框状态或交互能力');
    senses.refresh();
    const frames = senses.knownBlocks(['end_portal_frame'], 32);
    if (frames.length < 12) return fail('NOT_FOUND', '尚未实际观察到完整的 12 个末地门框');
    // A valid ring has a 3x3 interior and three inward-facing frames per side.
    let ring: typeof frames = [];
    let center: Vec3Like | null = null;
    for (const candidate of frames) {
      for (let dx = -2; dx <= 2 && !center; dx++) for (let dz = -2; dz <= 2 && !center; dz++) {
        const c = { x: candidate.pos.x + dx, y: candidate.pos.y, z: candidate.pos.z + dz };
        const expected = [-1, 0, 1].flatMap((offset) => [
          { pos: { x: c.x + offset, y: c.y, z: c.z - 2 }, facing: 'south' }, { pos: { x: c.x + offset, y: c.y, z: c.z + 2 }, facing: 'north' },
          { pos: { x: c.x - 2, y: c.y, z: c.z + offset }, facing: 'east' }, { pos: { x: c.x + 2, y: c.y, z: c.z + offset }, facing: 'west' },
        ]);
        if (expected.every((e) => frames.some((f) => dist3(f.pos, e.pos) === 0) && adapter.blockStateAt!(e.pos)?.properties.facing === e.facing)) { center = c; ring = expected.map((e) => frames.find((f) => dist3(f.pos, e.pos) === 0)!); }
      }
      if (center) break;
    }
    if (!center) return fail('NOT_FOUND', '已知门框未形成朝内的完整末地门环');
    const missing = ring.filter((frame) => ![true, 'true'].includes(adapter.blockStateAt!(frame.pos)?.properties.eye as any));
    const eyes = adapter.state().inventory.find((i) => i.name === 'ender_eye')?.count ?? 0;
    if (eyes < missing.length) return fail('MISSING_MATERIALS', `末地门还需要 ${missing.length} 颗末影之眼`);
    for (const frame of missing) {
      const result = await adapter.useBlockAt(frame.pos, 'ender_eye', signal);
      await sleep(150, signal);
      if (!result.ok || ![true, 'true'].includes(adapter.blockStateAt(frame.pos)?.properties.eye as any)) return fail('ERROR', '未确认末影之眼已经装入门框');
    }
    for (let retry = 0; retry < 10; retry++) {
      if (adapter.blockAt(center) === 'end_portal') {
        const endpoint = travelStore(ctx.memory).observe(adapter.state(), center, 'end_portal');
        return ok('实际末地门已激活', { portalId: endpoint.id });
      }
      await sleep(200, signal);
    }
    return fail('ERROR', '未观察到激活后的末地门，不能报告已完成');
  },
};

export const useEndGateway: Skill<{ portalId?: string }> = {
  name: 'use_end_gateway', description: '向实际观察到的末地折跃门投掷末影珍珠；只有同一存活会话的真实远距离位移才记录外岛到达及返程点。', argsDoc: '{"portalId"?:"已观察的折跃门 id"}', timeoutMs: 45000, movement: true,
  validate(raw) { const id = obj(raw).portalId; return id === undefined || typeof id === 'string' ? { ok: true, args: { portalId: id } } : { ok: false, error: 'portalId 必须为字符串' }; },
  async run(ctx, args) {
    const { adapter, signal, senses } = ctx;
    throwIfAborted(signal);
    const initial = adapter.state();
    if (initial.dim !== 'the_end') return fail('WRONG_DIMENSION', '末地折跃门只在末地使用');
    if (!adapter.useItem) return fail('ERROR', '适配器没有物品使用能力');
    if (initial.hp < 8 || !initial.inventory.some((i) => i.name === 'ender_pearl' && i.count > 0)) return fail('MISSING_MATERIALS', '需要末影珍珠且生命至少 8 点');
    const store = travelStore(ctx.memory);
    senses.refresh();
    const known = args.portalId ? store.get(args.portalId, initial.worldId) : undefined;
    const seen = !args.portalId ? visiblePortal(ctx, senses.knownBlocks(['end_gateway'], 64).map((block) => block.pos), ['end_gateway']) : undefined;
    const endpoint = known ?? (seen ? store.observe(initial, seen.pos, 'end_gateway') : undefined);
    if (!endpoint || endpoint.kind !== 'end_gateway' || !endpoint.portalObserved || endpoint.dim !== initial.dim) return fail('NOT_FOUND', '没有当前维度已观察到的折跃门');
    try {
      if (adapter.blockAt(endpoint.pos) !== 'end_gateway') return fail('NOT_FOUND', '折跃门已经改变或尚未加载');
      const sameSession = (state: ReturnType<typeof adapter.state>) => state.alive && state.connected && state.worldId === initial.worldId && state.dim === initial.dim && state.sessionId === initial.sessionId;
      const pearlCount = (state: ReturnType<typeof adapter.state>) => state.inventory.find((item) => item.name === 'ender_pearl')?.count ?? 0;
      const floorY = Math.floor(initial.pos.y);
      const stands = [{ x: -3, z: 0 }, { x: 3, z: 0 }, { x: 0, z: -3 }, { x: 0, z: 3 }].map((offset) => ({ x: endpoint.pos.x + offset.x + 0.5, y: floorY, z: endpoint.pos.z + offset.z + 0.5 })).filter((stand) => {
        const foot = { x: Math.floor(stand.x), y: stand.y, z: Math.floor(stand.z) }, support = adapter.blockAt({ ...foot, y: foot.y - 1 });
        return !!support && (TERRAIN.has(support) || ['end_stone', 'obsidian', 'bedrock', 'cobbled_deepslate'].includes(support) || support.endsWith('_planks')) && AIR.has(adapter.blockAt(foot) ?? '') && AIR.has(adapter.blockAt({ ...foot, y: foot.y + 1 }) ?? '');
      }).sort((left, right) => dist3(left, initial.pos) - dist3(right, initial.pos));
      const aim = { x: endpoint.pos.x + 0.5, y: endpoint.pos.y + 0.5, z: endpoint.pos.z + 0.5 };
      let from: ReturnType<typeof adapter.state> | null = null;
      let lastAttemptAt = 0;
      // A body directly beneath the gateway is not a valid launch proof. Keep
      // a supported side pose instead of letting a range-3 goal move beneath it.
      for (const stand of stands) {
        throwIfAborted(signal);
        if (Date.now() >= ctx.deadline - 50) break;
        try { await adapter.moveTo({ kind: 'near', pos: stand, range: 0.3 }, { signal, timeoutMs: Math.max(1, Math.min(12000, ctx.deadline - Date.now())) }); }
        catch (error) { if (isAbort(error)) throw error; continue; }
        const reached = adapter.state();
        if (!sameSession(reached)) return fail('ERROR', '投掷站位移动中观察会话中断');
        if (Math.hypot(reached.pos.x - stand.x, reached.pos.z - stand.z) > 0.9 || Math.abs(reached.pos.y - stand.y) > 0.6) continue;
        const result = await adapter.useItem('ender_pearl', signal, { aim });
        throwIfAborted(signal);
        if (!result.ok && result.reason === 'BLOCKED_AIM') continue;
        if (!result.ok) return fail('ERROR', `珍珠投掷失败：${result.reason}`);
        from = reached; lastAttemptAt = Date.now(); break;
      }
      if (!from) return fail('NOT_FOUND', '没有可达、有支撑且射线畅通的侧方投掷站位');
      const pearlsBefore = pearlCount(from);
      let throwAttempts = 1, pearlConsumed = false;
      const deadline = Math.min(ctx.deadline, Date.now() + 10000);
      for (let tick = 0; tick < 50 && Date.now() < deadline; tick++) {
        await sleep(Math.max(1, Math.min(200, deadline - Date.now())), signal);
        const to = adapter.state();
        if (!sameSession(to)) return fail('ERROR', '折跃过程会话中断，不能确认到达');
        if (pearlCount(to) < pearlsBefore) pearlConsumed = true;
        if (to.observationReady && dist3(from.pos, to.pos) >= 48) {
          const positions = [-3, -2, -1, 0, 1, 2, 3].flatMap((dx) => [-2, -1, 0, 1, 2].flatMap((dy) => [-3, -2, -1, 0, 1, 2, 3].map((dz) => ({
            x: Math.floor(to.pos.x) + dx, y: Math.floor(to.pos.y) + dy, z: Math.floor(to.pos.z) + dz,
          }))));
          const returnPos = visiblePortal(ctx, positions, ['end_gateway'])?.pos;
          const destination = store.observe(to, returnPos ?? to.pos, 'end_gateway', !!returnPos);
          store.recordGateway(endpoint.id, destination.id, from, to);
          ctx.memory.addLandmark('waypoint', `折跃后实际到达 ${destination.id}`, to.dim, to.pos, 3);
          return ok('已确认末地折跃后的实际位置并记录返程观察', { fromId: endpoint.id, toId: destination.id, from, to, returnPortalObserved: !!returnPos, throwAttempts, pearlConsumed });
        }
        // A use packet during vanilla's item cooldown can be ignored. Retry
        // only an unconsumed use after >1s; a consumed pearl is never replayed.
        if (!pearlConsumed && throwAttempts < 3 && Date.now() - lastAttemptAt >= 1200 && Date.now() < deadline - 200) {
          const retry = await adapter.useItem('ender_pearl', signal, { aim });
          throwIfAborted(signal);
          if (!retry.ok) return fail('ERROR', `珍珠重试失败：${retry.reason}`);
          throwAttempts++; lastAttemptAt = Date.now();
        }
      }
      return fail('TIMEOUT', '没有观察到折跃的真实远距离位移，不能宣称到达外岛', { throwAttempts, pearlConsumed, pearlsBefore, pearlsAfter: pearlCount(adapter.state()) });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `折跃中断：${(error as Error).message}`); }
  },
};

export const travelSkills = { build_portal: buildPortal, observe_portal: observePortal, travel_portal: travelPortal, recall_portal: recallPortal, activate_end_portal: activateEndPortal, use_end_gateway: useEndGateway };
