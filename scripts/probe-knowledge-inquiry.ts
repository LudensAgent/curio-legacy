/** Opt-in, bounded DeepSeek comparison. Dry run by default; --run sends synthetic game states to the configured API. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { deliberateSystem, glanceSystem } from '../src/mind/prompt.ts';
import { OpenAICompatibleProvider, type ChatMessage } from '../src/planner/llm.ts';
import { extractJson } from '../src/planner/plan.ts';
import { describeNetworkError } from '../src/network-error.ts';

const cases = [
  { id: 'known-food', goal: '准备远行', body: { dim: 'overworld', hp: 20, food: 8 },
    inventory: [{ name: 'cooked_beef', count: 5 }], surroundings: '白天，脚下平整，周围没有威胁。',
    lastResult: '已在这个世界吃过熟牛肉，饥饿条增加；上一段活动刚结束。' },
  { id: 'cleric-offers', goal: '取得末影珍珠', body: { dim: 'overworld', hp: 20, food: 20 },
    inventory: [{ name: 'emerald', count: 20 }], surroundings: '已查看一位专家级牧师的完整交易列表：新增项收海龟鳞甲、收玻璃瓶，没有末影珍珠。',
    lastResult: '工作站已认领且能接近，第二天已经补货，商品种类未变化。',
    priorThought: '等这位牧师补货后再买珍珠。' },
  { id: 'dragon-arrows', goal: '击败末影龙', body: { dim: 'the_end', hp: 20, food: 20 },
    inventory: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 28 }, { name: 'iron_sword', count: 1 }],
    surroundings: '主岛中央，龙在基岩结构上栖息；自己站在稳定地面，尚未看见脚边龙息。',
    lastResult: '两次箭接触龙后弹开，龙生命没有下降，箭已消耗。', priorThought: '用弓射龙直到它死。' },
  { id: 'unseen-fortress', goal: '取得烈焰棒', body: { dim: 'the_nether', hp: 20, food: 20 },
    inventory: [{ name: 'iron_sword', count: 1 }, { name: 'cooked_beef', count: 12 }, { name: 'cobblestone', count: 40 }],
    surroundings: '当前落脚处安全；视野里只有下界岩、远处熔岩和森林边缘，视野和记忆中都没有要塞或烈焰人。',
    lastResult: '穿过下界门；已经记下实际出口位置，没有其他已知地标。' },
  { id: 'open-progression', goal: '击败末影龙并存活返回', body: { dim: 'overworld', hp: 20, food: 20 },
    inventory: [{ name: 'iron_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'cooked_beef', count: 16 },
      { name: 'iron_ingot', count: 8 }, { name: 'oak_log', count: 12 }],
    surroundings: '穿着铁甲；已有有效的床和临时住所，尚未去过下界，没有珍珠、烈焰棒、黑曜石或已知熔岩源。',
    lastResult: '铁甲和补给准备活动已经完成，现在手上没有活动。' },
  { id: 'opaque-craft-failure', goal: '制作两颗末影之眼', body: { dim: 'overworld', hp: 20, food: 20 },
    inventory: [{ name: 'ender_pearl', count: 2 }, { name: 'blaze_powder', count: 2 }],
    surroundings: '上面的背包是操作前快照，失败后尚未读取背包或界面，周围没有威胁。',
    lastResult: 'craft ender_eye count=2 只返回 ERROR：操作失败，没有原因或当前界面内容。' },
];

const inquiryPrompt = `【关键前提】决定下一步前，把目标、已有依据与实际结果对照：这一步依赖的规则是否可能来自旧版本或未经验证的猜测？有没有结果与预期不符、会改变选择的关键缺口？有这种缺口时先把它变成一个具体问题，选择合适入口：游戏规则查 knowledge，配方缺口查 recipes，操作参数查 moves/mechanics，亲历查 recall，当前世界状态靠观察。问题围绕对象和要确认的条件，必要时带上版本；不要复制整段状态。已有充分依据时直接行动或做可逆试验，不必每轮查询，也不要求硬凑问题。`;
const groundedPrompt = `【决定之前的依据检查】先检查下一步所依赖的一项关键规则：有什么证据说明它在当前版本成立？依据只能来自本轮观察、提供的已验证经历、已经读到的本版资料；模型自己的记忆只是候选解释，不能冒充这些依据。新目标选路、预期被实际结果推翻、或准备不可回收的资源投入时，若影响选择的关键规则尚无上述依据，就先用查询核实这一个缺口，再决定；查询直接输出顶层 kind JSON，不要把“查资料”写成动作或只说在独白里。游戏规则查 knowledge，配方查 recipes，操作接口查 moves/mechanics；现场库存、结构坐标与失败现场要观察，Wiki不能证明。已有依据支持且结果正常时直接行动。若决定行动，附 evidence_check:{"premise":"一句关键前提","basis":"observation|verified_experience|reference|model_memory","gap":null或"一个影响选择的缺口"}，简短填写，不写推理过程，不强行凑问题。`;
const arms = process.argv.includes('--grounded-only') ? ['grounded'] : ['current', 'version', 'inquiry'];
const effort = process.argv.find((arg) => arg.startsWith('--effort='))?.slice(9) ?? 'low';
const tier = process.argv.includes('--glance') ? 'light' : 'full';
if (!['low', 'high', 'off'].includes(effort)) throw new Error('--effort must be low, high or off');
const selected = process.argv.find((arg) => arg.startsWith('--cases='))?.slice(8).split(',');
if (selected?.some((id) => !cases.some((scenario) => scenario.id === id))) throw new Error('Unknown case ID');
const scenarios = cases.filter((scenario) => !selected || selected.includes(scenario.id));
const system = tier === 'light' ? glanceSystem(config.persona) : deliberateSystem(config.persona);
const jobs = scenarios.flatMap((scenario, index) => arms.map((_, offset) => ({ scenario, arm: arms[(index + offset) % arms.length] })));
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${tier}-${effort}`;
const directory = path.resolve('archives/knowledge-inquiry', runId);
const budget = { calls: jobs.length, concurrency: 3, maxTokensPerCall: 4096, timeoutMs: 60_000 };
console.log(JSON.stringify({ runId, model: config.llm.model, tier, effort, budget, cases: scenarios.map(({ id }) => id), execute: process.argv.includes('--run') }));

if (process.argv.includes('--run')) {
  if (config.llm.provider !== 'openai' || !/deepseek/i.test(`${config.llm.model} ${config.llm.baseUrl}`) || !config.llm.apiKey)
    throw new Error('A configured DeepSeek API connection is required');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'experiment.json'), JSON.stringify({ runId, model: config.llm.model, tier, effort, budget, system, inquiryPrompt, groundedPrompt, cases: scenarios }, null, 2));
  const provider = new OpenAICompatibleProvider({ ...config.llm, stream: false, maxTokens: budget.maxTokensPerCall,
    timeoutMs: budget.timeoutMs, lightThinking: effort === 'off' || tier === 'light' ? 'off' : 'on', reasoningEffort: effort === 'off' ? 'off' : effort });
  let cursor = 0;
  await Promise.all(Array.from({ length: budget.concurrency }, async () => {
    while (cursor < jobs.length) {
      const { scenario, arm } = jobs[cursor++];
      const messages: ChatMessage[] = [{ role: 'system', content: system + (arm === 'inquiry' ? `\n\n${inquiryPrompt}` : arm === 'grounded' ? `\n\n${groundedPrompt}` : '') },
        { role: 'user', content: `${arm === 'current' ? '' : `【游戏】${JSON.stringify({ edition: 'java', version: config.mc.version })}\n`}【专注】${JSON.stringify({ goal: scenario.goal })}\n【身体】${JSON.stringify({ ...scenario.body, inventory: scenario.inventory })}\n【身边】${scenario.surroundings}\n【最近】${scenario.lastResult}${'priorThought' in scenario ? `\n【刚才的念头】${scenario.priorThought}` : ''}\n【手上的活】无\n\n现在你在想什么、打算怎么做？只输出一个 JSON 对象。` }];
      fs.appendFileSync(path.join(directory, 'requests.jsonl'), JSON.stringify({ caseId: scenario.id, arm, messages }) + '\n');
      await provider.complete(messages, AbortSignal.timeout(budget.timeoutMs), { tier: effort === 'off' ? 'light' : tier, reasoningEffort: effort === 'off' ? undefined : effort })
        .then((completion) => {
          const result = { caseId: scenario.id, arm, ...completion };
          fs.appendFileSync(path.join(directory, 'results.jsonl'), JSON.stringify(result) + '\n');
          const parsed = extractJson(completion.text);
          const answer = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
          console.log(JSON.stringify({ caseId: scenario.id, arm, latencyMs: completion.latencyMs, finishReason: completion.finishReason,
            kind: answer.kind ?? answer.decision, query: answer.query, monologue: answer.monologue, activity: answer.activity, usage: completion.usage }));
        }, (error: unknown) => {
          const result = { caseId: scenario.id, arm, error: describeNetworkError(error, [config.llm.apiKey]) };
          fs.appendFileSync(path.join(directory, 'results.jsonl'), JSON.stringify(result) + '\n');
          console.log(JSON.stringify(result));
        });
    }
  }));
  console.log(JSON.stringify({ saved: directory }));
}
