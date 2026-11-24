import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activeAgent, agentIdAt, bankIdFor, listAgents, loadActive, newAgent, saveActive, switchAgent, type AgentPaths, type BankOps } from '../src/maintenance/agents.ts';
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
    async remove(id) { calls.push(`remove:${id}`); banks.delete(id); },
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
  assert.ok(fs.existsSync(path.join(paths.agentsDir, saved.id, 'save', 'data', 'mind.json')));
  assert.ok(fs.existsSync(path.join(paths.agentsDir, saved.id, 'save', 'world', 'world', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(paths.agentsDir, saved.id, 'save', 'world', 'recordings')), '存档默认不复制录像');
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
  await switchAgent(paths, from.id, ident, { bank: ops });
  await loadActive(paths, { bank: ops });
  assert.equal(fs.readFileSync(path.join(paths.serverDir, 'server.properties'), 'utf8'), 'level-name=world\nlevel-seed=123\nserver-port=25565\n', 'new/switch 不覆盖快速存档');
  await switchAgent(paths, to.id, ident, { bank: ops });
  const list = listAgents(paths);
  assert.deepEqual(list.map((a) => [a.id, a.active]), [[from.id, false], [to.id, true]]);
  await assert.rejects(switchAgent(paths, to.id, ident, { bank: ops }), /已经是当前角色/);
});

test('快速存读档：世界、技能、配置与 Hindsight 一起回退，同一快照可以反复读取', async (t) => {
  const { root, paths } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { banks, calls, ops } = fakeBank();
  const env = path.join(root, '.env');
  const properties = path.join(paths.serverDir, 'server.properties');
  const originalProperties = fs.readFileSync(properties, 'utf8');
  fs.writeFileSync(env, 'BOT_USERNAME=Curio\n');
  fs.mkdirSync(path.join(paths.serverDir, 'config'));
  fs.writeFileSync(path.join(paths.serverDir, 'config', 'test.json'), 'saved config');
  banks.set(ident.legacyBankId, 'saved memories');
  const bankSettings = { baseUrl: 'http://saved-hindsight:8888', apiKey: 'test-key' };
  const saved = await saveActive(paths, ident, { bank: ops, bankSettings });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.agentsDir, saved.id, 'save', 'config', 'hindsight.json'), 'utf8')), bankSettings, '存下实际使用的记忆服务配置，不继承测试后的 .env');

  for (let round = 0; round < 2; round++) {
    fs.writeFileSync(path.join(paths.dataDir, 'mind.json'), '{"who":"test"}');
    fs.writeFileSync(path.join(paths.dataDir, 'skills', 'dig', 'test.ts'), 'new skill');
    fs.writeFileSync(path.join(paths.serverDir, 'world', 'level.dat'), 'test world');
    fs.mkdirSync(path.join(paths.serverDir, 'test-world'));
    fs.writeFileSync(env, 'BOT_USERNAME=Test\n');
    fs.writeFileSync(properties, 'level-name=test-world\nserver-port=25565\n');
    fs.writeFileSync(path.join(paths.serverDir, 'config', 'test.json'), 'test config');
    fs.mkdirSync(path.join(paths.serverDir, 'configs'));
    banks.set(saved.bankId, 'test memories');
    await loadActive(paths, { bank: ops });
    assert.equal(fs.readFileSync(path.join(paths.dataDir, 'mind.json'), 'utf8'), '{"who":"A"}');
    assert.ok(!fs.existsSync(path.join(paths.dataDir, 'skills', 'dig', 'test.ts')));
    assert.equal(fs.readFileSync(path.join(paths.serverDir, 'world', 'level.dat'), 'utf8'), 'A');
    assert.ok(!fs.existsSync(path.join(paths.serverDir, 'test-world')));
    assert.equal(fs.readFileSync(env, 'utf8'), 'BOT_USERNAME=Curio\n');
    assert.equal(fs.readFileSync(properties, 'utf8'), originalProperties);
    assert.equal(fs.readFileSync(path.join(paths.serverDir, 'config', 'test.json'), 'utf8'), 'saved config');
    assert.ok(!fs.existsSync(path.join(paths.serverDir, 'configs')));
    assert.equal(banks.get(saved.bankId), 'saved memories');
    assert.ok(fs.existsSync(path.join(paths.serverDir, 'recordings', 'r.mp4')), '未存档的录像保留');
  }
  assert.deepEqual(calls, [`export:${saved.bankId}`, `remove:${saved.bankId}`, `import:${saved.bankId}`, `remove:${saved.bankId}`, `import:${saved.bankId}`]);

  banks.delete(saved.bankId);
  fs.rmSync(env);
  await saveActive(paths, ident, { bank: ops });
  banks.set(saved.bankId, 'new memories');
  fs.writeFileSync(env, 'BOT_USERNAME=Test\n');
  await loadActive(paths, { bank: ops });
  assert.ok(!banks.has(saved.bankId), '快照时没有 bank，也要清掉测试后产生的记忆');
  assert.ok(!fs.existsSync(env), '快照时没有 .env，恢复后也没有');
  assert.ok(fs.existsSync(path.join(paths.agentsDir, saved.id, '.previous', 'save', 'hindsight', 'bank.zip')));
  const oldArchive = path.join(paths.agentsDir, saved.id, 'hindsight', 'bank.zip');
  fs.mkdirSync(path.dirname(oldArchive), { recursive: true });
  fs.writeFileSync(oldArchive, 'old test memories');
  await newAgent(paths, ident, { bank: ops, now: new Date(2026, 9, 26, 13, 45, 0).getTime() });
  await switchAgent(paths, saved.id, ident, { bank: ops });
  assert.ok(!banks.has(saved.bankId), '空记忆读档后再切换，也不能从旧归档复活测试记忆');
});

