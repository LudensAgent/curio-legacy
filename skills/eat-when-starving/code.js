// 快饿死了：身边安全就吃一口（有什么吃什么）。
const me = await api.state();
const food = me.inventory.find((i) => /^(cooked_|baked_potato|bread|golden_carrot|apple|carrot|potato|beetroot|melon_slice|sweet_berries|glow_berries|dried_kelp|cookie|pumpkin_pie|mutton|beef|porkchop|chicken|rabbit|cod|salmon)/.test(i.name));
if (!food) return { skipped: '背包里没有吃的' };
const r = await api.act('eat', {});
if (!r.ok) throw new Error(r.summary);
return { ate: food.name };
