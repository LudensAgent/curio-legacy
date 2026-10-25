---
name: eat-when-starving
description: 饥饿掉到 6 以下、身边 6 格内没有怪时，背包里有什么吃什么（身体的反射，可以重写改进）
---

身体的反射之一：快饿死时先吃一口，不等脑子想。只有有点饿的时候吃不吃、吃什么，交给脑子或 habits.eat_below。

```behavior
{
 "when": {"food_below": 7, "no_hostile_within": 6, "any": [{"has": "cooked_*"}, {"has": "bread"}, {"has": "apple"}, {"has": "*mutton"}, {"has": "*beef"}, {"has": "*porkchop"}]},
 "priority": 60,
 "cooldown_s": 15
}
```
