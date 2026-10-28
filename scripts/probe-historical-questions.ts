/** Compare exactly ten historical questions, with and without the configured Java edition/version. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config.ts';
import { OpenAICompatibleProvider, type ChatMessage } from '../src/planner/llm.ts';
import { describeNetworkError } from '../src/network-error.ts';

const fixtureText = fs.readFileSync(new URL('./fixtures/knowledge-inquiry-history.json', import.meta.url), 'utf8');
const scenarios = JSON.parse(fixtureText) as { id: string; question: string }[];
if (scenarios.length !== 10 || new Set(scenarios.map(({ id }) => id)).size !== 10)
  throw new Error('This comparison requires exactly ten unique historical cases');
const system = `你在为游戏Agent解答问题。只输出一个JSON对象：{"answer":"简短回答","conditions":["关键条件或例外"],"cannot_determine":["根据输入无法确认的事"]}。区分Minecraft规则、自定义Agent接口、当前世界事实和个人记忆。没有提供接口文档、现场状态或经历时，不要编造它们；不知道的明确说明。不要声称已经联网、查过Wiki或观察过游戏。回答控制在250个汉字左右，围绕问题，不扩写完整攻略。`;
const arms = ['original', 'versioned'];
const jobs = scenarios.flatMap((scenario, index) => arms.map((_, offset) => ({ scenario, arm: arms[(index + offset) % arms.length] })));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('archives/knowledge-inquiry-history', runId);
const budget = { groups: 10, calls: 20, concurrency: 3, maxTokensPerCall: 4096, timeoutMs: 60_000 };
console.log(JSON.stringify({ runId, model: config.llm.model, effort: 'low', budget, execute: process.argv.includes('--run') }));

if (process.argv.includes('--run')) {
  if (config.llm.provider !== 'openai' || !/deepseek/i.test(`${config.llm.model} ${config.llm.baseUrl}`) || !config.llm.apiKey)
    throw new Error('A configured DeepSeek API connection is required');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'experiment.json'), JSON.stringify({ runId, model: config.llm.model,
    edition: 'java', version: config.mc.version, effort: 'low', budget, system,
    fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'), scenarios: JSON.parse(fixtureText) }, null, 2));
  const provider = new OpenAICompatibleProvider({ ...config.llm, stream: false, maxTokens: budget.maxTokensPerCall,
    timeoutMs: budget.timeoutMs, lightThinking: 'on', reasoningEffort: 'low' });
  let cursor = 0;
  await Promise.all(Array.from({ length: budget.concurrency }, async () => {
    while (cursor < jobs.length) {
      const { scenario, arm } = jobs[cursor++];
      const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user',
        content: `${arm === 'versioned' ? `游戏：Minecraft Java Edition ${config.mc.version}。\n` : ''}${scenario.question}` }];
      fs.appendFileSync(path.join(directory, 'requests.jsonl'), JSON.stringify({ caseId: scenario.id, arm, messages }) + '\n');
      await provider.complete(messages, AbortSignal.timeout(budget.timeoutMs), { tier: 'full', reasoningEffort: 'low' })
        .then((completion) => {
          fs.appendFileSync(path.join(directory, 'results.jsonl'), JSON.stringify({ caseId: scenario.id, arm, ...completion }) + '\n');
          console.log(JSON.stringify({ caseId: scenario.id, arm, latencyMs: completion.latencyMs,
            finishReason: completion.finishReason, usage: completion.usage }));
        }, (error: unknown) => {
          const result = { caseId: scenario.id, arm, error: describeNetworkError(error, [config.llm.apiKey]) };
          fs.appendFileSync(path.join(directory, 'results.jsonl'), JSON.stringify(result) + '\n');
          console.log(JSON.stringify(result));
          process.exitCode = 1;
        });
    }
  }));
  console.log(JSON.stringify({ saved: directory }));
}
