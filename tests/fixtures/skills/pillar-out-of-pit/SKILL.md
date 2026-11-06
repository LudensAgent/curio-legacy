---
name: pillar-out-of-pit
description: 掉进两三格深的坑里时原地垫高爬出来（routine 里写 use_skill {"name":"pillar-out-of-pit"}）
---

# 垫高出坑

头顶是空的或者是土，就一格一格往上垫：先把头顶那格挖开（是实心的话），再在脚下垫一块站上去。重复三次一般就出来了。

- 背包里要有能放的方块（泥土、圆石都行）。
- 头顶是沙子沙砾时别挖，会掉下来砸人：换个方向挖台阶。

```behavior
{
 "steps": [
  {"skill": "mine_cell", "args": {"at": [0, 2, 0]}, "if": {"cell": {"at": [0, 2, 0], "is": "solid"}, "not": {"cell": {"at": [0, 2, 0], "is": ["sand", "gravel", "red_sand"]}}}},
  {"skill": "pillar_one", "args": {"item": "any"}},
  {"skill": "mine_cell", "args": {"at": [0, 2, 0]}, "if": {"cell": {"at": [0, 2, 0], "is": "solid"}, "not": {"cell": {"at": [0, 2, 0], "is": ["sand", "gravel", "red_sand"]}}}},
  {"skill": "pillar_one", "args": {"item": "any"}},
  {"skill": "mine_cell", "args": {"at": [0, 2, 0]}, "if": {"cell": {"at": [0, 2, 0], "is": "solid"}, "not": {"cell": {"at": [0, 2, 0], "is": ["sand", "gravel", "red_sand"]}}}},
  {"skill": "pillar_one", "args": {"item": "any"}, "optional": true}
 ]
}
```
