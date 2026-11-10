---
name: step-up-when-blocked
description: 走路被脚边一格高的方块卡住时，先自己迈上去再接着走
---

# 被脚边的方块卡住

寻路有时会贴着一格高的土坎、台阶边原地蹭：前面那格是实的、上面两格空着，其实迈一步就上去了。

- 只在走路类动作（navigate_to / gather / wander）报 PATH_NOT_FOUND 或 STUCK 时才试。
- 先看清：前方脚下那格 [1,0,0] 是实心方块，[1,1,0]、[1,2,0] 和自己头顶 [0,2,0] 都空着，才迈 [1,1,0]。
- 迈上去之后身体会把刚才失败的那一步再做一遍。

这是一份示范：你自己总结出更好的办法时，照这个格式写一份新的（名字不同），身体立刻就会用。

```behavior
{
 "when": {"after_failure": {"skill": ["navigate_to", "gather", "wander"], "code": ["PATH_NOT_FOUND", "STUCK"]}, "cell": {"at": [1, 0, 0], "is": "solid"}},
 "steps": [
  {"skill": "move_step", "args": {"at": [1, 1, 0]}, "if": {"cell": [{"at": [1, 1, 0], "is": "open"}, {"at": [1, 2, 0], "is": "open"}, {"at": [0, 2, 0], "is": "open"}]}}
 ],
 "priority": 40,
 "cooldown_s": 5
}
```
