# Curio Observer 模组：技术栈与实现方案

> 状态：设计稿 v0.1（尚未实现）
> 目标：在观察者的 Minecraft 客户端上，以 **Bot 的第一人称** 看到原版样式的生命条、饥饿条、护甲、经验、快捷栏，以及 Bot 使用背包、工作台、熔炉、箱子时的界面与合成过程。

---

## 1. 背景与问题

当前的观察链路是：观察者客户端进入旁观模式，通过 RCON `/spectate` 附着到 Bot，按 F5 切换视角。它能看到 Bot 眼中的世界，但缺少界面：

- 生命条、物品栏、背包和容器界面都由**玩家自己的客户端**绘制。Bot 是 Mineflayer 通过协议连接的，没有客户端，也就没有界面。
- 原版协议只向其他客户端同步玩家的**手持物品、护甲和部分实体元数据**，不同步背包内容、饥饿值、经验或打开的窗口。所以只装客户端模组也拿不到这些数据。

**结论**：数据由 Agent 提供，画面由观察者客户端里的模组用原版渲染绘制。

## 2. 目标与非目标

### 目标

1. 附着 Bot 时，在第一人称画面上以原版样式显示：生命（含半心、吸收心）、饥饿、护甲、经验等级和进度、9 格快捷栏、副手，以及当前选中格。
2. Bot 打开背包或容器时，弹出原版样式的**只读**界面，逐格同步内容。合成时能看到材料被放进格子、产物出现、产物进入背包的过程。
3. 隐藏旁观模式自带的界面元素，例如旁观菜单快捷栏。
4. 可选：屏幕内显示 AI 当前的目标和思考字幕。
5. 第一人称手持物品与挥手动画（阶段 3，实验性）。
6. 断线、重连、Bot 死亡和重生时状态正确，不崩溃，不残留界面。

### 非目标

- 观察者**不能**通过模组控制 Bot。模组只读，所有控制仍然走 Agent。
- 不修改服务器，也不需要服务端模组。
- 不追求像素级复刻所有原版界面，只覆盖 Bot 实际会用到的几类。

## 3. 总体架构

```
┌──────────────────────────── 同一台电脑 ────────────────────────────┐
│                                                                     │
│  Agent (Node.js)                         观察者 MC 客户端 1.20.1     │
│  ├ Mineflayer Bot ──协议──► 服务器 ◄──协议── 你的玩家（旁观 + /spectate）
│  ├ ObserverFeed                           └ Curio Observer 模组      │
│  │   读取 bot.inventory / windows /           ├ AgentLink（SSE 客户端）│
│  │   health / food / experience               ├ BotState（只读快照）   │
│  └ HTTP :3000                                  ├ BotHudRenderer        │
│      GET /api/observer/stream  ──SSE──────────►├ ContainerOverlay      │
│      （仅监听 127.0.0.1）                       ├ ThoughtOverlay        │
│                                                └ Mixins（隐藏旁观界面）│
└─────────────────────────────────────────────────────────────────────┘
```

**为什么用 SSE，而不是 WebSocket 或自定义网络包**

- Agent 的控制台已经在用 SSE（`node:http`），不需要新增依赖。
- Java 11 以上自带 `java.net.http.HttpClient`，可以按行读取流式响应，模组同样不需要额外依赖。
- 数据只有一个方向：Agent → 模组。
- 自定义网络包要求服务端装模组转发，违背“服务器不改”的前提。

## 4. 技术栈

### 4.1 模组（观察者客户端）

| 项 | 选型 | 说明 |
|---|---|---|
| 游戏版本 | Minecraft Java 1.20.1 | 与服务器一致 |
| 加载器 | Fabric Loader（与服务端一致，目前 0.20.1） | 只装在观察者客户端 |
| 依赖 | Fabric API（1.20.1 分支） | 使用 `HudRenderCallback`、`ClientTickEvents`、`KeyBindingHelper`、`ClientLifecycleEvents` |
| 映射 | Yarn 1.20.1 | 下文类名、方法名均按 Yarn 记 |
| 构建 | Gradle 8 + Fabric Loom | 用 Fabric 官方模板生成 Gradle Wrapper |
| 语言 | Java 17 | 1.20.1 要求 Java 17 |
| JSON | Gson | 游戏自带，不额外打包 |
| HTTP | `java.net.http.HttpClient` | JDK 自带 |
| Mixin | SpongePowered Mixin（随 Fabric） | 仅用于隐藏旁观界面，以及阶段 3 的手持物品渲染 |

