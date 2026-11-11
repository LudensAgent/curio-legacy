---
id: "ghasts"
title: "恶魂与恶魂火球"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["恶魂", "恶魂火球", "火球", "反弹火球", "打回火球", "恶魂之泪", "ghast", "fireball", "ghast_tear", "return to sender"]
sources: [{"url":"https://minecraft.wiki/w/Ghast","title":"Minecraft Wiki: Ghast"},{"url":"https://minecraft.wiki/w/Fireball","title":"Minecraft Wiki: Fireball"},{"url":"https://minecraft.wiki/w/Explosion","title":"Minecraft Wiki: Explosion"}]
versionNote: "按 Java 1.20.1 的恶魂行为整理；Wiki 页面描述的是当前版本，其更新历史中 1.20.1 之后与本文相关的只有 1.21.6 的贴图和 25w20a 的 flying_speed 属性，二者都不在本文范围内。基岩版的索敌范围不同，不适用。未取得来源修订号。"
reviewedAt: "2026-11-11"
---

## basics | 生成、体型与掉落

恶魂是下界的飞行敌对生物，生命值 10（5 颗心），碰撞箱 4×4×4 格。它在下界荒地、灵魂沙峡谷和玄武岩三角洲生成，不受光照限制；生成需要下方有实心方块，并有 5×5 格宽、4 格高的空余空间；Java 版灵魂沙峡谷里 16 格内已有恶魂时不再生成。恶魂会发出哭叫声，最远约 80 格外能听到；发射火球前有单独的蓄力音效。被玩家击杀时有 50% 概率掉落 0–1 个恶魂之泪、66.67% 概率掉落 0–2 个火药，抢夺会提高数量。[恶魂](https://minecraft.wiki/w/Ghast)。

## attack | 索敌、视线与火球

Java 版恶魂会锁定水平 64 格、竖直 4 格以内的玩家，锁定后在 64 格球形范围内、只要有视线就持续攻击；开火需要视线，任何实心方块都会挡住视线，玻璃等透明的实心方块也算。它大约每 3 秒发射一枚火球，攻击时面向玩家并在空中左右平移，不会主动靠近。火球碰到方块或实体就会爆炸；直接命中的伤害为简单 4、普通 6、困难 9；随后的爆炸威力为 1，按距离造成最多简单 9.5、普通 17、困难 25.5 的伤害，并点燃附近方块。爆炸抗性在 3.5 及以上的方块不会被炸毁，例如圆石；下界岩的爆炸抗性很低，会被炸开。火焰会在地面燃烧，站在火里会持续着火。[恶魂](https://minecraft.wiki/w/Ghast)、[爆炸](https://minecraft.wiki/w/Explosion)。

## deflection | 反弹火球

恶魂火球被近战攻击或其他弹射物（如箭）击中时会被反弹，沿击打者视线所朝的方向飞出。被反弹的火球直接命中恶魂时造成足以将其击杀的伤害；击中其他生物时，该生物会把仇恨转向玩家。用反弹的恶魂火球击杀恶魂对应进度 Return to Sender。近战攻击有冷却和触及距离，挥击时机、火球与身体的距离和朝向都会影响能否击中它。[恶魂](https://minecraft.wiki/w/Ghast)、[火球](https://minecraft.wiki/w/Fireball)、[近战冷却](knowledge:combat-and-survival)。

## related | 相关条目

恶魂生成的群系见[下界群系](knowledge:nether-exploration)。爆炸、火焰和摔落属于不同的伤害来源。
