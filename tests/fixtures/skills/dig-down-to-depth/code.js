const target = args.y;
if (typeof args.y === "number") {
  // 往下挖，直到脚到达目标高度
  let s = await api.state();
  let guard = 0;
  while (s.feet.y > target && guard < 40) {
    const below = await api.blockAt(Math.floor(s.feet.x), s.feet.y - 1, Math.floor(s.feet.z));
    if (below && below.kind === 'solid') {
      const r = await api.act('dig_at', { at: [0, -1, 0], facing: s.facing ?? 'N' });
      if (r && !r.ok) break;
    }
    await api.sleep(200);
    s = await api.state();
    guard++;
  }
  return { y: target, reached: s.feet.y <= target };
}
return { y: target, reached: false };