test('没有快速存档时拒绝读档；本地记忆读档不需要 Hindsight', async (t) => {
  const { root, paths } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(loadActive(paths), /先快速存档/);
  await saveActive(paths, ident);
  fs.writeFileSync(path.join(paths.dataDir, 'mind.json'), 'changed');
  await loadActive(paths);
  assert.equal(fs.readFileSync(path.join(paths.dataDir, 'mind.json'), 'utf8'), '{"who":"A"}');
});

test('选定配置的快速存读档只恢复该文件，保留其它环境与默认配置', async (t) => {
  const { root, paths } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, '.env.local');
  const other = path.join(root, '.env.test');
  const fallback = path.join(root, '.env');
  fs.writeFileSync(local, 'CURIO_MODE=local\nMEMORY_WORLD_ID=test\n');
  fs.writeFileSync(other, 'CURIO_MODE=test\nMEMORY_WORLD_ID=other\n');
  fs.writeFileSync(fallback, 'legacy=true\n');
  const selected = { ...paths, envFile: local };
  await saveActive(selected, ident);
  fs.writeFileSync(local, 'CURIO_MODE=local\nMEMORY_WORLD_ID=changed\n');
  await assert.rejects(loadActive({ ...paths, envFile: other }), /配置文件与快速存档不同/);
  await loadActive(selected);
  assert.equal(fs.readFileSync(local, 'utf8'), 'CURIO_MODE=local\nMEMORY_WORLD_ID=test\n');
  assert.equal(fs.readFileSync(other, 'utf8'), 'CURIO_MODE=test\nMEMORY_WORLD_ID=other\n');
  assert.equal(fs.readFileSync(fallback, 'utf8'), 'legacy=true\n');
});

test('当前角色的 bank：记忆设置跟着 data/agent.json 走，换了世界或名字就不认', () => {
  const { paths } = project();
  fs.writeFileSync(path.join(paths.dataDir, 'agent.json'), JSON.stringify({ id: '20261026-134500', bankId: 'mc-' + 'b'.repeat(32), worldId: 'w1', botUsername: 'Bot' }));
  assert.equal(memorySettings({ DATA_DIR: paths.dataDir, MEMORY_WORLD_ID: 'w1', BOT_USERNAME: 'Bot' }).bankId, 'mc-' + 'b'.repeat(32));
  assert.notEqual(memorySettings({ DATA_DIR: paths.dataDir, MEMORY_WORLD_ID: 'w2', BOT_USERNAME: 'Bot' }).bankId, 'mc-' + 'b'.repeat(32));
  assert.match(agentIdAt(new Date(2026, 0, 2, 3, 4, 5)), /^20260102-030405$/);
});
