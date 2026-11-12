---
id: "respawn-anchor"
title: "重生锚：合成、充能与下界重生"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["重生锚", "respawn anchor", "respawn_anchor", "哭泣的黑曜石", "萤石充能", "下界重生", "下界重生点", "锚重生", "重生锚爆炸"]
sources: [{"url":"https://minecraft.wiki/w/Respawn_Anchor","title":"Minecraft Wiki: Respawn Anchor"},{"url":"https://minecraft.wiki/w/Crying_obsidian","title":"Minecraft Wiki: Crying Obsidian"},{"url":"https://minecraft.wiki/w/Glowstone","title":"Minecraft Wiki: Glowstone"},{"url":"https://minecraft.wiki/w/Bed","title":"Minecraft Wiki: Bed"},{"url":"https://minecraft.wiki/w/Respawn","title":"Minecraft Wiki: Respawn"}]
versionNote: "限定 Java 1.20.1 的重生锚与床的维度规则；不采用后续版本对重生点或爆炸规则的改动。未取得来源修订号。"
reviewedAt: "2026-11-12"
---

## crafting | 合成与方块属性

重生锚由 6 个哭泣的黑曜石和 3 个萤石块合成：合成表上排 3 个哭泣的黑曜石、中排 3 个萤石块、下排 3 个哭泣的黑曜石。它需要钻石镐或更好的镐才能破坏，破坏时掉落自身，但已储存的充能会清零。爆炸抗性为 1200，硬度为 50，不能被活塞推动或拉动。

来源：[重生锚](https://minecraft.wiki/w/Respawn_Anchor)、[哭泣的黑曜石](https://minecraft.wiki/w/Crying_obsidian)、[萤石](https://minecraft.wiki/w/Glowstone)。

## charging | 萤石充能与光照

对重生锚使用萤石块（物品，不是萤石粉）会增加 1 次充能，最多 4 次；发射器装有萤石块时也能为其充能。充能 1–4 次对应的光照等级分别为 3、7、11、15，比较器输出分别为 3、7、11、15，未充能时为 0。

来源：[重生锚](https://minecraft.wiki/w/Respawn_Anchor)。

## spawn-setting | 设置重生点与消耗

重生锚必须位于下界且至少有 1 次充能，才能用于设置个人重生点；设置后即使玩家离开下界，该重生点仍然有效。已充能的重生锚会覆盖其他重生点，包括床；多名玩家可以共享同一个锚，剩余充能也共享。每次在锚旁重生消耗 1 次充能，即使重生的是另一名玩家。通过末地退出门返回主世界不属于重生，不消耗充能。重生锚不能作为床的备用重生点：锚被拆除、耗尽或缺少有效出现空间时，玩家回到世界出生点。

来源：[重生锚](https://minecraft.wiki/w/Respawn_Anchor)、[重生规则](https://minecraft.wiki/w/Respawn)、[床与重生](knowledge:beds-and-sleep#respawn)、[维度重生差异](knowledge:portals-and-dimensions#respawning)。

## explosions | 主世界、末地爆炸与床的维度限制

已充能的重生锚在非下界维度（主世界、末地或禁用的自定义维度）被用于设置重生点时会爆炸并被摧毁，爆炸威力为 5，会生成火焰；死亡消息为“was killed by [Intentional Game Design]”。爆炸伤害可以被盾牌格挡。未充能的重生锚不能设置重生点，也不会因此爆炸；在下界使用未充能锚只会失败。

床在下界或末地尝试睡眠时会爆炸；爆炸的床不设置重生点。床在主世界白天使用也能设置重生点，不需要真正睡过。细节见[床与睡眠](knowledge:beds-and-sleep#sleep-conditions)与[维度规则](knowledge:portals-and-dimensions#respawning)。

来源：[重生锚](https://minecraft.wiki/w/Respawn_Anchor)、[床](https://minecraft.wiki/w/Bed)、[下界规则](knowledge:nether-exploration#dimension-rules)。

## limits | 限制与例外

硬核模式下重生锚不会复活玩家，但仍可能消耗充能并执行传送。疣猪兽会远离重生锚（见[下界生物](knowledge:nether-mobs#hoglin-and-zoglin)）。

来源：[重生锚](https://minecraft.wiki/w/Respawn_Anchor)、[疣猪兽](https://minecraft.wiki/w/Hoglin)、[床](https://minecraft.wiki/w/Bed)。