> 精确的 Fabric API、Yarn、Loom 版本号，以 <https://fabricmc.net/develop> 上 1.20.1 对应的值为准，写进 `gradle.properties`。

**1.20.1 的渲染要点**（1.20.2 起改成了精灵图，不要混淆）：

- 心、饥饿、护甲、经验条用 `textures/gui/icons.png`；快捷栏和选中框用 `textures/gui/widgets.png`。
- 容器背景：`textures/gui/container/inventory.png`、`crafting_table.png`、`furnace.png`、`generic_54.png`。
- 绘制统一通过 `DrawContext`：`drawTexture(...)`、`drawItem(stack, x, y)`、`drawItemInSlot(textRenderer, stack, x, y)`（数量和耐久条）、`drawText(...)`。
- 物品构造：`Registries.ITEM.get(new Identifier(id))` → `new ItemStack(item, count)`；耐久用 `stack.setDamage(d)`；附魔光效可以直接给 stack 添加一个占位附魔标签，或保存 `enchanted` 标志后用 `RenderLayer` 光效。

### 4.2 Agent（Node.js 侧新增）

| 项 | 选型 | 说明 |
|---|---|---|
| 数据流 | 新增 `src/observer/feed.ts` | 订阅 Mineflayer 事件，生成增量消息 |
| 传输 | 复用 `src/observer/dashboard.ts` 的 HTTP 服务，新增 `GET /api/observer/stream` | SSE，只绑定 127.0.0.1 |
| 演示 | `npm run observer:demo` | 不连服务器也能回放一段脚本化数据，方便单独开发模组 |
| 节奏 | `UI_PACING_MS` | 点击前的光标移动时间；默认 300ms |

## 5. 数据协议（v1）

所有消息都是 SSE 事件，`event:` 字段是消息类型，`data:` 是一行 JSON。物品统一编码为：

```json
{ "id": "minecraft:stone_pickaxe", "count": 1, "damage": 12, "maxDamage": 131, "enchanted": false, "name": null }
```

空格子为 `null`。

| 事件 | 时机 | data |
|---|---|---|
| `hello` | 连接建立 | `{ "protocol": 1, "bot": "Curio", "mcVersion": "1.20.1", "agentVersion": "0.2.0" }` |
| `state` | 连接时发全量；之后**有变化时**发送，最多 10 次/秒 | 见下 |
| `window_open` | Bot 打开窗口，或开始 2×2 合成 | `{ "windowId": 3, "kind": "crafting_table", "title": "Crafting", "slots": [ ...item\|null ] }` |
| `slot` | 窗口内某格变化 | `{ "windowId": 3, "slot": 1, "item": {...} \| null }` |
| `cursor` | 鼠标上“拿着”的物品变化 | `{ "item": {...} \| null }` |
| `window_close` | 窗口关闭 | `{ "windowId": 3 }` |
| `action` | 挥手、开始/结束进食、使用物品 | `{ "type": "swing" \| "eat_start" \| "eat_end" \| "use" }` |
| `thought` | 新计划或新目标（可选显示） | `{ "goal": "制作石镐", "thought": "圆石够了，升级成石镐。" }` |
| `bot_status` | 连线/断线/死亡/重生 | `{ "status": "online" \| "offline" \| "dead" }` |
| `: ping` | 每 15 秒 | SSE 注释行，用于保活 |

`state` 的内容：

```json
{
  "health": 17.0, "absorption": 0, "food": 18, "saturation": 3.2,
  "xp": { "level": 2, "progress": 0.45 },
  "armor": [null, null, {"id":"minecraft:leather_chestplate","count":1}, null],
  "hotbar": [ ...9 个 item|null ],
  "offhand": null,
  "selected": 0,
  "main": [ ...27 个 item|null ]
}
```

`kind` 取值：`inventory`（2×2 合成，使用玩家背包窗口）、`crafting_table`、`furnace`、`chest`（`generic_9x3`）、`large_chest`（`generic_9x6`），其他窗口一律为 `generic`。

**版本策略**：`hello.protocol` 不匹配时，模组在屏幕上提示“协议版本不一致”并停止渲染，不会崩溃。

## 6. Agent 侧实现

### 6.1 数据来源（Mineflayer）

