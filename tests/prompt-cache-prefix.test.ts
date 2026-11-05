import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem } from '../src/mind/prompt.ts';

// 服务端按前缀缓存：两级思考交替时，共用前缀必须逐字相同，档位专属内容只能放在后面。
test('瞥一眼和认真想共用同一段静态系统前缀', () => {
  const skills = ['mining-runs：［文字］按露头下矿'];
  const deliberate = deliberateSystem('你叫 Curio。', skills);
  const glance = glanceSystem('你叫 Curio。', skills);
  let i = 0;
  while (i < Math.min(deliberate.length, glance.length) && deliberate[i] === glance[i]) i++;
  const shared = deliberate.slice(0, i);
  // 共用前缀覆盖身份、操作者、读法、原则、决定、输出和整份动作目录
  for (const marker of ['你就是这个 Minecraft 角色本人', '【操作者】', '【消息怎么读】', '【原则】', '【选动作】', '【决定】', '【输出】', '【动作】参数必须合法：', '- dig_at ']) {
    assert.ok(shared.includes(marker), `共用前缀缺少「${marker}」`);
  }
  // 档位从同一处分叉，各自的尾段不打断前面的缓存
  assert.ok(deliberate.slice(i).trimStart().startsWith('【每次这样想】'));
  assert.ok(glance.slice(i).trimStart().startsWith('这次只是抬头看一眼'));
  // 变动最勤的技能书索引留在各自最后
  assert.ok(deliberate.trimEnd().endsWith('- mining-runs：［文字］按露头下矿'));
  assert.ok(glance.trimEnd().endsWith('- mining-runs：［文字］'));
});
