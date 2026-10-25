// 苦力怕在身边嘶嘶响（或贴到眼前）：背对它跑开几格，跑不开就往两侧试。
const me = await api.state();
const near = (await api.entities(10)).filter((e) => e.name === 'creeper').sort((a, b) => a.dist - b.dist)[0];
if (!near) return { skipped: '苦力怕不见了' };
// 正在跟它打（砍一下退一步）时只退几步；否则跑远一点
const dist = args.trigger?.doing === 'defend' ? 6 : 9;
const dx = me.pos.x - near.pos.x, dz = me.pos.z - near.pos.z, len = Math.hypot(dx, dz) || 1;
for (const ang of [0, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2]) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const rx = (dx * c - dz * s) / len, rz = (dx * s + dz * c) / len;
  const r = await api.moveTo(me.pos.x + rx * dist, me.pos.y, me.pos.z + rz * dist, 2);
  if (r.ok) return { moved: dist, angle: Math.round(ang * 180 / Math.PI) };
}
throw new Error('四个方向都跑不开');
