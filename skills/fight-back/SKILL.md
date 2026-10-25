---
name: fight-back
description: 被怪贴脸打时，有武器、血多、怪少才还手，否则先拉开距离（身体的反射，可以重写改进）
---

身体的反射之一：3 格内有怪、最近 3 秒挨过打、站在空地上时触发。

- 背包里有剑或斧、血 ≥ 12、身边不超过 2 只怪：还手（defend）。
- 否则先背对它退开 10 格，接下来怎么办交给脑子（垫高、堵路、绕开）。

```behavior
{
 "when": {"hostile": {"within": 3}, "hurt_within": 3, "cover": ["open"]},
 "priority": 50,
 "cooldown_s": 5
}
```
