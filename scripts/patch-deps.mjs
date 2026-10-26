// 给依赖打的小补丁（npm install 之后自动跑，可以重复跑）。
// mineflayer-pathfinder 2.4.x：路上要开门时（useOne），开完门 toPlace 已经空了，placingBlock 变成 undefined，
// placing 却还是 true；之后每个物理刻都读 placingBlock.y 抛错（日志里一次几十条 "reading 'y'"），寻路卡在原地。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'node_modules', 'mineflayer-pathfinder', 'index.js');
const MARK = '/* curio-patch: placingBlock guard */';
if (!fs.existsSync(file)) process.exit(0);
let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) { console.log('mineflayer-pathfinder 已打过补丁'); process.exit(0); }
const anchor = `      const block = stateMovements.getScaffoldingItem()`;
if (!src.includes(anchor)) { console.warn('mineflayer-pathfinder 的代码变了，补丁没打上（检查 placingBlock 的用法）'); process.exit(0); }
src = src.replace(anchor, `      ${MARK}\n      if (!placingBlock) { placing = false; return }\n${anchor}`);
fs.writeFileSync(file, src);
console.log('mineflayer-pathfinder 补丁已打上：placingBlock 为空时不再每刻抛错');
