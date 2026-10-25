---
name: dodge-creeper
description: 苦力怕嘶嘶响或贴到眼前时背对它跑开（身体的反射，可以重写改进）
---

身体的反射之一：苦力怕已经在嘶嘶作响（快炸了），或者没在跟它打却贴到 2.5 格内，就背对它跑开几格；正前方跑不开就往两侧试。

躲在封好的坑里不触发（炸不到里面）。觉得这样不好（比如有盾、想打它），就同名重写这份代码，或者写一份新的技能。

```behavior
{
 "when": {"any": [{"hostile": {"name": "creeper", "within": 4, "fusing": true}}, {"hostile": {"name": "creeper", "within": 2.5}, "not_doing": ["defend"]}], "cover": ["open", "pit"]},
 "priority": 90,
 "cooldown_s": 3
}
```