| 数据 | 来源 |
|---|---|
| 生命、饥饿、饱和度 | `bot.health`、`bot.food`、`bot.foodSaturation`；事件 `health` |
| 经验 | `bot.experience.level`、`bot.experience.progress`；事件 `experience` |
| 背包 | `bot.inventory.slots`：0 产物、1–4 合成格、5–8 护甲、9–35 主背包、36–44 快捷栏、45 副手；事件 `bot.inventory.on('updateSlot')` |
| 选中格 | `bot.quickBarSlot`；事件 `heldItemChanged` |
| 容器窗口 | 事件 `windowOpen(window)`、`windowClose(window)`；`window.on('updateSlot', (slot, old, new))`；`window.type` 例如 `minecraft:crafting` |
| 光标物品 | `window.selectedItem` |
| 挥手 / 进食 | 在 Agent 的 `attack`、`dig`、`eat` 调用处发出 `action` |

### 6.2 2×2 合成

不需要工作台的合成直接使用玩家背包窗口，Mineflayer **不会**触发 `windowOpen`。处理方式：在 `MineflayerAdapter.craft()` 中，若不使用工作台，就在合成前后人为发出 `window_open { kind: "inventory" }` 和 `window_close`，中间的格子变化照常来自 `bot.inventory` 的 `updateSlot`。

### 6.3 合成节奏（让观众看清）

Mineflayer 的 `craft` / `transfer` / `deposit` / `withdraw` / `toss` / `equip` 内部调的是模块内的本地 `clickWindow`，不经过 `bot.clickWindow`，
在外面包 `bot.clickWindow` 只能管到 `bot.craft` 那一条路；整批合成（每格放一叠、shift 点产物）和箱子整理几十下点击在几十毫秒内全部发完。
Agent 的适配器按配置增加等待（`scripts/patch-deps.mjs` 给 Mineflayer 打补丁，`MineflayerAdapter.installUiPacing`）。默认在点击前移动光标，并在窗口打开和关闭时短暂停留：

1. Mineflayer 的 `clickWindow` 入口每次先 `await bot.beforeWindowClick(slot, button, mode)`；适配器在这里 `sleep(UI_PACING_MS)`（默认 300ms，shift 点击按 60%），
   所有背包操作（合成、箱子、熔炉、交易、扔、换装备）都一下一下点。动作被打断时停顿立刻结束。
2. `openBlock` / `openEntity`（所有窗口都从这两个入口打开）返回前停留 `UI_OPEN_HOLD_MS`（默认 600ms）；关窗前停留 `UI_CLOSE_HOLD_MS`（默认 800ms），背包 2×2 合成结束时也停一下。
3. 批量合成的材料摆齐后额外停留 `UI_OPEN_HOLD_MS` 一次，再整批取出产物。`installMineflayerObserver` 传 `pacingMs: 0`，数据流不再另外包 `bot.clickWindow`。

这些等待会延长实际技能执行时间；Observer 展示实际窗口变化。分别设为 0 可关闭对应等待，点击失控保护仍然生效。

### 6.4 增量与限流

- `state` 合并到 100ms 一帧，只在内容变化时发送（比较序列化后的 JSON）。
- `slot` 和 `cursor` 逐条立即发送，保证合成动画的顺序正确。
- 新客户端连上时先发 `hello` 和全量 `state`；如果当前有打开的窗口，再补发一次 `window_open`。

## 7. 模组侧实现

### 7.1 目录结构

```
observer-mod/
├─ build.gradle  settings.gradle  gradle.properties  gradlew(.bat)  gradle/wrapper/
└─ src/main/
   ├─ java/dev/curio/observer/
   │  ├─ CurioObserverClient.java      # ClientModInitializer：注册事件、按键、启动连接
   │  ├─ config/ObserverConfig.java    # config/curio-observer.json
   │  ├─ net/AgentLink.java            # SSE 客户端：后台线程、按行解析、指数退避重连
   │  ├─ net/Protocol.java             # 消息 record 与 Gson 解析
   │  ├─ state/BotState.java           # 不可变快照 + AtomicReference，渲染线程只读
   │  ├─ state/ItemCodec.java          # JSON → ItemStack（带缓存）
   │  ├─ hud/BotHudRenderer.java       # 心/饥饿/护甲/经验/快捷栏/副手
   │  ├─ hud/ContainerOverlay.java     # 只读容器界面 + 光标物品动画
   │  ├─ hud/ThoughtOverlay.java       # 目标/思考字幕、连接状态提示
   │  └─ mixin/
   │     ├─ SpectatorHudMixin.java     # 附着 Bot 时取消旁观菜单的绘制
   │     └─ HeldItemRendererMixin.java # 阶段 3：第一人称手持物品
   └─ resources/
      ├─ fabric.mod.json               # environment: "client"
      ├─ curio-observer.mixins.json
      └─ assets/curio-observer/lang/{zh_cn,en_us}.json
```

