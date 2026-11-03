/**
 * Isolated architect benchmark; never connects to Minecraft or writes live agent data.
 * node --use-env-proxy --experimental-transform-types scripts/benchmark-architect.ts --curio=live --dry-run
 * Options: --out=... --efforts=off,low,high,max --caps=8192,16384,32768
 *          --scenarios=simple,cottage,complex|warehouse,watchtower,garden --replicate=1 --rounds=1 --concurrency=3
 *          --cache=cold|natural --timeout-ms=240000 --retry-errors
 * Reusing an output directory resumes completed samples. Request parameters do not
 * silently fall back when rejected. Original prompts and all returned designs survive.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import minecraftData from 'minecraft-data';
import { config } from '../src/config.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { buildDesignMessages, buildKindOf, budgetIssues, critique, isBlocking, type DesignRequest } from '../src/building/architect.ts';
import { compileBuilding, normalizeSpec } from '../src/building/spec.ts';
import { compileDesign } from '../src/building/design.ts';
import { extractJson } from '../src/planner/plan.ts';
import type { ChatMessage } from '../src/planner/llm.ts';

const option = (name: string, fallback: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = path.resolve(option('out', '.roadmap-validation/architect-20261103/screen'));
const efforts = option('efforts', 'off,low,high,max').split(',');
const caps = option('caps', '8192,16384,32768').split(',').map(Number);
const rounds = Number(option('rounds', '1'));
const replicate = Number(option('replicate', '1'));
const concurrency = Number(option('concurrency', '3'));
const dry = process.argv.includes('--dry-run');
const cache = option('cache', 'cold');
const timeoutMs = Number(option('timeout-ms', '240000'));
if (!['cold', 'natural'].includes(cache)) throw new Error('cache must be cold or natural');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeout-ms must be 1000–600000');
if (efforts.some((v) => !['off', 'low', 'high', 'max'].includes(v)) || caps.some((v) => !Number.isInteger(v) || v < 1024 || v > 65536)
  || ![1, 2, 3].includes(rounds) || !Number.isInteger(replicate) || replicate < 1 || ![1, 2, 3, 4].includes(concurrency)) throw new Error('Invalid benchmark options');
if (!dry && (!config.llm.apiKey || !/deepseek/i.test(config.llm.model))) throw new Error('This experiment requires the configured DeepSeek endpoint and key');

const registry = minecraftData('1.20.1');
const book = new SkillBook();
const inventory = ['cobblestone', 'stone_bricks', 'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks', 'oak_log', 'spruce_log', 'dark_oak_stairs', 'spruce_stairs', 'oak_stairs', 'oak_slab', 'spruce_slab', 'dark_oak_slab', 'glass_pane', 'glass', 'oak_door', 'spruce_door', 'torch', 'lantern', 'crafting_table', 'furnace', 'chest', 'oak_fence', 'spruce_trapdoor'].map((name) => ({ name, count: 256 }));
const scenes = [
  { id: 'simple', width: 5, depth: 5, brief: '设计5×5墙脚单层小屋，石基、橡木墙、平顶加半砖屋檐，南侧入口，左右各一扇窗；室内保留连续走道，放工作台、箱子和火把。不要床。' },
  { id: 'cottage', width: 7, depth: 7, brief: '设计7×7墙脚林间住宅，浅色墙与深色坡顶、原木柱、出挑一格的屋檐；窗户位置有秩序，入口明确，室内工作台、箱子和熔炉靠墙且不堵门，有照明。不要床。' },
  { id: 'complex', width: 9, depth: 7, brief: '设计9×7墙脚住宅，总图含屋檐不超过13×13；坡顶、入口小门廊，主入口与窗户有视觉主次，左右可以不完全对称但整体协调；保留连续内部空间，工作台、箱子、熔炉靠墙，有照明。少于900块，不使用床、水、旗帜等不支持物品。' },
  { id: 'warehouse', width: 9, depth: 7, facilities: ['chest'], southEntry: false,
    extraMaterials: ['stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall'],
    brief: '设计9×7墙脚的独立物资仓库，用石材为主、少量木材点缀，轮廓有层次，入口清楚，立面有节奏。至少6个箱子沿墙有序排列，每个箱子前方可走到、上方可打开，连续主通道连接入口；顶部完整遮雨，有照明。不需要床、工作台或熔炉。总图不超过13×13、512个施工方块。' },
  { id: 'watchtower', width: 5, depth: 5, facilities: ['ladder'], southEntry: false,
    extraMaterials: ['stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall', 'ladder', 'oak_fence_gate'],
    brief: '设计5×5基座的独立瞭望塔，图纸含地基层共10层以内。石材为主、少量木材点缀，塔身修长，顶部观景平台和护栏形成清楚的轮廓。入口可走入，内部连续梯子通到顶部，平台在梯子出口处留洞且能站人；上下通行不被方块封死，有照明。不要额外的居住设施。少于512个施工方块。' },
  { id: 'garden', width: 9, depth: 9, facilities: [], southEntry: false,
    extraMaterials: ['stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall', 'oak_fence_gate', 'grass_block', 'dirt', 'oak_leaves', 'azalea', 'poppy', 'dandelion', 'flower_pot'],
    brief: '设计9×9范围的露天庭院花园，石质步道从清晰入口通向中心，花坛与低矮绿篱有秩序，留出一处可停留的座椅和照明；中心有视觉焦点，整体有疏密和对称秩序，行走路径连续、两格净空。无水景，无封闭顶盖，不需要居住设施。用少量木材点缀、土草承托植物，花草必须实际画进图纸。少于512个施工方块。' },
].filter((v) => option('scenarios', 'simple,cottage,complex').split(',').includes(v.id));
if (!scenes.length) throw new Error('No matching scenarios');
const requests = scenes.map((scene) => {
  const req: DesignRequest = {
    brief: scene.brief, persona: config.persona, inventory: [...inventory, ...(scene.extraMaterials ?? []).map((name) => ({ name, count: 256 }))], nearby: ['oak_log', 'spruce_log', 'stone'], biome: 'forest',
    likes: ['喜欢材料协调、轮廓清晰且住起来不拥挤的建筑'], pastWorks: [scene.extraMaterials ? '已经建过一座实用小屋，这次设计不同用途的新建筑' : '已经建过一座实用小屋，这次设计新住宅'],
    terrain: { center: { x: 0, y: 63, z: 0 }, radius: 8, summary: '测试场地：17×17已观察平坦露天干地，无树无水', rows: Array.from({ length: 17 }, () => Array(17).fill('0').join(' ')), heights: Array.from({ length: 17 }, () => Array<number>(17).fill(0)), trees: Array.from({ length: 17 }, () => Array<boolean>(17).fill(false)) },
  };
  const messages = buildDesignMessages(req, book);
  return { scene, req, messages, promptHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
});

function evaluate(content: string, req: DesignRequest, expected: { width: number; depth: number; facilities?: string[]; southEntry?: boolean }) {
  try {
    const raw = extractJson(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('design' in raw)) throw new Error('Missing design object');
    const input = raw as Record<string, unknown>;
    const spec = normalizeSpec({ name: String(input.name ?? '我的房子').slice(0, 60), purpose: String(input.purpose ?? '住处').slice(0, 200), design: input.design });
    const blueprint = compileBuilding(spec), cells = blueprint.cells;
    const unknown = [...new Set(cells.map((c) => c.name))].filter((n) => !registry.itemsByName[n]);
    if (unknown.length) throw new Error(`Unknown 1.20.1 items: ${unknown.join(', ')}`);
    const warnings = compileDesign(spec.design!).warnings;
    const issues = [...critique(spec, buildKindOf(req.brief)), ...budgetIssues(spec, req, buildKindOf(req.brief))];
    const floors = cells.filter((c) => c.pos.y === -1);
    const xs = floors.map((c) => c.pos.x), zs = floors.map((c) => c.pos.z);
    const footprint = { width: Math.max(...xs) - Math.min(...xs) + 1, depth: Math.max(...zs) - Math.min(...zs) + 1 };
    const names = new Set(cells.map((c) => c.name));
    const byPos = new Map(cells.map((c) => [c.id, c]));
    // A conservative two-block headroom check, not a full Minecraft collision simulation.
    const passable = (x: number, y: number, z: number) => {
      const c = byPos.get(`${x},${y},${z}`);
      return !c || /_door$|torch$|_carpet$/.test(c.name);
    };
    const walkable = new Set(floors.filter((c) => passable(c.pos.x, 0, c.pos.z) && passable(c.pos.x, 1, c.pos.z)).map((c) => `${c.pos.x},${c.pos.z}`));
    const doors = cells.filter((c) => c.properties.half === 'lower' && c.name.endsWith('_door'));
    const seeds = doors.map((c) => `${c.pos.x},${c.pos.z}`).filter((k) => walkable.has(k));
    const reached = new Set(seeds), queue = [...seeds];
    for (let i = 0; i < queue.length; i++) {
      const [x, z] = queue[i].split(',').map(Number);
      [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]].forEach(([xx, zz]) => {
        const key = `${xx},${zz}`;
        if (walkable.has(key) && !reached.has(key)) { reached.add(key); queue.push(key); }
      });
    }
    const blockedDoors = doors.filter((c) => {
      const [dx, dz] = c.properties.facing === 'north' ? [0, 1] : c.properties.facing === 'south' ? [0, -1] : c.properties.facing === 'west' ? [1, 0] : [-1, 0];
      return !passable(c.pos.x + dx, c.pos.y, c.pos.z + dz) || !passable(c.pos.x + dx, c.pos.y + 1, c.pos.z + dz);
    }).length;
    const missingFacilities = (expected.facilities ?? ['crafting_table', 'chest', ...(expected.width > 5 ? ['furnace'] : [])]).filter((n) => !names.has(n));
    return { compiled: true, runtimeAccepted: !issues.some(isBlocking), width: spec.width, depth: spec.depth, height: spec.height, footprint,
      requestedFootprint: footprint.width === expected.width && footprint.depth === expected.depth, cells,
      materials: Object.fromEntries([...names].map((n) => [n, cells.filter((c) => c.name === n && !c.placedBy).length])),
      warnings, issues, blocking: issues.filter(isBlocking), doors: doors.length, blockedDoors, walkableFloor: walkable.size, reachableFloor: reached.size,
      missingFacilities, lighting: [...names].some((n) => /torch|lantern/.test(n)), windowCells: cells.filter((c) => /glass/.test(c.name)).length,
      requiredSouthEntry: (expected.southEntry ?? expected.width === 5) ? doors.some((c) => c.properties.facing === 'south') : null,
      style: String(input.style ?? ''), notes: String(input.notes ?? '') };
  } catch (error) { return { compiled: false, runtimeAccepted: false, error: error instanceof Error ? error.message : String(error) }; }
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } };
type Chunk = { id?: string; model?: string; usage?: Usage; choices?: { finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string } }[] };
async function complete(messages: ChatMessage[], effort: string, maxTokens: number) {
  const body = { model: config.llm.model, messages, temperature: config.llm.temperature, max_tokens: maxTokens,
    ...(config.llm.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(effort === 'off' ? { thinking: { type: 'disabled' } } : { reasoning_effort: effort }), stream: true, stream_options: { include_usage: true } };
  const started = Date.now();
  let content = '', reasoningChars = 0, firstDeltaMs: number | null = null, firstReasoningMs: number | null = null, firstContentMs: number | null = null, finishReason: string | null = null, usage: Usage | null = null, model: string | null = null;
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const decoder = new TextDecoder();
  let pending = '';
  for await (const bytes of res.body) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split('\n'); pending = lines.pop()!;
    lines.filter((line) => line.startsWith('data:')).forEach((line) => {
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as Chunk;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const text = choice?.delta?.content ?? '';
      const reasoning = choice?.delta?.reasoning_content ?? '';
      if ((text || reasoning) && firstDeltaMs === null) firstDeltaMs = Date.now() - started;
      if (reasoning && firstReasoningMs === null) firstReasoningMs = Date.now() - started;
      if (text && firstContentMs === null) firstContentMs = Date.now() - started;
      content += text;
      reasoningChars += reasoning.length;
    });
  }
  return { content, reasoningChars, firstDeltaMs, firstReasoningMs, firstContentMs, finishReason, usage, returnedModel: model, latencyMs: Date.now() - started, effort, maxTokens };
}

await mkdir(out, { recursive: true });
const tasks = requests.flatMap((request) => efforts.flatMap((effort) => caps.map((maxTokens) => ({ ...request, effort, maxTokens }))));
// Deterministic shuffled scheduling avoids always running one effort during one time window.
tasks.sort((a, b) => createHash('sha256').update(`${replicate}:${a.scene.id}:${a.effort}:${a.maxTokens}`).digest('hex').localeCompare(createHash('sha256').update(`${replicate}:${b.scene.id}:${b.effort}:${b.maxTokens}`).digest('hex')));
const manifest = { date: new Date().toISOString(), model: config.llm.model, endpoint: config.llm.baseUrl, temperature: config.llm.temperature, jsonMode: config.llm.jsonMode, efforts, caps, rounds, replicate, concurrency, dry, cache, timeoutMs, requests, notes: 'Cold mode prepends a unique experiment ID before the system prompt for EACH call; verify returned cache usage, do not assume a miss. Natural mode keeps the production prefix. Only the nonsemantic experiment ID varies in cold prompts. First-round screening is separate from production-style feedback retries. Diagrams are schematics, not live game renders.' };
const manifestPath = path.join(out, 'manifest.json');
const previous = await readFile(manifestPath, 'utf8').then((s) => JSON.parse(s) as typeof manifest, () => null);
if (previous && !isDeepStrictEqual({ ...previous, timeoutMs: previous.timeoutMs ?? 240000, date: null, dry: null }, { ...manifest, date: null, dry: null })) throw new Error('Output directory belongs to a different experiment; choose a new --out');
if (!previous || previous.dry && !dry) await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ model: config.llm.model, samples: tasks.length, maxRounds: rounds, concurrency, out, dry }));
if (!dry) await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const task = tasks.shift();
    if (!task) return;
    const id = `${task.scene.id}-${task.effort}-${task.maxTokens}-r${replicate}`;
    const file = path.join(out, `${id}.json`);
    const saved = await readFile(file, 'utf8').then((text) => JSON.parse(text) as { error?: string }, () => null);
    if (saved && !(saved.error && process.argv.includes('--retry-errors'))) { console.log(`skip ${id}`); continue; }
    const messages = structuredClone(task.messages);
    const attempts: { response: Awaited<ReturnType<typeof complete>>; evaluation: ReturnType<typeof evaluate> }[] = [];
    const started = Date.now();
    let best = -1, quick = false;
    try {
      for (let round = 0; round < rounds; round++) {
        const sent = structuredClone(messages);
        if (cache === 'cold') sent[0].content = `${randomUUID()} (experiment ID; not part of the design brief)\n${sent[0].content}`;
        const response = { ...await complete(sent, quick ? 'off' : task.effort, quick ? Math.max(1024, task.maxTokens / 2) : task.maxTokens), requestMessages: sent };
        const evaluation = evaluate(response.content, task.req, task.scene);
        attempts.push({ response, evaluation });
        const prior = attempts[best]?.evaluation;
        if (evaluation.compiled && (!prior?.compiled || evaluation.blocking!.length * 100 + evaluation.issues!.length < prior.blocking!.length * 100 + prior.issues!.length)) best = round;
        if (response.finishReason === 'length' && !response.content.trim()) quick = true;
        console.log(JSON.stringify({ id, round: round + 1, ms: response.latencyMs, finish: response.finishReason, compiled: evaluation.compiled, issues: evaluation.issues?.length, error: evaluation.error, usage: response.usage }));
        if (evaluation.compiled && !evaluation.issues!.length) break;
        messages.push({ role: 'assistant', content: response.content.slice(0, 4000) }, { role: 'user', content: evaluation.compiled
          ? `自查发现：\n- ${evaluation.issues!.join('\n- ')}\n保留你满意的部分，改进这些问题后重新输出完整的 JSON（如果你觉得某条不适合这座建筑，可以在 notes 里说明理由并保持原样）。`
          : `这张图纸没法施工：${evaluation.error}。请改正后重新输出完整的 JSON。` });
      }
      const selected = attempts[best < 0 ? attempts.length - 1 : best];
      await writeFile(file, JSON.stringify({ id, scenario: task.scene.id, effort: task.effort, maxTokens: task.maxTokens, replicate, promptHash: task.promptHash, rounds, selectedRound: best < 0 ? null : best + 1, totalLatencyMs: Date.now() - started, content: selected.response.content, evaluation: selected.evaluation, attempts }, null, 2));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(config.llm.apiKey, '[redacted]');
      await writeFile(file, JSON.stringify({ id, scenario: task.scene.id, effort: task.effort, maxTokens: task.maxTokens, replicate, promptHash: task.promptHash, rounds, totalLatencyMs: Date.now() - started, error: message, attempts }, null, 2));
      console.log(JSON.stringify({ id, error: message }));
    }
  }
}));
