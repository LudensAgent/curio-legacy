// 一次性清理：删掉通道里过深的假入口（身体把地下误判成 surface 时记出的）。
// 只读 data/live、data/local 的 world-memory.json，改前备份，改后写回（保持 1 空格缩进）。
// 进程运行中不能改记忆文件（它会定时写回覆盖掉）：请先停掉 Curio 再 --apply，然后重启。
// 用法：
//   node scripts/clean-passage-entrances.mjs           预览，不写
//   node scripts/clean-passage-entrances.mjs --apply   写回
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVS = ['live', 'local'];
const GAP = 6; // 入口 y 比通道地表低超过这个格数算假入口

const apply = process.argv.includes('--apply');
let total = 0;

for (const env of ENVS) {
  const file = path.join(ROOT, 'data', env, 'world-memory.json');
  if (!fs.existsSync(file)) { console.log(`跳过（无文件）：${file}`); continue; }
  const original = fs.readFileSync(file, 'utf8');
  const m = JSON.parse(original);
  const passages = m.passages;
  if (!Array.isArray(passages) || !passages.length) { console.log(`跳过（无通道）：${file}`); continue; }
  let removed = 0;
  for (const rec of passages) {
    if (!Array.isArray(rec.entrances) || !rec.entrances.length) continue;
    const surfaceY = Array.isArray(rec.path) && rec.path.length ? Math.max(...rec.path.map((p) => p.y)) : Math.max(...rec.entrances.map((e) => e.y));
    const dropped = rec.entrances.filter((e) => surfaceY - e.y > GAP);
    if (dropped.length) {
      console.log(`  ${rec.id}: 删掉假入口 ${dropped.map((e) => `(${e.x},${e.y},${e.z})`).join(' ')}（通道地表 y≈${surfaceY}）`);
      removed += dropped.length;
      rec.entrances = rec.entrances.filter((e) => surfaceY - e.y <= GAP);
    }
  }
  total += removed;
  if (removed) {
    if (apply) {
      const backupDir = path.join(ROOT, 'data', env, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `world-memory.pre-passage-clean-${Date.now()}.json`);
      fs.writeFileSync(backup, original);
      fs.writeFileSync(file, JSON.stringify(m, null, 1));
      console.log(`已写回 ${file}（清理 ${removed} 个假入口），备份 ${backup}`);
    } else {
      console.log(`预览 ${file}：将清理 ${removed} 个假入口`);
    }
  } else {
    console.log(`${file}：没有假入口`);
  }
}
console.log(`\n共 ${total} 个假入口${apply ? '已清理' : '（预览，加 --apply 写回）'}`);
