/** Uses the independent review server and its existing inventory; no admin provisioning or LLM calls. */
import fs from 'node:fs';
import path from 'node:path';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { sleep } from '../src/util.ts';

const port = Number(process.env.AGENT_REVIEW_PORT ?? 25585);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid QA port');
const cfg = { ...config, mc: { ...config.mc, host: '127.0.0.1', port, username: 'CurioQA' },
  memory: { ...config.memory, provider: 'local' as const, worldId: `qa:${port}` }, viewerPort: 0 };
const bus = new EventBus(), adapter = new MineflayerAdapter(cfg, bus);
const controller = new AbortController();
try {
  adapter.connect();
  const readyBy = Date.now() + 30000;
  while (!adapter.state().observationReady && Date.now() < readyBy) await sleep(200);
  if (!adapter.state().observationReady) throw new Error('No ready QA observation');
  await sleep(500);
  const before = adapter.state();
  const result = await adapter.craft('wooden_pickaxe', 1, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
  const after = adapter.state();
  const directory = path.join(config.dataDir, 'reviews'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `craft-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ before, result, after, events: bus.recent() }, null, 2));
  console.log(JSON.stringify({ result, before: before.inventory, after: after.inventory, evidence: file }));
  if (!result.ok || after.inventory.filter((i) => i.name === 'wooden_pickaxe').reduce((sum, i) => sum + i.count, 0)
    <= before.inventory.filter((i) => i.name === 'wooden_pickaxe').reduce((sum, i) => sum + i.count, 0)) process.exitCode = 1;
} finally { controller.abort(); adapter.quit(); }
