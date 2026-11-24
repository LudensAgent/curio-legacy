import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyUpdates, isSecretKey, parseEnv, parseSchema, validateUpdates } from '../src/observer/env-config.ts';

const EXAMPLE = `# ===== Minecraft 服务器 =====
MC_HOST=127.0.0.1
MC_PORT=25565
# Bot 的游戏名（离线模式）
BOT_USERNAME=Curio

# ===== LLM =====
LLM_API_KEY=
# 后台写代码的模型
# CODER_LLM_MODEL=deepseek-reasoner
# CODER_LLM_BASE_URL=          # 不填沿用 LLM_BASE_URL
# 水平/垂直视野角度
VISION_FOV=100
VISION_VFOV=60

# ---- 记忆服务（可选）----
HINDSIGHT_API_KEY=
`;

test('从 .env.example 解析分组、说明、可选项和密钥', () => {
  const s = parseSchema(EXAMPLE);
  assert.deepEqual(s.map((x) => x.title), ['Minecraft 服务器', 'LLM', '记忆服务（可选）']);
  const items = Object.fromEntries(s.flatMap((x) => x.items).map((i) => [i.key, i]));
  assert.equal(items.BOT_USERNAME.desc, 'Bot 的游戏名（离线模式）');
  assert.equal(items.CODER_LLM_MODEL.optional, true);
  assert.equal(items.CODER_LLM_MODEL.example, 'deepseek-reasoner');
  assert.equal(items.CODER_LLM_BASE_URL.example, null);
  assert.match(items.CODER_LLM_BASE_URL.desc, /不填沿用/);
  assert.equal(items.VISION_FOV.desc, '水平/垂直视野角度');
  assert.equal(items.VISION_VFOV.desc, '');
  assert.equal(items.LLM_API_KEY.secret, true);
  assert.equal(items.HINDSIGHT_API_KEY.secret, true);
  assert.equal(isSecretKey('MC_HOST'), false);
});

test('写回 .env：原地替换、启用注释行、追加新项、null 注释掉，其他行不动', () => {
  const env = '# 我的配置\r\nMC_HOST=10.0.0.2\r\n# CODER_LLM_MODEL=old\r\nLLM_API_KEY=sk-secret\r\n';
  const out = applyUpdates(env, { MC_HOST: '127.0.0.1', CODER_LLM_MODEL: 'deepseek-reasoner', VISION_FOV: '90', LLM_API_KEY: null });
  assert.equal(out, '# 我的配置\r\nMC_HOST=127.0.0.1\r\nCODER_LLM_MODEL=deepseek-reasoner\r\n# LLM_API_KEY=sk-secret\r\n\r\n# ---- 控制台添加的配置 ----\r\nVISION_FOV=90\r\n');
  const parsed = parseEnv(out);
  assert.equal(parsed.get('MC_HOST'), '127.0.0.1');
  assert.equal(parsed.has('LLM_API_KEY'), false);
});

test('含空格和井号的值会加引号，读回来一致', () => {
  const out = applyUpdates('', { AGENT_PERSONA: '你叫 Curio #1 号', X: ' padded ' });
  const env = parseEnv(out);
  assert.equal(env.get('AGENT_PERSONA'), '你叫 Curio #1 号');
  assert.equal(env.get('X'), ' padded ');
});

test('校验：只能改已知键、单行值', () => {
  const allowed = new Set(['MC_HOST', 'LLM_API_KEY']);
  assert.equal(validateUpdates({ set: { MC_HOST: 'a' } }, allowed).ok, true);
  assert.equal(validateUpdates({ set: { NODE_OPTIONS: '--require x' } }, allowed).ok, false);
  assert.equal(validateUpdates({ set: { MC_HOST: 'a\nNODE_OPTIONS=x' } }, allowed).ok, false);
  assert.equal(validateUpdates({ set: { 'mc host': 'a' } }, allowed).ok, false);
  assert.equal(validateUpdates({ set: {} }, allowed).ok, false);
  assert.equal(validateUpdates({}, allowed).ok, false);
});
