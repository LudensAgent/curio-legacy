---
id: "inventory-and-stacks"
title: "物品栏、槽位与堆叠"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["背包", "物品栏", "空格", "空位", "槽位", "堆叠", "叠加", "叠放", "一组", "物品数量", "inventory", "slot", "stack", "stack size", "拾取", "捡起", "自动拾取", "丢弃", "扔掉", "掉落物", "pickup", "drop", "item entity"]
sources: [{"url":"https://minecraft.wiki/w/Inventory","title":"Minecraft Wiki: Inventory"},{"url":"https://minecraft.wiki/w/Item","title":"Minecraft Wiki: Item"},{"url":"https://minecraft.wiki/w/Iron_Ingot","title":"Minecraft Wiki: Iron Ingot"},{"url":"https://minecraft.wiki/w/Raw_Iron","title":"Minecraft Wiki: Raw Iron"},{"url":"https://minecraft.wiki/w/Item_(entity)","title":"Minecraft Wiki: Item (entity)"}]
versionNote: "仅说明 Java 1.20.1 的常规物品栏与堆叠规则；来源页面可能包含后续版本内容，未取得来源修订号。"
reviewedAt: "2026-10-29"
---

## slots | 物品栏的槽位

玩家物品栏的普通储存区有 27 格，快捷栏有 9 格；盔甲位置和副手位置另有各自的槽位。槽位是容纳一叠物品的位置，并不等于一个物品。一个槽位中一叠可堆叠物品的数量可大于一；四个空槽位并不意味着只能容纳四个物品。[物品栏](https://minecraft.wiki/w/Inventory)。

## stacking | 一格能放多少物品：堆叠上限与剩余空间

同种且数据相同的可堆叠物品可以放在同一槽位，直到达到该物品每叠上限。多数物品上限为 64，例如粗铁和铁锭；空桶和末影珍珠上限为 16，工具、盔甲和装满的桶通常不能堆叠。四个空槽位理论上可容纳 256 个普通粗铁或铁锭；已有未满的兼容物品堆也可能继续容纳物品，因此没有空槽位并不必然意味着同种物品完全放不下。同名物品的数据不同，例如自定义名称或其他物品数据不同时，不能仅凭名称认为它们可以合并。[物品](https://minecraft.wiki/w/Item)、[粗铁](https://minecraft.wiki/w/Raw_Iron)、[铁锭](https://minecraft.wiki/w/Iron_Ingot)。

## pickup | 物品实体的拾取与丢弃

掉在地上的物品以物品实体存在，不属于背包。玩家碰撞箱向水平各方向扩大 1 格、竖直扩大 0.5 格的范围内，物品实体会被自动拾取，不需要任何操作；背包里没有能容纳它的空槽或同类未满的堆叠时无法拾取，这时物品留在地上。物品实体有拾取延迟：玩家用丢弃键扔出的物品约 40 刻（约 2 秒），方块被破坏产生的掉落物约 10 刻；延迟过后，玩家只要经过其附近就会捡回，包括刚由自己扔出的物品。丢弃键沿视线方向把物品抛出，通常落在身前不远处。物品实体在所在区块进行实体运算时累计约 6000 刻后消失，火、岩浆、仙人掌和爆炸会提前损毁它；漏斗、部分生物也会拾取物品实体。[物品实体](https://minecraft.wiki/w/Item_(entity))、[物品栏](https://minecraft.wiki/w/Inventory)。
