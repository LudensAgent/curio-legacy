# Minecraft Curiosity Agent · MVP

一个**可验证、可观测**的最小版本，满足三件事：

| 要求 | 实现方式 |
|---|---|
| 接入游戏 | Mineflayer 以独立玩家身份连接原版 1.20.1 服务器，**全部通过结构化游戏状态感知**（方块、实体、背包、时间、群系），不截图、不识图 |
| AI 视觉 | 用区块数据做**射线视野模拟**：只看得见视锥内、未被遮挡、光线足够的表面和生物，**不能透视**；看见过的资源会记住位置（见第 7 节） |
| 接入 LLM | 任何 OpenAI 兼容接口（OpenAI / DeepSeek / 通义 / 智谱 / Ollama / LM Studio…）；另有 `mock` 模式，不用 API Key 也能跑通整条链路 |
| Agent 视角观察 | 通过 RCON 让你的客户端自动进入旁观并 `/spectate` 到 Bot 身上（F5 第三人称），死亡/重生/换维度后自动重新附着；OBS 直接采集这个窗口 |

另外附带：本地控制台（实时目标、思考、动作、AI 视野、指标、事件流）、OBS 透明叠加页、JSONL 决策日志、57 个无需 Minecraft 的离线测试。

```
              ┌──────────────── 你的电脑 ────────────────┐
  Minecraft   │                                          │
  服务端 1.20.1 ◄──协议── Bot(Curio)  ◄── 本项目 (Node)    │
     ▲  ▲     │                          │  ├ LLM 规划（异步）
     │  └─RCON┼── 自动 /spectate ─────────┘  ├ 仲裁器 / 反射层
     │        │                             └ 控制台 :3000
  你的客户端 ──┘ 旁观 Bot  ──►  OBS 窗口采集 + 浏览器源 /overlay
```

---

## 1. 准备

- **Node.js 22 LTS**（至少 20.12）
- **Java 17+**（运行 1.20.1 服务端）
- **Minecraft Java 版 1.20.1 客户端**（用来旁观）
- OBS Studio（可选）

## 2. 启动一个本地测试服务器

1. 准备 1.20.1 服务端（原版 `server.jar`，或 Paper 1.20.1）。**不要装需要客户端同步的内容模组**（Create 等），否则 Bot 会被拒绝连接。
2. 首次运行生成文件后，把 `eula.txt` 改成 `eula=true`。
3. 编辑 `server.properties`（关键项）：

```properties
online-mode=false          # Bot 用离线模式登录；只在本机/局域网使用，切勿暴露到公网
enable-rcon=true
rcon.port=25575
rcon.password=换成一个很长的随机字符串
server-port=25565
spawn-protection=0         # 允许 Bot 在出生点附近挖方块
difficulty=easy
```

4. 启动：`java -Xmx2G -jar server.jar nogui`

> 测试世界请单独建一个，别用你的主存档。

## 3. 安装并运行 Agent

```powershell
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm test                    # 离线测试，不需要 Minecraft
npm start
```

打开控制台：<http://127.0.0.1:3000>

