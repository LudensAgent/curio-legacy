// 血少又在挨打：近战的怪就原地垫高三格（僵尸够不着），会射箭/会爬墙的怪或者没方块就背对怪群跑开。
const me = await api.state();
const foes = (await api.entities(16)).filter((e) => e.kind === 'hostile' && e.name !== 'creeper');
if (!foes.length) return { skipped: '没有怪了' };
const blocks = me.inventory.filter((i) => /(dirt|cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|_planks|sand|gravel)$/.test(i.name)).reduce((n, i) => n + i.count, 0);
const ranged = foes.some((f) => /skeleton|stray|bogged|pillager|witch|blaze/.test(f.name));
const climber = foes.some((f) => /spider/.test(f.name));
if (!ranged && !climber && blocks >= 3 && me.onGround) {
  let up = 0;
  for (let i = 0; i < 3; i++) {
    const s = await api.state();
    const head = await api.blockAt(s.feet.x, s.feet.y + 2, s.feet.z);
    if (head.kind !== 'open') break;
    const r = await api.placeAt(s.feet.x, s.feet.y, s.feet.z, 'any');
    if (!r.ok) break;
    up++;
  }
  if (up >= 2) return { pillared: up };
}
const cx = foes.reduce((a, f) => a + f.pos.x, 0) / foes.length, cz = foes.reduce((a, f) => a + f.pos.z, 0) / foes.length;
const dx = me.pos.x - cx, dz = me.pos.z - cz, len = Math.hypot(dx, dz) || 1;
for (const ang of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const r = await api.moveTo(me.pos.x + (dx * c - dz * s) / len * 14, me.pos.y, me.pos.z + (dx * s + dz * c) / len * 14, 3);
  if (r.ok) return { fled: 14, angle: Math.round(ang * 180 / Math.PI) };
}
throw new Error('垫不高也跑不开');
