/**
 * 单独验证 RCON 与旁观：连接服务器 RCON，执行 list，并尝试让 OBSERVER_PLAYER 旁观 BOT_USERNAME。
 * 用法：npm run check:rcon
 */
import { config } from '../src/config.ts';
import { Rcon } from '../src/observer/rcon.ts';

const o = config.observer;
if (!o.rconPassword) {
  console.error('❌ 未设置 RCON_PASSWORD');
  process.exit(1);
}
const rcon = new Rcon(o.rconHost, o.rconPort, o.rconPassword);
try {
  console.log(`连接 RCON ${o.rconHost}:${o.rconPort} …`);
  console.log('list →', await rcon.send('list'));
  if (o.player) {
    console.log(`gamemode → ${await rcon.send(`gamemode spectator ${o.player}`)}`);
    console.log(`spectate → ${await rcon.send(`spectate ${config.mc.username} ${o.player}`)}`);
    console.log('（如果提示找不到玩家，确认你的客户端和 Bot 都已进入服务器）');
  } else {
    console.log('未设置 OBSERVER_PLAYER，跳过旁观测试');
  }
  console.log('✅ RCON 正常');
} catch (e: any) {
  console.error('❌ RCON 失败：', e?.message ?? e);
  process.exitCode = 1;
} finally {
  rcon.close();
}
