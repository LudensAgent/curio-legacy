---
name: dig-down-to-depth
description: 往下挖到调用方指定的高度 y
---

按调用方给的 `y` 往下挖，直到脚到达那个高度。挖阶梯还是竖井由当时的地形和委托决定。

```behavior
{
 "name": "dig-down-to-depth",
 "description": "往下挖到调用方指定的高度 y",
 "when": {"after_failure": {"skill": ["dig"]}},
 "args": {"y": "要挖到的高度"},
 "code_file": "code.js",
 "verify": "const s = await api.state(); const target = args.args.y; return s.feet.y <= target ? true : '还没挖到 ' + target;",
 "version": 11
}
```
