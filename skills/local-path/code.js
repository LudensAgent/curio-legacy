// 局部寻路：寻路器说没路、或者被脚边的方块卡住时，自己在身边一小块地形里找一条能走的路，一格一格迈过去。
// 目标：args.target（"x,y,z" 或 {x,y,z}）；恢复时用刚失败那一步的目标（args.failure.args.target / to）。
const parse = (t) => {
  if (!t) return null;
  if (typeof t === 'string') { const m = t.match(/(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/); return m ? { x: +m[1], y: +m[2], z: +m[3] } : null; }
  if (typeof t === 'object' && Number.isFinite(t.x) && Number.isFinite(t.z)) return { x: Math.floor(t.x), y: Math.floor(t.y ?? 0), z: Math.floor(t.z) };
  return null;
};
let goal = parse(args.target) ?? parse(args.failure?.args?.target) ?? parse(args.failure?.args?.to);
if (!goal) throw new Error('没有坐标目标：target 要写 "x,y,z"');
const me = await api.state();
const start = me.feet;
const R = 12;
// 目标太远就先朝它走一段（局部寻路只负责过眼前这一带）
const dx = goal.x - start.x, dz = goal.z - start.z, far = Math.hypot(dx, dz);
if (far > R) goal = { x: Math.round(start.x + dx / far * R), y: start.y, z: Math.round(start.z + dz / far * R) };
const reg = await api.region(start.x - R - 1, start.y - 4, start.z - R - 1, start.x + R + 1, start.y + 4, start.z + R + 1);
const [sx, sy, sz] = reg.size;
const kind = (x, y, z) => {
  const ix = x - reg.min.x, iy = y - reg.min.y, iz = z - reg.min.z;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= sx || iy >= sy || iz >= sz) return 'unknown';
  return reg.kinds[reg.data[iy * sx * sz + iz * sx + ix]];
};
const stand = (x, y, z) => kind(x, y, z) === 'open' && kind(x, y + 1, z) === 'open' && kind(x, y - 1, z) === 'solid';
const key = (p) => `${p.x},${p.y},${p.z}`;
const h = (p) => Math.abs(p.x - goal.x) + Math.abs(p.z - goal.z) + Math.abs(p.y - goal.y) * 0.5;
const open = [{ ...start, g: 0, f: h(start) }];
const came = new Map([[key(start), null]]);
const cost = new Map([[key(start), 0]]);
let best = start, expanded = 0;
while (open.length && expanded < 6000) {
  open.sort((a, b) => a.f - b.f);
  const cur = open.shift();
  expanded++;
  if (h(cur) < h(best)) best = cur;
  if (Math.abs(cur.x - goal.x) + Math.abs(cur.z - goal.z) <= 1 && Math.abs(cur.y - goal.y) <= 1) { best = cur; break; }
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const oy of [0, 1, -1]) {
      const n = { x: cur.x + ox, y: cur.y + oy, z: cur.z + oz };
      if (!stand(n.x, n.y, n.z)) continue;
      if (oy === 1 && kind(cur.x, cur.y + 2, cur.z) !== 'open') continue; // 往上跳头顶要空
      if (oy === -1 && kind(n.x, n.y + 2, n.z) !== 'open') continue;      // 往下走，落点上方要空
      const g = cur.g + 1 + (oy === 1 ? 0.5 : 0);
      if (g >= (cost.get(key(n)) ?? Infinity)) continue;
      cost.set(key(n), g); came.set(key(n), cur);
      open.push({ ...n, g, f: g + h(n) });
      break; // 同一方向只取一个高度
    }
  }
}
const path = [];
for (let p = best; p && key(p) !== key(start); p = came.get(key(p))) path.unshift(p);
if (!path.length) throw new Error(`身边 ${R} 格内找不到能走的路（试了 ${expanded} 格）`);
api.log(`找到 ${path.length} 步的路，朝 ${goal.x},${goal.y},${goal.z}`);
for (const [i, p] of path.entries()) {
  const r = await api.stepTo(p.x, p.y, p.z);
  if (!r.ok) throw new Error(`第 ${i + 1} 步迈不过去：${r.summary}`);
  api.progress((i + 1) / path.length);
}
return { steps: path.length, reached: h(best) <= 2 };
