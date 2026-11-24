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

// 清空主手只允许收纳，背包满或点击后仍有光标物品时不能隐式丢弃。
{
  const rel = 'mineflayer/lib/plugins/simple_inventory.js';
  patch(rel, '/* curio-patch: unequip never tosses held items */',
    `    if (!slot) {
      await bot.tossStack(bot.heldItem)
      return
    }`,
    `    if (slot === null) {
      /* curio-patch: unequip never tosses held items */
      throw new Error('INVENTORY_FULL: cannot empty hand without dropping the held item')
    }`,
    'mineflayer 满包清空主手时保留物品并报告失败', '检查 equipEmpty 的满包分支');
  patch(rel, '/* curio-patch: unequip preserves cursor items */',
    `    if (bot.inventory.selectedItem) {
      await bot.clickWindow(-999, 0, 0)
    }`,
    `    if (bot.inventory.selectedItem) {
      /* curio-patch: unequip preserves cursor items */
      throw new Error('UNEQUIP_NOT_CONFIRMED: item remains on the cursor; no item was dropped')
    }`,
    'mineflayer 清空主手失败时不丢弃光标物品', '检查 equipEmpty 的光标清理');
}

// 死亡只取消当前挖掘；通道记录等跨生命订阅仍需接收重生后的挖掘事件。
{
  const anchor = `      bot.removeAllListeners('diggingAborted')
      bot.removeAllListeners('diggingCompleted')`;
  patch('mineflayer/lib/plugins/digging.js', '/* curio-patch: keep digging observers on death */', anchor,
    '      /* curio-patch: keep digging observers on death */',
    'mineflayer 死亡后保留外部挖掘记录监听', '检查 death 的挖掘清理');
}

// 完成事件报告本次挖掉的原方块；newBlock 是挖完后的空气，会丢失矿种。
{
  patch('mineflayer/lib/plugins/digging.js', '/* curio-patch: report mined block */',
    `      bot.emit('diggingCompleted', newBlock)`,
    `      bot.emit('diggingCompleted', block) /* curio-patch: report mined block */`,
    'mineflayer 挖掘完成事件保留原方块类型和位置', '检查 onBlockUpdate 的完成事件');
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

// 潜行防坠必须检查脚下碰撞体是否真的相交；只统计相邻格里的形状会把够不到的玻璃板等误认为支撑。
{
  const rel = 'prismarine-physics/index.js';
  const anchor = `      // In the 3 loops bellow, y offset should be -1, but that doesnt reproduce vanilla behavior.`;
  const replacement = `      /* curio-patch: sneak support intersection */
      function hasSneakSupport (dx, dz) {
        const support = getPlayerBB(pos).offset(dx, 0, dz)
        support.minY = pos.y - physics.stepHeight
        support.maxY = pos.y
        return getSurroundingBBs(world, support).some(bb => bb.intersects(support))
      }`;
  patch(rel, '/* curio-patch: sneak support intersection */', anchor, replacement,
    'prismarine-physics 潜行支撑使用实际碰撞体', '检查潜行边缘保护');
  for (const [suffix, dx, dz] of [['offset(dx, 0, 0)', 'dx', '0'], ['offset(0, 0, dz)', '0', 'dz'], ['offset(dx, 0, dz)', 'dx', 'dz']]) {
    const original = `getSurroundingBBs(world, getPlayerBB(pos).${suffix}).length === 0`;
    patch(rel, `!hasSneakSupport(${dx}, ${dz})`, original, `!hasSneakSupport(${dx}, ${dz})`,
      'prismarine-physics 潜行方向碰撞检查已更新', '检查潜行方向循环');
  }
}

// mineflayer 背包：craft / transfer / deposit / toss / equip 内部调的是模块里的本地 clickWindow，不走 bot.clickWindow，
// 外面包不到；合成、整理箱子几十下点击在几十毫秒内全部发完，观察者界面几乎看不清。
// 在 clickWindow 入口留一个钩子：bot.beforeWindowClick 存在时每次点击前先等它（Agent 里按 UI_PACING_MS 停顿）。
{
  const mark = '/* curio-patch: window click hook */';
  const anchor = `  async function clickWindow (slot, mouseButton, mode) {\n`;
  patch('mineflayer/lib/plugins/inventory.js', mark, anchor, `${anchor}    ${mark}\n    if (typeof bot.beforeWindowClick === 'function') await bot.beforeWindowClick(slot, mouseButton, mode)\n`,
    'mineflayer 背包补丁已打上：每次界面点击前先过 bot.beforeWindowClick 钩子', '检查 clickWindow 的定义');
}
