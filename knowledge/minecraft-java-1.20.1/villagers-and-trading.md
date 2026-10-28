---
id: "villagers-and-trading"
title: "村民职业、交易与补货"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["村民", "交易", "补货", "缺货", "职业", "工作站", "图书管理员", "农民", "附魔书", "绿宝石", "villager", "trading", "restock", "lectern", "composter", "emerald"]
sources: [{"url":"https://minecraft.wiki/w/Villager","title":"Minecraft Wiki: Villager"},{"url":"https://minecraft.wiki/w/Trading","title":"Minecraft Wiki: Trading"},{"url":"https://minecraft.wiki/w/Workstation","title":"Minecraft Wiki: Workstation"},{"url":"https://minecraft.wiki/w/Java_Edition_19w11a","title":"Minecraft Wiki: Java Edition 19w11a"},{"url":"https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-2","title":"Minecraft.net: Minecraft Java Edition 1.20.2"}]
versionNote: "采用 Java 1.20.1 的通常交易规则；排除 Bedrock 的床关联条件以及 1.20.2 才出现的实验性村民交易重平衡，不从当前完整交易表照搬概率或新增商品。未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## professions | 职业与工作站归属

成年失业村民可认领未被占用的对应工作站获得职业；傻子村民和幼年村民不能这样就业。讲台对应图书管理员，堆肥桶对应农民，砂轮对应武器匠，锻造台对应工具匠，高炉对应盔甲匠。工作站只是放在附近，不等于已被指定村民认领；多个村民、旧的归属和通路都会影响结果。已发生过交易的村民保留职业，拆工作站不能随意改成另一职业。[职业规则](https://minecraft.wiki/w/Villager)、[工作站对应](https://minecraft.wiki/w/Java_Edition_19w11a)。

## restocking | 村民补货、红叉缺货与工作时间

每项交易有可用次数，耗尽后暂时缺货，界面会显示红叉。村民在工作时使用自己认领的对应工作站补货，正常情况下每天最多补货两次；补货不是每次关闭交易界面就发生。Java 版补货不要求关联一张床。补货受工作站归属、可达性、工作时间和当日补货次数限制。在旁边放置另一张同类工作站，不保证当前村民已改用它。[补货](https://minecraft.wiki/w/Trading)、[工作行为](https://minecraft.wiki/w/Villager)。

## offers-and-version | 商品、价格与版本差异

职业决定可生成的交易池，交易升级后还会开放更多商品，但一位村民不会必然拥有该职业所有可能商品。交易界面显示该村民的具体商品和交换数量；工作站里放了物品也不会把它变成村民的商品库存。Java 1.20.1 不采用后续实验性“不同群系图书管理员出售不同附魔书”的规则，该实验在 1.20.2 才加入。[交易池](https://minecraft.wiki/w/Trading)、[工作站用途](https://minecraft.wiki/w/Workstation)、[1.20.2 实验说明](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-2)。
