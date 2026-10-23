# Minecraft Curiosity Agent · MVP

一个**可验证、可观测**的最小版本，满足三件事：

| 要求 | 实现方式 |
|---|---|
| 接入游戏 | Mineflayer 以独立玩家身份连接原版 1.20.1 服务器，**全部通过结构化游戏状态感知**（方块、实体、背包、时间、群系），不截图、不识图 |
| 接入 LLM | 任何 OpenAI 兼容接口（OpenAI / DeepSeek / 通义 / 智谱 / Ollama / LM Studio…）；另有 `mock` 模式，不用 API Key 也能跑通整条链路 |
| Agent 视角观察 | 通过 RCON 让你的客户端自动进入旁观并 `/spectate` 到 Bot 身上（F5 第三人称），死亡/重生/换维度后自动重新附着；OBS 直接采集这个窗口 |

另外附带：本地控制台（实时目标、思考、动作、指标、事件流）、OBS 透明叠加页、JSONL 决策日志、16 个无需 Minecraft 的离线测试。

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

`.env` 里至少要改：

```ini
OBSERVER_PLAYER=你的游戏名
RCON_PASSWORD=和 server.properties 一致
```

默认 `LLM_PROVIDER=mock`，先用它确认游戏、观察、控制台都通了，再接真实模型。

## 4. 从 Agent 视角观察

1. 用 1.20.1 客户端进入 `localhost`（多人游戏 → 直接连接）。
2. 程序会通过 RCON 自动执行 `gamemode spectator 你` 和 `spectate Curio 你`，你的视角会附着到 Bot 身上。
3. 按 **F5** 切换到第三人称。
4. Bot 死亡、重生、切换维度或重连后，会自动重新附着；另外每 20 秒做一次健康检查。

单独测试 RCON：`npm run check:rcon`

> 也可以设置 `VIEWER_PORT=3007` 打开 prismarine-viewer 浏览器 3D 视图，但它只适合调试，不能替代真实客户端画面。

## 5. OBS

- **窗口采集**：选择 Minecraft 客户端窗口。
- **浏览器源**：URL 填 `http://127.0.0.1:3000/overlay`，宽 1920、高 1080，背景是透明的。上面会显示当前目标、思考字幕、动作进度、生命/饥饿，以及新发现、死亡、紧急反射的闪现提示。

## 6. 接入真实 LLM

在 `.env` 里把 `LLM_PROVIDER` 改成 `openai`，再按你用的服务填写：

```ini
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...

# DeepSeek
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-...

# Ollama（本地）
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:14b
LLM_API_KEY=
```

先单独验证：`npm run check:llm`。它会用一份假的游戏状态请求一次计划，并打印延迟、原始输出和校验结果。

如果模型不支持 `response_format`，把 `LLM_JSON_MODE` 设为 `false`。

模型拿到的是：

- 系统提示：人设、技能白名单和参数格式、安全原则、输出格式。
- 用户消息：一份结构化 JSON，包含状态、背包、附近的敌对生物/资源、各方向新颖度、地标、最近目标的成败、上次失败原因、你的建议。

模型只需要输出一个 JSON 计划，例如：

```json
{"thought":"有木镐了，去挖点圆石做石镐","goal":"收集圆石","goal_type":"gather",
 "steps":[{"skill":"gather","args":{"block":"stone","count":4}},{"skill":"craft","args":{"item":"stone_pickaxe"}}]}
```

## 7. 它是怎么保证连贯的

| 机制 | 位置 |
|---|---|
| LLM 完全异步：思考期间当前技能照常执行 | `src/brain/executive.ts` |
| **预规划**：最后一步进度达到 60% 或用掉一半时限时，提前请求下一个计划 | `executive.ts` |
| 预规划时假设当前任务会成功（把预期产出算进背包）；如果拿到的计划与刚完成的目标重复，就丢弃并重新规划 | `planner/plan.ts`、`executive.ts` |
| 没有计划时做**填充行为**（环顾/走动）；新计划一到，立即打断填充 | `executive.ts` |
| LLM 超时、出错或超预算时，退回规则目标，并指数退避 | `planner/planner.ts` |
| 输出校验：JSON 解析 → 技能白名单 → 参数校验；失败时把错误回传给模型重试一次 | `planner/plan.ts` |
| **单一动作所有权**：递增 planVersion；取消时立即 `stopAll`；被取消的任务再发动作会被拦截并计数 | `src/arbiter/arbiter.ts` |
| **反射层**（每 250ms，不经过 LLM）：岩浆、苦力怕、低血量撤离、近身反击、自动进食；结束后重试被打断的步骤 | `src/brain/reflex.ts` |
| 卡死检测：移动类技能 20 秒内位移不足 1.5 格，判定 STUCK 并执行脱困 | `reflex.ts` |
| 失败冷却：同一个目标刚失败过，就先换个方向探索 | `plan.ts` |

## 8. MVP 验收清单

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
| 11 | 记录新发现并在之后的决策中引用 | 事件 `discovery`；记忆面板中的地标；LLM 输入里的 landmarks | — |

**延迟注入测试**（对应设计文档 13.5 第 8 项）：

```ini
LLM_FAKE_DELAY_MS=30000   # 每次思考额外等 30 秒
```

运行 10 分钟，观察第 5、6 项指标。预规划和填充行为会让角色一直在动。

## 9. 控制方式

- **控制台按钮**：暂停（立即释放所有控制）/ 继续 / 重新规划 / 发送建议。
- **游戏内聊天**（仅 `OBSERVER_PLAYER` 和 `ADMIN_PLAYERS`）：
  - `!pause`、`!resume`、`!replan`、`!status`
  - `!goal 去找村庄`：作为建议交给 LLM。mock 模式下会被忽略，因为规则不理解自然语言。

建议只是候选目标，不是命令；安全规则和技能白名单始终有效。

## 10. 数据与日志

| 文件 | 内容 |
|---|---|
| `data/logs/events-YYYYMMDD.jsonl` | 所有事件：任务开始/结束、计划、反射、发现、卡死、旁观… |
| `data/logs/llm-YYYYMMDD.jsonl` | 每次 LLM 调用的原因、延迟、token 用量、原始输出、是否有效 |
| `data/world-memory.json` | 已访问区块、首次见到的方块/实体/群系、地标、技能统计、目标历史、笔记 |

删除 `data/` 即可从零开始。

## 11. 目录

```
src/
├─ adapter/      GameAdapter 接口 + Mineflayer 实现（上层不直接碰 mineflayer）
├─ arbiter/      动作仲裁器（planVersion、取消、抢占、动作守卫）
├─ brain/        executive（异步规划与调度）、reflex（反射层、卡死检测）
├─ perception/   感知摘要器（结构化 → 紧凑 JSON，发现新事物）
├─ planner/      LLM 适配、prompt、计划校验、规则目标
├─ skills/       explore / gather / goto / craft / eat / flee / defend / wander / look_around / unstuck
├─ memory/       JSON 世界记忆（下一阶段换成 SQLite）
└─ observer/     RCON、自动旁观、指标、控制台服务器
public/          dashboard.html、overlay.html
tests/           离线测试（FakeAdapter 模拟世界）
scripts/         check-llm、check-rcon
```

## 12. 已知限制与下一步

- **只支持原版协议内容**：Create 需要走设计文档里的“服务端 Mod 假玩家”路线，只需替换 `GameAdapter`。
- 技能是 MVP 级别：没有建造、熔炼、夜间庇护所、睡觉，战斗也只是简单近战。下一批建议加 `prepare_for_night`、`smelt`、`place_torch`。
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
