---
name: local-path
description: 寻路器说没路或卡在脚边方块时，用代码在身边 12 格里自己找路一格格迈过去
---

# 局部寻路（代码技能）

这是一份写成代码的技能：一个在身边地形上跑的 A* 寻路，只走能站住的格子（脚下实、身体两格空），每步最多上下一级，然后用 `api.stepTo` 一格一格走。

- walk_path 报 PATH_NOT_FOUND / STUCK 时身体会先试它（恢复类），目标取失败那一步的坐标；目标是地名而不是坐标时它会直接放弃。
- 也可以在 routine 里 `use_skill {"name":"local-path","args":{"target":"x,y,z"}}`。
- 它会记成败；老失败会在后台被自动改进成新版本（v2、v3…），改坏了会退回。

```behavior
{
 "when": {"after_failure": {"skill": ["walk_path"], "code": ["PATH_NOT_FOUND", "STUCK"]}},
 "args": {"target": "要去的坐标 \"x,y,z\""},
 "priority": 35,
 "cooldown_s": 10
}
```