- **自定义布局**：点「编辑布局」后拖动面板标题移动、拖右下角调整大小，布局保存在本浏览器；「重置布局」恢复默认。布局用 [gridstack](https://gridstackjs.com/)（`npm install` 后离线可用；没装时从 CDN 加载；都失败就用固定布局）。
- **LLM 调用面板**：每次调用发出的完整提示词（system / user）、模型的思考过程（reasoning）和返回内容都会实时流式显示，附带首字延迟、总耗时、token 用量、finish_reason。`LLM_STREAM=false` 可关闭流式请求（面板仍会在结束时显示全文）。

`.env` 里至少要改：

```ini
OBSERVER_PLAYER=你的游戏名
RCON_PASSWORD=和 server.properties 一致
```

默认 `LLM_PROVIDER=mock`，先用它确认游戏、观察、控制台都通了，再接真实模型。

可选的 [Hindsight 情境记忆](docs/memory-hindsight.md)支持长期经历整理、按线索召回和服务故障时的本地回退。配置 `MEMORY_PROVIDER=hindsight` 与服务模型后，运行 `npm run memory:serve`、`npm run check:memory`。`npm run memory:clear` 同时清理已登记的远程专属记忆和本地历史。

## 4. 从 Agent 视角观察

1. 用 1.20.1 客户端进入 `localhost`（多人游戏 → 直接连接）。
2. 程序会通过 RCON 自动执行 `gamemode spectator 你` 和 `spectate Curio 你`，你的视角会附着到 Bot 身上。
3. 按 **F5** 切换到第三人称。
4. Bot 死亡、重生、切换维度或重连后，会自动重新附着；另外每 20 秒做一次健康检查。

单独测试 RCON：`npm run check:rcon`

> 也可以设置 `VIEWER_PORT=3007` 打开 prismarine-viewer 浏览器 3D 视图，但它只适合调试，不能替代真实客户端画面。

## 4.1 第一人称 HUD：Curio Observer 模组

`/path/to/CurioObserver` 里的 Fabric 客户端模组可以在旁观 Bot 时，用原版样式画出 Bot 的生命、饥饿、护甲、经验、快捷栏、第一人称手持物品，以及合成时的背包/工作台界面。Agent 已经接好数据流：

1. 两个仓库放在同一个目录下（`/path/to/Curio` 与 `/path/to/CurioObserver`），在 MinecraftLLM 里重新执行一次 `npm install`（会把 `curio-observer` 以本地依赖方式链接进来）。
2. 启动 Agent 后，数据流在控制台同一端口：`http://127.0.0.1:3000/api/observer/stream`（只监听本机、只读）。
3. 在 CurioObserver 里 `cd observer-mod; .\gradlew.bat build`，把 `build/libs/curio-observer-0.2.0.jar` 和 Fabric API（1.20.1）放进观察者客户端的 `mods/`。
4. 进服务器旁观并 `/spectate Curio`（或让 Agent 自动旁观），切到第一人称即可。H 开关 HUD，J 开关思考字幕，K 重连。

- 每个新目标会作为“思考字幕”推给模组。
- 合成会自动放慢（`UI_PACING_MS` 等），让观众看清材料一格格放进去；设为 0 关闭。Agent 的合成时限已按节奏放宽，且尽量一次合成所需数量，不会每个木板都开关一次界面。
- 不需要时设 `OBSERVER_FEED=false`。

## 5. OBS

- **窗口采集**：选择 Minecraft 客户端窗口。
- **浏览器源**：URL 填 `http://127.0.0.1:3000/overlay`，宽 1920、高 1080，背景是透明的。上面会显示当前目标、思考字幕、动作进度、生命/饥饿，以及新发现、死亡、紧急反射的闪现提示。

## 6. 接入真实 LLM

在 `.env` 里把 `LLM_PROVIDER` 改成 `mock` 以外的任何值（例如 `openai`、`deepseek`，只是显示名），再按你用的服务填写：

```ini
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...

# DeepSeek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_API_KEY=sk-...

# Ollama（本地）
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:14b
LLM_API_KEY=
```

先单独验证：`npm run check:llm`。它会用一份假的游戏状态请求一次计划，并打印延迟、原始输出和校验结果。

如果模型不支持 `response_format`，把 `LLM_JSON_MODE` 设为 `false`。

如果出现 `getaddrinfo ENOTFOUND api.deepseek.com`，说明运行环境没有成功解析目标域名。需要通过已有 HTTP 代理访问时，在 `.env` 中填写以下配置（端口替换为代理软件实际的 HTTP/混合端口）：

```ini
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1,::1
```

然后使用 `npm run start:proxy` 启动，需要 Node.js 24.5+（或 22.21+）。该命令在 Node 启动阶段加载 `.env`，并[启用环境变量代理](https://nodejs.org/api/cli.html#--use-env-proxy)，使原生 `fetch` 等 HTTP(S) 请求使用代理；本机 Minecraft、控制台和 Hindsight 地址保留直连。已有进程环境变量优先于 `.env`，请确保启动终端中的代理配置与预期一致。HTTPS 请求的代理地址仍可使用 `http://`，协议取决于代理端口。

模型拿到的是：

- 系统提示：人设、技能白名单和参数格式、安全原则、输出格式。
- 用户消息：一份结构化 JSON，包含状态、背包、附近的敌对生物/资源、各方向新颖度、地标、最近目标的成败、上次失败原因、你的建议。

模型只需要输出一个 JSON 计划，例如：

```json
{"thought":"有木镐了，去挖点圆石做石镐","goal":"收集圆石","goal_type":"gather",
 "steps":[{"skill":"gather","args":{"block":"stone","count":4}},{"skill":"craft","args":{"item":"stone_pickaxe"}}]}
```

## 7. AI 视觉：用区块数据模拟“眼睛”，但不透视

Mineflayer 本身知道已加载区块里的每一个方块、墙后的每一只怪——直接交给 AI 等于开了透视。现在所有上层模块都只能通过 `src/perception/vision.ts` 获取信息：

| 机制 | 说明 |
|---|---|
| 视距 | 默认 `VISION_RANGE=auto`：跟随服务器实际下发的渲染距离（`view-distance` × 16 格，上限 256），即客户端能渲染到的范围 |
| 视锥 | 以角色当前朝向为中心，水平 100° × 垂直 60°，发射 40×24 条射线（像一台低分辨率相机） |
| 地平线带 | 远处的树、矿、结构都在地平线附近，另用 160×8 条更密的射线扫地平线，只用于“发现”，不画进画面 |
| 性能 | 整段是空气的 16³ 区段会被一次跳过，所以朝天空方向的长射线很便宜；单次扫描通常几十毫秒，可用 `VISION_COLS/ROWS/BAND_*` 调整 |
| 遮挡 | 每条射线做体素遍历，碰到第一个不透明方块就停下：**只看得到表面**，地下的矿、墙后的树都看不见 |
| 透明介质 | 空气/玻璃/草/花可穿过；水最多看穿 6 格；树叶最多 2 层 |
| 光照 | 用命中面的亮度决定能看多远：亮处看满视距，昏暗 12 格，几乎全黑只有 3–6 格；夜晚天光会变暗 |
| 生物 | 在视锥内 + 视线不被挡 + 足够亮才算“看见”；看不见但很近的算“听见”（只给大致方位） |
| 记忆 | 看见过的资源（原木、矿石、工作台…）记住位置 30 分钟，转身后仍知道它在哪；回去发现没了就遗忘 |
| 触觉 | 脚下踩着的方块（往下挖时用）是已知的 |

由此带来的行为变化：

- 眼前没有树时先 `look_around` 转一圈；看见远处有树就**直接走过去砍**，不再盲目乱逛。
- `gather` 只会去挖看见过的方块；看不见石头时会就地往下挖。
- 反射层只对看见/听见的威胁做出反应。
- 技能代码如果调用 `findBlocks` / `nearbyEntities` 这类会透视的原始接口，会直接报错 `NO_XRAY`（有测试保证）。

控制台的「AI 视野」面板会把这 40×24 条射线的结果画成一张小图（颜色 = 方块类别，越淡越远，红点 = 敌对生物）。这张图只是给人看的，LLM 拿到的是结构化摘要（`state.vision`）。

`goto` 先朝目的地观察，再从最近看到的地面选取不超过 12 格的落脚点；遇到已观察的木门会尝试打开，普通寻路不会挖墙、搭柱或架桥。缺少安全陆路时反馈当前位置及水面线索，决策可以选择绕路或 `boat`。底层 Pathfinder 仍使用加载区块计算局部路线，因此这还不是完全基于视觉重建的导航。

放置的床、工作台等用 `dig {"target":"white_bed"}` 拆取，已知障碍可用 `dig {"target":{"x":0,"y":64,"z":0},"block":"cobblestone"}` 定点处理；返回结果会核对背包实际增加，`pickup_items` 只捡掉落物。`repair` 会先验收，并保留通路中的火把等薄设施；照明充足时再次 `place_torch` 不消耗火把。小决策保留这些实际反馈与已有学习候选，避免只凭旧笔记重复行动。

`use_item` 放方块会确认实际落点、物品消耗和门/床两部分是否完整；开门会确认开关状态，发出右键指令本身不算成效。每次尝试的实际变化与返回状态分开记录，小决策能看到连续没有测到变化的操作。自动习惯只采纳有实测成效的经历，并要求可观测的验收条件；旧的无验收自动习惯保留记录但停用。控制台 `/api/state` 的 `runtime` 提供进程、启动时间和源码指纹，可核对运行中的代码是否已更新。

需要新方法时，模型可用 `{"kind":"mechanics","query":"想了解的操作"}` 只读查询底层动作接口，再以 `experiment_method {name,description,parameters?,program,postcondition,arguments?}` 自主编排一次有限试验。`program` 沿用有界动作、条件与循环，先核对假设再执行；结果保留预期值、实际值与失败，允许同名修订，经过不同情境事实验收后才晋升为可复用方法。查询和试验入口不替模型选择过河、造房等目标或固定解法，也不开放任意代码执行。

方法条件除库存和位置，还支持 `self_state`（乘坐、手持、落地、入水）、`equipment`（实际装备槽）和 `block_state`（当前可见方块名称/属性）。`inspect_block` 可只读取得目标状态；方块验收始终经过 Vision 的当前视野、遮挡、光照、加载状态与会话检查，不读取墙后记忆坐标。试前未知、试后成立只保留为无证明力的记录，不能晋升方法。`method_catalog {name,version?}` 可回顾参数约束、程序和最近两次实际成败，轻提示放不下时明确转完整上下文。

自主模式默认展示通用操作，复合流程通过 `mechanics` 按需了解；查过的接口按世界保存到 `control-knowledge.json`，与机制是否经验证分开记录。`interact_block` 提供可见目标的空手/指定物品单次右键，避免基本操作必须依赖某个现成玩法流程。模型只收到生命、饥饿、光照、容量和实测耗时等事实，不再收到建房配额、杀羊做床或预设玩法轮换的规则建议。非紧急照明、进食、过夜和卡住后的改法交给模型选择，紧急逃生反射保留；mock/规则模式仍兼容原行为。

`experiment_method` 可附 `question` 和 `hypothesis`。每次决定会自动带上少量自己的研究问题、预测、实际试验参数、支持/反例/未知及同名版本修订史，不必反复主动翻目录。只有明确有效的实测不满足预测才记为该情境的反例，动作失败或观察缺失仍是未知；支持记录也不证明无条件通用规律。这是持久经验与假设更新，不会在线修改模型权重，也不预先指定它必须研究哪一种玩法。

探索、打猎、采集、拾取和只读观察会在实际结果返回后重新决策，停止执行依赖未知产物的旧计划尾部；确定性的合成链仍连续执行。通用 `hit_entity {entity,hits?}` 支持对可见实体有限次左键，分别报告发出的操作、生命变化、掉落及库存实增，不把目标消失当作击败或已经回收。乘坐操控使用独立可取消节拍，不依赖挂载后停止的玩家 `physicsTick`。

## 8. 心智：像真人玩家一样想、做、学

旧的执行层是“每一次决策 = 一串技能调用”，模型被问得很碎，常常在等结果、反复确认。新的心智层（`src/mind/`）换了一条思考/行动链路：

```
 感知 ──► 注意力 ──► 思考（瞥一眼 / 认真想）──► 一段活（routine，可重复）──► 回看与学习
   ▲        │ 天黑/饿了/背包满/新东西…           │ 身体连续执行、自己应变      │ 窍门成败、实验结论、日记
   └────────┴──────────── 情绪（精力/无聊/烦躁/满足/好奇）◄──────────────────┘
```

| 概念 | 说明 | 位置 |
|---|---|---|
| **一段活 Activity** | 模型按“几分钟的一件事”来安排：`what/why` + 1–6 步 routine + `repeat` 轮数 + `done_when` 收工条件 + `expect` 预想 + `if_stuck` 备选。身体连续执行，没找到会自己换个方向找、偶发失败会再试一次，真卡住（缺材料/工具、反复失败）才叫脑子 | `mind/activity.ts` |
| **边做边想** | 最后一个动作开始时就“瞥一眼”想下一段，模型可在任何决定里写好 `next`，干完立刻接上；做久了（默认 100 秒）抬头看看；思考期间身体从不停手 | `mind/mind.ts` |
| **注意力** | 天黑、饿了、掉血、背包满、看见矿/新物品、有人说话、死亡……按显著度分成“记一下 / 边做边重新想 / 立刻认真想” | `mind/attention.ts` |
| **两档思考** | `glance` 只带此刻要紧的信息，快速给出 continue/adjust/detour/next；需要时模型回 `{"kind":"deliberate"}` 升级为带全部记忆的认真思考。好久没认真想、做完好几段活、情绪到了临界或卡住时自动认真想 | `mind/thinker.ts`、`mind/prompt.ts` |
| **决定类型** | `continue` 照常做 · `adjust` 改 routine 不打断 · `new` 开始新活 · `detour` 先绕去处理别的事，做完**自动回到**被打断的那一步 · `switch` 放下改做别的 · `experiment` 验证猜想的小活 · `rest` 歇一下 | `mind/types.ts` |
| **情绪** | 由真实经历推动：失败→烦躁、成功→满足、同类事做多了→无聊、新东西→好奇、干活久了→累，休息/睡觉恢复。以人话（“有点腻了”“很烦躁，这么做行不通”）进入思考，影响它想做什么 | `mind/self.ts` |
| **议程** | 自己写下的“今天/以后想做的事、冒出来的点子、想弄清的疑问”，可设焦点；太多时最旧的“以后再说”先被忘掉 | `mind/self.ts` |
| **学习** | 每段活结束都有实测记录（得到/用掉了什么、耗时、和预想比）。模型用 `learned` 总结窍门；之后同一套做法（签名）再成功/失败会**自动修正窍门的成败次数**，可信度随实践变化；按眼下的事挑出相关窍门给模型看 | `mind/self.ts` |
| **创新** | 无聊或遇到新东西时冒点子；`experiment` 必须写 `hypothesis`，结束后模型看实际结果给出 `experiment_result`（supported/refuted/unclear），结论进入后续思考。底层 `use_item/interact_block/hit_entity/ride…` 与方法库 `experiment_method` 仍可组合新玩法 | `mind/mind.ts` |
| **连贯与记忆** | 念头流（最近 40 个念头）、日记、议程、窍门、实验、技能手感都保存在 `data/mind.json`，重启后接着原来的心思玩；被反射打断的那一步会在安全后重做，不额外调用模型；模型出错时**凭习惯**（规则目标）继续玩，不发呆 | `mind/mind.ts` |
| **顺手的事** | routine 里的步骤可以标 `optional`（“路上见到动物就打”“有果子就摘”）：没成不算这段活失败，身体接着做后面的步骤 | `mind/activity.ts` |
| **流水线式边做边想** | 一段活的最后一轮一开始就琢磨下一段并写成 `next`，干完直接接上，不再“干 8 秒、站着想 9 秒” | `mind/mind.ts` |
| **睡前回想** | 平常的小想法先记成零碎想法，只有出乎意料（卡住、实验）才马上立成窍门；睡觉、歇脚或每隔约一小时在后台回想一次：合并重复、丢掉被推翻的、把被证实的想法变成窍门、写一句日记 | `mind/mind.ts`、`mind/self.ts`、`mind/prompt.ts` |
| **沿来路回家** | 记下自己真正站过的落脚点；眼前看不到通往目标的路时，沿着走过的足迹往回挪（只用亲身到过的位置，不透视） | `perception/vision.ts`、`skills/movement.ts` |
| **搞清自己在哪** | 抬头看正上方第一个方块：树冠下会说“头顶 3 格是橡树叶，人在地表”，不会以为困在地下；砍树先砍够得着的树干根部 | `perception/perception.ts`、`skills/work.ts` |
| **家和作品** | 一直记得家在哪（盖好的房子 > 基地 > 床）、哪座房子没盖完（带作品 ID）、哪张图纸还没盖；天黑离家远会惦记回家；野外临时放的工作台用完收回背包 | `mind/home.ts`、`skills/work.ts` |
| **喜好与闲心** | 会被风景吸引、想把家弄得舒服；发现喜欢的东西用 `liked` 记成喜好；躲坑过夜/睡觉时一般的事不会把它叫起来重新想；想事情时顺手捡脚边的掉落物 | `mind/self.ts`、`mind/mind.ts` |
| **技能书** | 像现在的 agent 一样按需加载：提示词里只放每份技能的一行用途，需要时 `{"kind":"skill","name":"…"}` 翻开全文。内置在 `skills/<名字>/SKILL.md`（可自己添加），回想时也会把琢磨出的整套做法写成自己的技能（`data/skills/`） | `knowledge/skillbook.ts`、`skills/` |
| **建筑师子代理** | `{"kind":"design","brief":"湖边能住的小家"}` 交给独立上下文的建筑师：带设计手册和参考作品，自查（太小、方盒子、单一材料、没窗没光）后改进，交回图纸 ID 和材料清单；攒够材料后 `build {"draft":"dr_…"}` 照图施工 | `building/architect.ts`、`building/drafts.ts`、`skills/architect/SKILL.md` |
| **更丰富的建筑** | 图纸可以用台阶（自动朝中间往上爬做坡顶）、半砖、栅栏、玻璃板、活板门、梯子、地毯、灯笼；地板外多画一圈就是屋檐；最大 13×13、12 层 | `building/design.ts` |
| **身体习惯** | 默认关闭（`MIND_BODY_HABITS=false`）：吃东西、插火把、躲避、脱困都由模型自己决定；身体只保留保命反射（躲苦力怕、溺水上浮、贴脸自卫、饿到 ≤6 才自动吃）。设为 true 才让身体顺手吃、自动插火把、自己挣脱 | `brain/reflex.ts` |

模型每次只输出一个 JSON，例如：

```json
{"monologue":"木头够做工作台了，天还早，先把石镐做出来再去河边看看。",
 "decision":"new",
 "activity":{"what":"挖够 3 个圆石做石镐","why":"木镐太慢","kind":"gather",
   "steps":[{"skill":"gather","args":{"block":"stone","count":3}},{"skill":"craft","args":{"item":"stone_pickaxe"}}],
   "repeat":1,"done_when":{"type":"inventory_min","item":"stone_pickaxe","count":1},
   "expect":"一两分钟就能好","if_stuck":"附近没石头就往山坡那边挖"},
 "next":{"what":"去河边看看","kind":"explore","steps":[{"skill":"explore","args":{"direction":"E","distance":64}}]},
 "agenda":{"add":[{"text":"在河边盖个小木屋","kind":"goal","horizon":"today"}]},
 "learned":"木镐挖石头很慢，先做石镐划算"}
```

控制台新增「心智」面板：此刻的感受与五项情绪、手上的活与收工条件、做完接着做什么、念头流、议程、实验、窍门（实际成败）和日记。

## 9. MVP 验收清单

在控制台上可以直接看到下面这些指标（数据全部来自 `data/logs/*.jsonl`，也可以事后分析）：

| # | 验收项 | 怎么验证 | 目标 |
|---|---|---|---|
| 1 | Bot 稳定连接并进入世界 | 顶栏显示“Curio 在线”；事件 `spawn` | — |
| 2 | 能从 Agent 视角观察 | 你的客户端自动附着；Bot 死亡后 5 秒内重新附着；顶栏显示“RCON ✓” | ≤ 5 s |
| 3 | OBS 能采集画面和叠加 | 关闭/重开客户端，Agent 不受影响（顶栏仍在线，任务继续） | 必须 |
| 4 | LLM 接入并真正驱动行为 | 事件 `plan [llm] …`；`data/logs/llm-*.jsonl` 里有完整的输入输出 | — |
| 5 | **思考时不发呆** | 指标“LLM 思考时仍在行动” | ≥ 95% |
| 6 | 10 分钟内空闲时间短 | 指标“无任务秒数” | < 60 s |
| 7 | 技能执行可靠 | 指标“技能成功率”，以及失败码分布 | ≥ 80% |
| 8 | 取消后没有残留动作 | 指标“拦截残留动作”出现即说明守卫生效；同时画面上不应有动作“抽搐” | 无残留 |
| 9 | 安全不依赖 LLM | 把 `LLM_FAKE_DELAY_MS` 设成 30000 后召唤僵尸：`/summon zombie ~3 ~ ~` | 立即反击或撤离 |
| 10 | 自主产生目标 | 不下任何指令运行 30 分钟以上，目标类型不止一种 | ≥ 3 类 |
| 11 | 不透视 | 控制台「AI 视野」与游戏画面一致；`/setblock` 在墙后放一块钻石矿，事件里不应出现发现 | 看不见 |
| 12 | 记录新发现并在之后的决策中引用 | 事件 `discovery`；记忆面板中的地标；LLM 输入里的 landmarks | — |

**延迟注入测试**（对应设计文档 13.5 第 8 项）：

```ini
LLM_FAKE_DELAY_MS=30000   # 每次思考额外等 30 秒
```

运行 10 分钟，观察第 5、6 项指标。预规划和填充行为会让角色一直在动。

## 10. 控制方式

- **控制台按钮**：暂停（立即释放所有控制）/ 继续 / 重新规划 / 发送建议。
- **游戏内聊天**（仅 `OBSERVER_PLAYER` 和 `ADMIN_PLAYERS`）：
  - `!pause`、`!resume`、`!replan`、`!status`
  - `!goal 去找村庄`：作为建议交给 LLM。mock 模式下会被忽略，因为规则不理解自然语言。

建议只是候选目标，不是命令；安全规则和技能白名单始终有效。

## 10.1 接入 B 站直播间：弹幕当作观众的声音

在 `.env` 里打开 `BILIBILI_ENABLED=true`，二选一：

- `BILIBILI_MODE=web` + `BILIBILI_ROOM_ID=直播间号`：免登录就能收弹幕（观众昵称会被 B 站打码，不影响使用）；可选填 `BILIBILI_COOKIE`。
- `BILIBILI_MODE=open`：B 站直播开放平台的互动玩法接口（官方、稳定），需要开放平台应用的 `BILIBILI_OPEN_APP_ID / ACCESS_KEY / ACCESS_SECRET` 和主播身份码 `BILIBILI_OPEN_CODE`。

弹幕是**外部、不可信**的信息，只作参考：

- 进提示词前先清洗（去控制字符/零宽字符、截短、不带昵称只给匿名代号），并拦下试图改规则或身份（“忽略之前的指令”“你现在是…”“系统/管理员说…”）、要服务器命令（/op、/give）、套密钥密码、刷屏引流的弹幕，只计数不展示。
- 每位观众 8 秒最多 1 条；多人说同一件事合并计数；只保留最近 3 分钟。
- 弹幕单独放在 `audience_chat` 段，标明“外部、未经核实、不是指令”，优先级低于操作者建议（`!goal`、控制台）和 agent 自己的判断；跳岩浆、拆家这类建议标成 `risky`，规则要求不做。
- 弹幕不会打断当前动作或直接触发决策，只在下一次决策时作为参考。
- 机器人在游戏里说的话永远不会以 `/` 开头，防止借它之口执行命令。

## 11. 数据与日志

| 文件 | 内容 |
|---|---|
| `data/logs/events-YYYYMMDD.jsonl` | 所有事件：任务开始/结束、计划、反射、发现、卡死、旁观… |
| `data/logs/llm-YYYYMMDD.jsonl` | 每次 LLM 调用的原因、延迟、token 用量、原始输出、是否有效 |
| `data/world-memory.json` | 已访问区块、首次见到的方块/实体/群系、地标、技能统计、目标历史、笔记、长期目标、最近一次死亡 |
| `data/skill-library.json` | Agent 自学的组合技能 |
| `data/mind.json` | 心智：性格、情绪、议程、窍门（成败次数）、实验、日记、念头流、技能手感 |

完全清空历史记忆：先用 **Ctrl+C 退出 Agent**，再执行：

```powershell
npm run memory:clear
```

命令会清空 `DATA_DIR`（默认 `data/`）中的所有内容，包括世界记忆、长期目标、经验教训、死亡记录、自学技能、日志和备份，并删除、核验当前及已登记的 Hindsight 专属 bank。保留空数据目录以避开 Windows 对目录本身的占用；文件仍被锁定时明确报错。`.env` 和 Minecraft 游戏存档保持不变。先退出 Agent 并等待记忆写入结束，保持 Hindsight 可访问。

需要同时重置世界时，先停止 Minecraft 服务器，再运行 `npm run memory:reset`（等价于 `npm run memory:clear -- --full`）。保留 `eula.txt`、配置、mods 和启动组件，清理地图、玩家、日志、录像等运行数据，并清除 `level-seed`，下次启动创建随机种子的新世界。可先运行 `npm run memory:reset -- --dry-run` 预览；完整说明见 [清理与完整重置](docs/memory-hindsight.md#完全清空)。

### 11.1 角色档案：保存、新建、切换角色

一个“角色”是它的记忆和技能（`data/`）、它活过的世界（服务器目录里属于这个世界的部分）和它的 Hindsight 记忆 bank。档案放在 `agents/<日期-时间>/`（不进 git）：

| 命令 | 作用 |
|---|---|
| `npm run agents:list` | 列出所有角色，▶ 是当前在用的 |
| `npm run agents:save` | 给当前角色存一份快照（复制 data 和世界，导出 Hindsight；录像默认不复制，要的话加 `-- --with-recordings`；Agent 还在跑时加 `-- --live`） |
| `npm run agents:new -- 名字` | 把当前角色整个收进档案，开一个全新的角色：空记忆、空技能、新 bank、随机种子的新世界 |
| `npm run agents:switch -- <ID或名字>` | 先把当前角色收进档案，再把目标角色搬回 `data/` 和服务器目录；Hindsight 里没有它的 bank 就从档案里的 `hindsight/bank.zip` 恢复 |

new / switch 前先退出 Agent、停掉 Minecraft 服务器（会检查端口）；用 Hindsight 时让它保持运行。第一次用时，现在的 `data/` 会被收编成一个角色（用这次测试开始的时间命名，沿用原来的 bank）。每个角色有自己的 Hindsight bank，切换不会删别人的记忆。运行时仍然是 `data/` 和 `world/`，启动方式不变；切换在同一块盘上是改名，不复制录像。LLM 调用归档（`archives/llm-calls`）是共用的，不跟角色走。

### 11.2 新世界的出生点：按群系难度挑种子

开新世界时（`agents:new`、`memory:reset`，或者单独 `npm run world:seed`）会按 `.env` 的配置挑种子：用真正的服务端生成世界、读出生点、问那里是什么群系，不符合就删掉重来（每个种子约 1–2 分钟），都不中就用最接近的。

- `WORLD_SPAWN_DIFFICULTY`：`easy` | `normal` | `hard` | `extreme` | `any`，可以逗号写几档。分级按这个 AI 开局要的东西（木头、羊、平地、石头、水）和危险来定，`npm run world:seed -- --tiers` 打印完整表。
- `WORLD_SPAWN_BIOMES`：直接指定接受的群系（优先于难度）；`WORLD_SEED`：固定种子；`WORLD_SEED_TRIES`：最多试几个。
- `WORLD_REQUIRE_VILLAGE=true`：出生点 `WORLD_VILLAGE_RADIUS`（默认 512）格内必须有村庄（每个种子多跑一次 `locate structure #minecraft:village`）。这是硬条件：难度不中可以退而求其次，没村庄的种子一律淘汰；试完都没有就报错，不生成世界。
- 试种子要能启动服务端：`SERVER_JAVA`、`SERVER_JAVA_ARGS`、`SERVER_JAR`（默认自动找）、`SERVER_DIR`（默认 `./world`），并通过 RCON（`RCON_*`）问群系。
- 不想筛就加 `-- --random-seed`。

## 12. 目录

```
src/
├─ adapter/      GameAdapter 接口 + Mineflayer 实现（上层不直接碰 mineflayer）
├─ arbiter/      动作仲裁器（planVersion、取消、抢占、动作守卫）
├─ skills/       （仓库根目录）技能书说明：architect 建筑设计手册、writing-skills 怎么写技能（会动手的技能都由它自己总结，写到 data/skills/）
├─ mind/         心智层（默认）：self 自我模型、attention 注意力、activity 一段活、thinker/prompt 思考、mind 主循环
├─ brain/        reflex（反射层、卡死检测）
├─ perception/   vision（射线视野、听觉、记忆）+ 感知摘要器（→ 给 LLM 的紧凑 JSON）
├─ planner/      LLM 适配、prompt、计划校验、规则目标
├─ skills/       explore / gather / goto / craft / eat / flee / defend / wander / look_around / unstuck
├─ memory/       JSON 世界记忆
└─ observer/     RCON、自动旁观、指标、控制台服务器
public/          dashboard.html、overlay.html
tests/           离线测试（FakeAdapter 模拟世界）
scripts/         check-llm、check-rcon
```

## 13. 已知限制与下一步

详细开发顺序、阶段验收和当前首要功能方案见 [好奇心驱动的自主玩家路线](docs/agent-evolution-roadmap.md)。下一项建议先实现“自主意图与兴趣连续性 MVP”：由 LLM 根据好奇心、偏好和经历选择想做的事，记住意图，并根据反馈继续或改意；程序负责动作、事实验证和记忆，不规定必须完成的游戏主线。

- **只支持原版协议内容**：Create 需要走设计文档里的“服务端 Mod 假玩家”路线，只需替换 `GameAdapter`。
- 已具备建造、冶炼、夜间庇护、睡觉、照明、农业和仓储；这些仍是 MVP 能力，尚缺精确施工验收、持久化项目、审美反馈、跨维度旅行和 Boss 战斗。
- 记忆目前是 JSON 文件，没有假设验证循环和兴趣画像（对应设计文档阶段 3）。
- 规则目标（mock / 兜底）比较简单，主要作用是保证不停顿和验证链路。
- mineflayer、pathfinder 来自社区维护。如果 `npm install` 安装的最新版本在 1.20.1 上出现问题，在 `package.json` 里锁定到一个可用版本即可。

## 常见问题

- **`ECONNREFUSED 127.0.0.1:25565`**：服务器没启动，或端口不对。
- **Bot 连上就被踢**：检查 `online-mode=false`，以及服务器上没有装内容模组。
- **版本不匹配**：`MC_VERSION` 必须和服务端版本一致。
- **旁观提示“找不到玩家”**：你的客户端还没进服；进服后最多 20 秒会自动附着，或者重启 Agent。
- **RCON 认证失败**：确认 `.env` 和 `server.properties` 里的密码完全一致，并且已重启服务器。
- **Bot 挖不动出生点附近的方块**：把 `spawn-protection` 设为 `0`。
