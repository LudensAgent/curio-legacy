// 给依赖打的小补丁（npm install 之后自动跑，可以重复跑）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patch(rel, mark, anchor, replacement, done, missing) {
  const file = path.join(root, 'node_modules', rel);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(mark)) { console.log(`${rel} 已打过补丁`); return; }
  if (!src.includes(anchor)) { console.warn(`${rel} 的代码变了，补丁没打上（${missing}）`); return; }
  src = src.replace(anchor, replacement);
  fs.writeFileSync(file, src);
  console.log(done);
}

// mineflayer-pathfinder 2.4.x：路上要开门时（useOne），开完门 toPlace 已经空了，placingBlock 变成 undefined，
// placing 却还是 true；之后每个物理刻都读 placingBlock.y 抛错（日志里一次几十条 "reading 'y'"），寻路卡在原地。
{
  const mark = '/* curio-patch: placingBlock guard */';
  const anchor = `      const block = stateMovements.getScaffoldingItem()`;
  patch('mineflayer-pathfinder/index.js', mark, anchor, `      ${mark}\n      if (!placingBlock) { placing = false; return }\n${anchor}`,
    'mineflayer-pathfinder 补丁已打上：placingBlock 为空时不再每刻抛错', '检查 placingBlock 的用法');
}

// mineflayer 物理：主线程卡住 N 秒后，积压的时间不会丢掉，之后每 50ms 补跑 4 个物理刻、只消化掉 3 刻的积压，
// 于是卡 10 秒之后身体会用 4 倍速跑上好几秒（水面上看着像“水上漂”，上岸、转弯都冲过头）。
// 真人卡顿了就是卡顿了，不会事后快进：补跑到上限时把剩下的积压扔掉。
{
  const mark = '/* curio-patch: drop physics backlog */';
  const anchor = `      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break`;
  patch('mineflayer/lib/plugins/physics.js', mark, anchor, `      ${mark}\n      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) { timeAccumulator = Math.min(timeAccumulator, PHYSICS_TIMESTEP); break }`,
    'mineflayer 物理补丁已打上：卡顿后不再快进补帧', '检查 doPhysics 的补帧循环');
}
