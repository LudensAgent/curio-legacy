---
id: "boats"
title: "船"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["船", "小船", "橡木船", "运输船", "竹筏", "boat", "oak_boat", "chest boat", "chest_boat", "raft", "bamboo_raft", "上船", "下船", "收船", "划船"]
sources: [{"url":"https://minecraft.wiki/w/Boat","title":"Minecraft Wiki: Boat"},{"url":"https://minecraft.wiki/w/Boat_with_Chest","title":"Minecraft Wiki: Boat with Chest"},{"url":"https://minecraft.wiki/w/Raft","title":"Minecraft Wiki: Raft"}]
versionNote: "原版 Java 1.20.1 的船、运输船与竹筏机制；速度为近似值，服务端规则或插件可能不同。"
reviewedAt: "2026-11-11"
---

## item-and-entity | 物品与实体

船在背包里是物品，放下后成为实体，不是方块：不占据方块格，不能像方块那样挖掘或用方块交互改变。各种木材各有对应的船（如 `oak_boat`），竹子对应竹筏（`bamboo_raft`）。运输船（如 `oak_chest_boat`）带有一个 27 格容器。[船](https://minecraft.wiki/w/Boat) [运输船](https://minecraft.wiki/w/Boat_with_Chest)

## crafting | 合成

同一种木板 5 块按 U 形排列合成对应的船，需要 3×3 合成格（工作台）。船与箱子无序合成得到对应的运输船。竹筏由竹板按同样的形状合成。合成产物需要背包里有可放下它的空位。[船](https://minecraft.wiki/w/Boat)

## placing | 放置

对水面或方块顶面使用船物品，会在该处放下一个船实体并消耗该物品。船可放在陆地上，但在陆地上几乎无法移动。[船](https://minecraft.wiki/w/Boat)

## boarding-and-capacity | 乘坐与容量

对船实体使用（右键）即可乘上。普通船最多容纳两名乘客，运输船只有一个座位。走近船的生物（玩家除外）可能被带进船里；被关进船里的生物不能自行离开。[船](https://minecraft.wiki/w/Boat)

## movement-and-speed | 移动与速度

船在水面上行驶，水面上速度约 8 格/秒，快于疾跑；在冰、浮冰、蓝冰上远快于水面；在其他地面上极慢。船会被方块挡住，不能像行走那样跨上一格高的岸；水流会推动船。[船](https://minecraft.wiki/w/Boat)

## dismounting | 下船与落点

按潜行键下船。游戏会在船周围寻找可以安全站立的位置放置乘客，搜索与乘客当前朝向有关；附近没有可站立的位置时，乘客被放到船的顶面上。在开阔水面上下船通常落到船顶或进入水中，而不是陆地上。[船](https://minecraft.wiki/w/Boat)

## breaking-and-recovery | 破坏与回收

攻击船实体会使其受到伤害，在短时间内连续受到足够多次攻击后船被破坏，掉落为对应的船物品（运输船还会掉出箱子及其中物品）。掉落物是普通掉落物实体，需要靠近拾取，背包没有空位时无法拾起。攻击间隔过长时船的伤害会逐渐恢复。[船](https://minecraft.wiki/w/Boat)

## persistence | 存留

放下的船实体不会像掉落物那样在 5 分钟后消失，会一直留在原处，直到被破坏或被推走。[船](https://minecraft.wiki/w/Boat)
