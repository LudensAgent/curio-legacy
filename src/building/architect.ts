import type { GameAdapter, InvItem } from '../adapter/types.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import { extractJson } from '../planner/plan.ts';
import type { ChatMessage } from '../planner/llm.ts';
import type { Planner } from '../planner/planner.ts';
import type { DesignDraft, DraftStore } from './drafts.ts';
import { compileBuilding, materialCost, normalizeSpec, type BuildingSpec } from './spec.ts';

/**
 * 建筑师子代理：在一份独立的上下文里专心设计一座建筑（带设计原则、参考作品、材料和场地），
 * 自己检查一两轮（能不能盖、住着舒不舒服、好不好看），交回一张能直接施工的图纸和材料清单。
 * 玩的那个模型只说“想要什么样的房子”，不用在一次游玩决定里硬挤出一整张字符画。
 */
export interface DesignRequest {
  brief: string;
  persona: string;
  inventory: InvItem[];
  biome?: string | null;
  nearby: string[];
  likes: string[];
  pastWorks: string[];
}

export type DesignResult = { ok: true; draft: DesignDraft; summary: string; issues: string[] } | { ok: false; error: string };

const count = (inv: InvItem[], name: string) => inv.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);

/** 外观和居住上的自查（不拦着盖，只是给建筑师改进的依据） */
export function critique(spec: BuildingSpec): string[] {
  const out: string[] = [];
  const blueprint = compileBuilding(spec);
  const cells = blueprint.cells;
  const names = new Set(cells.map((c) => c.name));
  const footprint = cells.filter((c) => c.pos.y === -1);
  const xs = footprint.map((c) => c.pos.x), zs = footprint.map((c) => c.pos.z);
  const w = xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0, d = zs.length ? Math.max(...zs) - Math.min(...zs) + 1 : 0;
  if (w - 2 < 3 || d - 2 < 3) out.push(`室内只有 ${Math.max(0, w - 2)}×${Math.max(0, d - 2)}，放不下床、箱子和工作台；住处的墙脚至少 5×5`);
  if (![...names].some((n) => /_stairs$|_slab$/.test(n)) && w >= 5) out.push('屋顶是平的方盒子：试试用台阶一层层往里收做坡顶，或者在屋顶外面加一圈半砖做屋檐');
  const structural = [...names].filter((n) => !/door|glass|pane|torch|lantern|crafting_table|furnace|chest|stairs|slab|carpet|ladder|trapdoor|fence/.test(n));
  if (structural.length < 2) out.push(`墙和地板只用了 ${structural.join('、') || '一种材料'}：墙基用石头、四角用原木，层次会好很多`);
  if (![...names].some((n) => /glass|pane/.test(n))) out.push('没有窗户，屋里会很闷');
  if (![...names].some((n) => /torch|lantern/.test(n))) out.push('屋里没有光源，晚上会刷怪');
  return out;
}

export function buildDesignMessages(req: DesignRequest, book: SkillBook | null): ChatMessage[] {
  const guide = book?.get('architect')?.body ?? '';
  const system = `${req.persona}

你现在是自己的建筑师：专心设计一座 Minecraft 建筑，交回一张能直接施工的图纸。${guide ? `\n\n下面是你的设计手册：\n\n${guide}` : ''}

只输出一个 JSON 对象：
{"name":"作品名（简短）","purpose":"用途","style":"一句话说说风格和用料的想法","design":{"legend":{…},"layers":[[…],…]},"notes":"一句话：盖的时候要注意什么"}`;
  const inv = new Map<string, number>();
  for (const i of req.inventory) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
  const payload = {
    request: req.brief,
    inventory: [...inv].map(([n, c]) => `${n}×${c}`),
    nearby_materials: req.nearby,
    biome: req.biome ?? null,
    my_likes: req.likes,
    my_past_works: req.pastWorks,
  };
  return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(payload)}\n请设计。` }];
}

export async function designBuilding(planner: Planner, book: SkillBook | null, drafts: DraftStore, adapter: Pick<GameAdapter, 'isKnownItem'>,
  req: DesignRequest, signal: AbortSignal): Promise<DesignResult> {
  const messages = buildDesignMessages(req, book);
  let best: { spec: BuildingSpec; raw: Record<string, any>; issues: string[] } | null = null;
  let lastError = '';
  for (let round = 0; round < 3; round++) {
    signal.throwIfAborted();
    const c = await planner.complete(messages, { label: 'architect', tier: 'full', signal, attempt: round });
    let raw: Record<string, any>;
    let spec: BuildingSpec;
    try {
      raw = extractJson(c.text) as Record<string, any>;
      spec = normalizeSpec({ name: String(raw.name ?? '我的房子').slice(0, 60), purpose: String(raw.purpose ?? '住处').slice(0, 200), design: raw.design });
      const unknown = Object.keys(materialCost(compileBuilding(spec).cells)).filter((n) => !adapter.isKnownItem(n));
      if (unknown.length) throw new Error(`当前游戏版本没有这些方块：${unknown.join('、')}`);
    } catch (e) {
      lastError = (e as Error).message;
      planner.noteInvalid('architect', lastError);
      messages.push({ role: 'assistant', content: c.text.slice(0, 4000) }, { role: 'user', content: `这张图纸没法施工：${lastError}。请改正后重新输出完整的 JSON。` });
      continue;
    }
    const issues = critique(spec);
    if (!best || issues.length < best.issues.length) best = { spec, raw, issues };
    if (!issues.length || round === 2) break;
    messages.push({ role: 'assistant', content: c.text.slice(0, 4000) },
      { role: 'user', content: `自查发现：\n- ${issues.join('\n- ')}\n保留你满意的部分，改进这些问题后重新输出完整的 JSON（如果你觉得某条不适合这座建筑，可以在 notes 里说明理由并保持原样）。` });
  }
  if (!best) return { ok: false, error: `建筑师没能画出能施工的图纸：${lastError}` };
  const blueprint = compileBuilding(best.spec);
  const materials = materialCost(blueprint.cells);
  const fx = blueprint.cells.filter((c) => c.pos.y === -1).map((c) => c.pos.x), fz = blueprint.cells.filter((c) => c.pos.y === -1).map((c) => c.pos.z);
  const size = { width: Math.max(...fx) - Math.min(...fx) + 1, depth: Math.max(...fz) - Math.min(...fz) + 1, height: best.spec.height };
  const draft = drafts.add({ name: best.spec.name, purpose: best.spec.purpose, brief: req.brief.slice(0, 200), ...(best.raw.style ? { style: String(best.raw.style).slice(0, 200) } : {}),
    spec: best.spec, materials, size, notes: [best.raw.notes, ...best.issues].filter(Boolean).map((n) => String(n).slice(0, 160)) });
  const missing = Object.entries(materials).map(([n, need]) => [n, need - count(req.inventory, n)] as const).filter(([, m]) => m > 0);
  const summary = `图纸 ${draft.id}「${draft.name}」墙脚 ${size.width}×${size.depth}、高 ${size.height}${draft.style ? `；${draft.style}` : ''}。用料：${Object.entries(materials).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join('、')}。`
    + (missing.length ? `还缺：${missing.map(([n, m]) => `${n}×${m}`).join('、')}（攒够再盖，或者先盖一部分）。` : '材料都齐了。')
    + `要盖时用 build {"draft":"${draft.id}"}。${best.issues.length ? `建筑师留下的提醒：${best.issues.join('；')}` : ''}`;
  return { ok: true, draft, summary, issues: best.issues };
}
