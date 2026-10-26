import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activeAgent, agentIdAt, bankIdFor, listAgents, newAgent, saveActive, switchAgent, type AgentPaths, type BankOps } from '../src/maintenance/agents.ts';
import { memorySettings } from '../src/memory/settings.ts';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curio-agents-')));
  const w = path.join(root, 'world');
  fs.mkdirSync(path.join(w, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(w, 'world', 'level.dat'), 'A');
  fs.mkdirSync(path.join(w, 'mods'));
  fs.writeFileSync(path.join(w, 'mods', 'm.jar'), 'mod');
  fs.mkdirSync(path.join(w, 'recordings'));
  fs.writeFileSync(path.join(w, 'recordings', 'r.mp4'), 'big');
  fs.writeFileSync(path.join(w, 'server.properties'), 'level-name=world\nlevel-seed=123\nserver-port=25565\n');
  fs.writeFileSync(path.join(w, 'eula.txt'), 'eula=true\n');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'skills', 'dig'), { recursive: true });
  fs.writeFileSync(path.join(data, 'mind.json'), '{"who":"A"}');
  fs.writeFileSync(path.join(data, 'run-stats.json'), JSON.stringify({ startedAt: new Date(2026, 9, 26, 1, 17, 0).getTime(), uptimeSec: 3600 }));
  const paths: AgentPaths = { projectDir: root, dataDir: data, serverDir: w, agentsDir: path.join(root, 'agents') };
  return { root, paths };
}

function fakeBank() {
  const banks = new Map<string, string>();
  const calls: string[] = [];
  const ops: BankOps = {
    async exists(id) { return banks.has(id); },
    async exportTo(id, file) { calls.push(`export:${id}`); fs.writeFileSync(file, banks.get(id) ?? ''); return (banks.get(id) ?? '').length; },
    async importFrom(file, id) { calls.push(`import:${id}`); banks.set(id, fs.readFileSync(file, 'utf8')); },
  };
  return { banks, calls, ops };
}

const ident = { worldId: '127.0.0.1:25565', botUsername: 'Deepseek', legacyBankId: 'mc-' + 'a'.repeat(32) };

test('角色档案：收编旧角色、存档、新建全新角色、切回去，记忆/技能/世界/Hindsight 都跟着走', async () => {
  const { paths } = project();
  const { banks, calls, ops } = fakeBank();
  banks.set(ident.legacyBankId, 'memories of A');
  const saved = await saveActive(paths, ident, { bank: ops });
  assert.equal(saved.id, '20261026-011700', '按这次测试开始的日期-时间命名');
  assert.equal(saved.bankId, ident.legacyBankId, '收编的旧角色沿用原来的 bank');
  assert.ok(fs.existsSync(path.join(paths.agentsDir, saved.id, 'data', 'mind.json')));
  assert.ok(fs.existsSync(path.join(paths.agentsDir, saved.id, 'world', 'world', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(paths.agentsDir, saved.id, 'world', 'recordings')), '存档默认不复制录像');
  assert.ok(fs.existsSync(path.join(paths.dataDir, 'mind.json')), 'save 只复制，不搬走');

  const { from, to } = await newAgent(paths, ident, { label: '测试B', bank: ops, now: new Date(2026, 9, 26, 13, 45, 0).getTime() });
  assert.equal(from.id, saved.id);
  assert.equal(to.id, '20261026-134500');
  assert.equal(to.bankId, bankIdFor(ident.worldId, ident.botUsername, to.id));
  assert.deepEqual(fs.readdirSync(paths.dataDir), ['agent.json'], '新角色的 data 是空的');
  assert.ok(!fs.existsSync(path.join(paths.serverDir, 'world')), '旧世界搬走了，服务器下次生成新世界');
  assert.ok(fs.existsSync(path.join(paths.serverDir, 'mods', 'm.jar')), 'mods 和配置留着');
  assert.ok(!/level-seed/.test(fs.readFileSync(path.join(paths.serverDir, 'server.properties'), 'utf8')), '种子清掉，随机新世界');
  assert.ok(fs.existsSync(path.join(paths.agentsDir, from.id, 'world', 'recordings', 'r.mp4')), '收起时录像也一起搬走');
  assert.ok(fs.existsSync(path.join(paths.agentsDir, from.id, 'hindsight', 'bank.zip')));

  // 新角色玩了一会儿
  fs.writeFileSync(path.join(paths.dataDir, 'mind.json'), '{"who":"B"}');
  fs.mkdirSync(path.join(paths.serverDir, 'world'));
  fs.writeFileSync(path.join(paths.serverDir, 'world', 'level.dat'), 'B');
  banks.set(to.bankId, 'memories of B');

  // Hindsight 的库丢了：切回 A 时从导出的 zip 恢复
  banks.delete(ident.legacyBankId);
  await switchAgent(paths, '20261026-0117', ident, { bank: ops });
  assert.equal(activeAgent(paths)?.id, from.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'mind.json'), 'utf8')).who, 'A');
  assert.equal(fs.readFileSync(path.join(paths.serverDir, 'world', 'level.dat'), 'utf8'), 'A');
  assert.equal(banks.get(ident.legacyBankId), 'memories of A', 'Hindsight 记忆从档案恢复');
  assert.ok(calls.includes(`import:${ident.legacyBankId}`));
  // 再切到 B：它的 bank 还在，不用恢复
  await switchAgent(paths, '测试B', ident, { bank: ops });
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'mind.json'), 'utf8')).who, 'B');
  assert.equal(fs.readFileSync(path.join(paths.serverDir, 'world', 'level.dat'), 'utf8'), 'B');
  assert.ok(!calls.includes(`import:${to.bankId}`));
  const list = listAgents(paths);
  assert.deepEqual(list.map((a) => [a.id, a.active]), [[from.id, false], [to.id, true]]);
  await assert.rejects(switchAgent(paths, to.id, ident, { bank: ops }), /已经是当前角色/);
});

test('当前角色的 bank：记忆设置跟着 data/agent.json 走，换了世界或名字就不认', () => {
  const { paths } = project();
  fs.writeFileSync(path.join(paths.dataDir, 'agent.json'), JSON.stringify({ id: '20261026-134500', bankId: 'mc-' + 'b'.repeat(32), worldId: 'w1', botUsername: 'Bot' }));
  assert.equal(memorySettings({ DATA_DIR: paths.dataDir, MEMORY_WORLD_ID: 'w1', BOT_USERNAME: 'Bot' }).bankId, 'mc-' + 'b'.repeat(32));
  assert.notEqual(memorySettings({ DATA_DIR: paths.dataDir, MEMORY_WORLD_ID: 'w2', BOT_USERNAME: 'Bot' }).bankId, 'mc-' + 'b'.repeat(32));
  assert.match(agentIdAt(new Date(2026, 0, 2, 3, 4, 5)), /^20260102-030405$/);
});