### 7.2 线程模型

- `AgentLink` 在独立的守护线程中运行 `HttpClient.send(request, BodyHandlers.ofLines())`，逐行解析 SSE，产生新的 `BotState` 快照，再用 `AtomicReference.set()` 发布。
- 渲染线程（`HudRenderCallback`）只调用 `get()` 读取快照，不加锁，不在渲染线程里做任何 IO。
- 窗口打开和关闭这类需要动画计时的事件，记录“发生时刻”，由渲染线程根据当前时间插值。
- 断线后按 1s、2s、4s…（最长 15s）重连。断线期间 HUD 显示“Agent 未连接”，并隐藏 Bot 的物品数据，避免展示过期状态。

### 7.3 何时绘制

只在下列条件**同时满足**时绘制 Bot 的 HUD：

1. 已收到 `hello`，且协议版本匹配；
2. `MinecraftClient.getCameraEntity()` 是一个玩家实体，并且名字等于 `hello.bot`。也就是说你正在 `/spectate` Bot。配置项 `alwaysShow: true` 可以放宽这一条。

不满足时，模组什么都不画，客户端表现与原版一致。

### 7.4 HUD 绘制（BotHudRenderer）

坐标完全按原版 `InGameHud` 的布局计算（以屏幕宽高为基准），看起来与正常游玩一致：

| 元素 | 实现 |
|---|---|
| 快捷栏 | `widgets.png` 的快捷栏底图（182×22）和选中框；格子物品用 `drawItem` 加 `drawItemInSlot` |
| 副手 | 快捷栏左侧的副手槽底图 |
| 生命 | `icons.png` 中的空心、满心、半心；吸收心用黄心；`health ≤ 4` 时心跳抖动 |
| 饥饿 | `icons.png` 中的饥饿图标；饱和度为 0 时轻微抖动，与原版一致 |
| 护甲 | 根据 `armor` 中各件的护甲值求和，计算护甲图标数（物品护甲值查 `ArmorItem#getProtection()`） |
| 经验 | 经验条底图和进度，等级数字用绿色描边文字 |

### 7.5 容器界面（ContainerOverlay）

不使用 `HandledScreen` 或真实的 `Screen`：它们需要 `ScreenHandler` 与服务器同步，而且会抢走观察者的鼠标和键盘。改为在 HUD 层画一个“幽灵界面”：

1. 画半透明暗色背景，再画对应 `kind` 的容器贴图，居中显示。
2. 按原版槽位坐标表绘制每一格的物品，例如工作台 3×3 合成格起点为 (30,17)、产物格为 (124,35)、背包从 (8,84) 开始。坐标表写成常量，每种 `kind` 一份。
3. 收到 `slot` 事件时，该格做一次 150ms 的高亮和缩放动画。
4. `pointer` 在真实点击等待前携带目标格、光标物品和移动时长；光标沿该目标移动，槽位同步不会改写鼠标位置。旧数据流没有 `pointer` 时仍使用槽位变化兼容显示。`inventory_transfer` 单条记录整叠丢弃、快捷转移或服务器确认的批量合成产量，不按数量拆分动画。
5. 收到 `window_close` 后淡出 200ms。

这个界面纯展示，不响应鼠标，观察者可以继续正常操作自己的客户端。

### 7.6 隐藏旁观界面（Mixin）

- `SpectatorHudMixin`：注入 `SpectatorHud#renderSpectatorMenu`，当正在附着 Bot 时取消绘制。
- 不使用 F1：F1 会把 `HudRenderCallback` 也一起隐藏。
- 准星保留。“正在旁观 Curio”这类提示由模组的 ThoughtOverlay 统一接管。

### 7.7 第一人称手持物品（阶段 3，实验性）

原版附着其他玩家时不渲染手。实现方案：注入 `HeldItemRenderer#renderItem`（或 `GameRenderer#renderHand`），当相机实体是 Bot 时，用 `state.hotbar[selected]` 作为主手物品渲染，并根据 `action: swing` 驱动挥手进度。这一步涉及渲染管线细节，放在最后实现；做不好可以直接关闭，不影响其他功能。

