// 被贴脸打了：有剑或斧、血还多、怪不多就还手；否则先拉开距离（交给脑子想怎么办）。
const me = await api.state();
const foes = (await api.entities(8)).filter((e) => e.kind === 'hostile' && e.name !== 'creeper').sort((a, b) => a.dist - b.dist);
if (!foes.length) return { skipped: '没有怪了' };
const armed = me.inventory.some((i) => /_(sword|axe)$/.test(i.name));
const crowd = foes.filter((f) => f.dist < 6).length;
if (armed && me.hp >= 12 && crowd <= 2) {
  const r = await api.act('defend', { entityId: foes[0].id });
  return { fought: foes[0].name, ok: r.ok, note: r.summary };
}
const f = foes[0];
const dx = me.pos.x - f.pos.x, dz = me.pos.z - f.pos.z, len = Math.hypot(dx, dz) || 1;
const r = await api.moveTo(me.pos.x + dx / len * 10, me.pos.y, me.pos.z + dz / len * 10, 3);
if (!r.ok) throw new Error('打不过也跑不开：' + r.error);
return { backed_off: 10, why: armed ? (crowd > 2 ? '怪太多' : '血不够') : '没有武器' };