### 7.8 配置与按键

`config/curio-observer.json`：

```json
{
  "url": "http://127.0.0.1:3000/api/observer/stream",
  "alwaysShow": false,
  "showThought": true,
  "showContainers": true,
  "hudScale": 1.0
}
```

| 默认按键 | 作用 |
|---|---|
| `H` | 显示/隐藏 Bot HUD |
| `J` | 显示/隐藏思考字幕 |
| `K` | 立即重连 Agent |

## 8. 开发与验证

### 8.1 构建

```powershell
cd observer-mod
.\gradlew.bat build          # 产物：build/libs/curio-observer-<ver>.jar
.\gradlew.bat runClient      # 开发客户端（自动带 Fabric API）
```

把产物 jar 和 Fabric API 一起放进观察者客户端的 `mods/` 目录。

### 8.2 不依赖游戏的验证

| 层 | 方法 |
|---|---|
| Agent 数据流 | `node:test`：用 FakeAdapter 驱动背包变化和合成，断言 SSE 消息顺序与内容（`window_open` → 多个 `slot` → `window_close`） |
| 协议演示 | `npm run observer:demo`：循环回放“砍树 → 打开工作台 → 合成木镐 → 受伤 → 进食”的脚本数据 |
| 模组解析 | JUnit 测试 `Protocol` 与 `ItemCodec`（未知物品 id 回退为屏障方块图标，不抛异常） |

### 8.3 联调验收

| # | 验收项 | 标准 |
|---|---|---|
| 1 | 附着 Bot 后出现 HUD | 生命、饥饿、经验、快捷栏与 Bot 实际状态一致，延迟 < 200ms |
| 2 | 切换手持物品 | 选中框随 Bot 移动 |
| 3 | 2×2 合成木板 | 背包界面弹出，能看到原木放入、木板产出、界面关闭 |
| 4 | 工作台合成木镐 | 工作台界面弹出，材料逐格放入，产物进入背包 |
| 5 | 受伤 / 进食 | 心和饥饿图标实时变化，低血量时心跳抖动 |
| 6 | 停止 Agent | HUD 显示“未连接”，不显示过期数据；Agent 重启后自动恢复 |
| 7 | 取消旁观 | 模组停止绘制，客户端恢复原版表现 |
| 8 | 性能 | 开启模组后观察客户端帧率下降 < 5% |

## 9. 分阶段计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| 0 | Agent：`ObserverFeed` + `/api/observer/stream` + demo 回放 + 测试 | 数据流可用，可用 `curl -N` 查看 |
| 1 | 模组骨架：Gradle 工程、`AgentLink`、`BotState`、HUD（心/饥饿/护甲/经验/快捷栏）、隐藏旁观菜单 | 第一人称 + HUD |
| 2 | `ContainerOverlay`：背包、工作台、熔炉、箱子；光标动画；Agent 侧合成节奏 | 合成过程可见 |
| 3 | 第一人称手持物品与挥手、思考字幕、按键与配置 | 完整观察体验 |

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| Fabric API / Yarn 版本号错配导致编译失败 | 版本统一写在 `gradle.properties`，按 fabricmc.net 上 1.20.1 的推荐值设置；编译报错时按报错调整 |
| 1.20.1 与 1.20.2+ 的界面贴图机制不同 | 明确只支持 1.20.1，贴图路径集中在一个常量类里，日后升级只改一处 |
| Mineflayer 合成过程中的窗口事件与预期顺序不一致 | 以 Agent 侧测试固定事件顺序；模组只根据格子状态绘制，不依赖事件的具体顺序 |
| 观察者没有在旁观 Bot，HUD 误显示 | 绘制前检查相机实体名字；不匹配时什么都不画 |
| SSE 连接被代理软件或安全软件拦截 | 只连 127.0.0.1；失败时在屏幕上给出明确提示 |
| 第一人称手持物品渲染复杂 | 放到最后阶段，作为可选功能，可以单独关闭 |

## 11. 待确认事项

1. 观察者客户端使用的启动器，以及是否已安装 Fabric Loader 和 Fabric API（用于确定安装说明）。
2. 思考字幕是放进模组（游戏内显示），还是继续使用 OBS 浏览器叠加层，或者两者都保留。
3. 合成节奏的默认值（每次点击 250ms，打开停留 600ms，关闭停留 800ms）是否合适。
