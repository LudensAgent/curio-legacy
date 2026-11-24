# Curio Legacy

<p>
  <img src="https://img.shields.io/badge/status-archived%20%2F%20unmaintained-lightgrey.svg" alt="Status: Archived / Unmaintained">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/minecraft-1.20.1-62B47A.svg" alt="Minecraft Version">
  <img src="https://img.shields.io/badge/node-22_LTS-339933.svg" alt="Node.js Version">
  <img src="https://img.shields.io/badge/typescript-5.6-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/mineflayer-4.20+-DBBE5B.svg" alt="Mineflayer">
</p>

English | [简体中文](README.zh-CN.md)

> [!WARNING]
> **Archived / Legacy Implementation**: This repository (`curio-legacy`) preserves the legacy implementation of Curio for archival and reference purposes. It is **no longer maintained or updated**—no further development, bug fixes, or feature updates will be made here.

An autonomous curiosity-driven Minecraft agent for **Minecraft Java 1.20.1**, built with
Mineflayer, OpenAI-compatible LLMs, non-X-ray raycast vision, persistent 3D spatial memory,
and a local Web dashboard.

Curio is designed so the agent learns to survive, build, explore, and progress through
observation, knowledge lookup, experimentation, reflection, and self-authored skills—rather
than following a developer-hardcoded playthrough script. The codebase provides a reliable,
composable body and feedback loop; goals, strategies, and learned skills belong to the agent.

## Features

- **Structured vanilla protocol**: connects to a vanilla (or Paper / Fabric) 1.20.1 server via Mineflayer as a regular player—perceiving blocks, entities, inventory, lighting, time, and biomes directly without screenshots or vision models.
- **Non-X-ray AI vision**: simulates a raycast field of view with occlusion, light levels, water/leaf penetration, and a hearing radius (`src/perception/vision.ts`). Raw X-ray queries are blocked (`NO_XRAY`); observed resources and landmarks persist in memory.
- **Human-like mind loop**: organizes play into multi-step activities (`src/mind/`), thinks asynchronously while acting ("think while act"), switches between lightweight *glance* and full *deliberate* reasoning, maintains mood/agenda/diary, and reflects between activities.
- **Self-learned behavior & code skills**: combines an on-demand local Java 1.20.1 knowledge base (`knowledge/`) with a skill book (`skills/`). The agent writes behavior triggers and sandboxed JavaScript code skills (`src/codeskills/`), validates candidates through live trials, and improves failing skills automatically.
- **Persistent 3D spatial & episodic memory**: stores observed 3D voxels, landmarks, portals, and exact container ledgers in local SQLite (`curio-minecraft-3d-memory`), with optional [Hindsight](docs/memory-hindsight.md) integration for long-term episodic consolidation and cue-based recall.
- **Any OpenAI-compatible LLM**: works with OpenAI, DeepSeek, Ollama, LM Studio, or any `/chat/completions` endpoint, with streaming support, prefix-cache-friendly prompts, optional dedicated coder model, and a zero-key `mock` mode for offline verification.
- **Local Web dashboard & spectator observation**: loopback-only dashboard (`127.0.0.1:3001`) showing real-time mind state, skills, raycast vision/depth map, memory, events, streaming LLM calls, and `.env` editing, plus RCON auto-`/spectate` and optional [Curio Observer](https://github.com/LudensAgent/Curio-Observer) first-person HUD integration.

## How it works

![Curio architecture: Minecraft 1.20.1 server, OpenAI-compatible LLMs and optional Hindsight memory, Curio Agent runtime, and local dashboard / Curio Observer](docs/images/architecture.svg)

## Requirements

- **Node.js 22 LTS** (minimum `>= 20.12`; `>= 22.21` or `>= 24.5` if using `--use-env-proxy`)
- **Java 17+** (for running a Minecraft 1.20.1 server)
- **Minecraft Java Edition 1.20.1 client** (optional, for spectating)
- **Docker** (optional, only required when enabling Hindsight episodic memory)

## Quick start

### 1. Start a local Minecraft 1.20.1 server

1. Prepare a vanilla `server.jar` (or Paper / Fabric 1.20.1 server). **Do not install content mods that require client-side sync** (such as Create), or Mineflayer will be rejected.
2. Run once to generate config files, then set `eula=true` in `eula.txt`.
3. Update key fields in `server.properties`:

```properties
online-mode=false          # Bot connects in offline mode; keep on localhost/LAN only
enable-rcon=true
rcon.port=25575
rcon.password=replace-with-a-long-random-password
server-port=25565
spawn-protection=0         # Allow the bot to mine near world spawn
difficulty=easy
```

4. Launch the server:

```bash
java -Xmx2G -jar server.jar nogui
```

> Use a dedicated test world rather than a personal survival save.

### 2. Install and run Curio

```bash
npm install
cp example/.env .env        # Windows PowerShell: copy example\.env .env
npm test                    # Offline unit tests (no Minecraft server required)
npm start                   # Or run with auto-restart supervisor: npm run supervise
```

Open the local dashboard at <http://127.0.0.1:3001>.

For layered configs (shared `.env` + environment override `.env.local` / `.env.test`):

```bash
cp example/.env.local .env.local
npm run start:local         # Runs via supervisor, merging .env + .env.local
```

At minimum, review these fields in `.env` (or `.env.local`):

```ini
MC_HOST=127.0.0.1
MC_PORT=25565
BOT_USERNAME=Curio
OBSERVER_PLAYER=YourMinecraftName   # Leave empty to disable auto-spectate
RCON_PASSWORD=matching-server-properties-password
```

The default `LLM_PROVIDER=mock` runs without an API key so you can verify server connection, vision, spectator attach, and the dashboard first.

## Connecting an LLM

Set `LLM_PROVIDER` to any non-`mock` label (e.g., `openai`, `deepseek`, `ollama`) and configure the endpoint:

```ini
# OpenAI
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...

# DeepSeek
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-...

# Ollama (local)
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:14b
LLM_API_KEY=
```

Verify connectivity and JSON output before starting the agent:

```bash
npm run check:llm
```

- Set `LLM_JSON_MODE=false` if your model does not support `response_format: { type: "json_object" }`.
- Configure `CODER_LLM_MODEL` / `CODER_LLM_BASE_URL` / `CODER_LLM_API_KEY` to use a stronger background model for forging and improving code skills (defaults to `LLM_*`).
- If an HTTP(S) proxy is needed, set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY=localhost,127.0.0.1,::1` in `.env` and launch with `npm run start:proxy` or `npm run supervise:proxy`.

## Dashboard & observation

### Local Web Dashboard

Served on `127.0.0.1:3001` (loopback-only):

- **Live status & controls**: health, hunger, coordinates, inventory, active goal/activity, current thought, pause/resume, replan, operator suggestion, auto-spectate toggle, emergency surface rescue, set dawn, give items, and clear nearby entities.
- **Inspection tabs**:
  - **Observer**: [Curio Observer](https://github.com/LudensAgent/Curio-Observer) HUD layout, adaptive camera, dark-area brightening, and real-time LLM token/spend breakdown.
  - **Learning**: composite score curve, milestone timing per life, and harvest ledger.
  - **Mind**: thought stream, agenda, mood, know-how, diary, experiments, and supply budget.
  - **Skills**: learned behavior/code skills, win/loss stats, manual curation, enable/disable, and cleanup.
  - **Vision**: live raycast camera & depth map, seen and heard entities.
  - **Memory**: per-dimension memory summary, landmarks, containers, and spatial status.
  - **Events / LLM Calls / Metrics / Config**: severity-filtered event stream, live streaming LLM prompt/reasoning/response inspector, and `.env` editor (secrets are never sent back to the browser).

### In-game spectator & chat commands

1. Join the server with a 1.20.1 client and configure `OBSERVER_PLAYER` + `RCON_PASSWORD`.
2. Curio automatically attaches your client via `gamemode spectator` and `/spectate`, reattaching after deaths, respawns, or dimension changes. Test RCON directly with `npm run check:rcon`.
3. Admin players (`OBSERVER_PLAYER` and `ADMIN_PLAYERS`) can control the agent in chat:
   - `!pause` / `!resume` / `!replan` / `!status`
   - `!goal <suggestion>` — send a goal suggestion to the mind
   - `!prefer <note>` — record a long-term player preference
   - `!feedback <projectId> <note>` — submit appearance feedback for a building project

### Curio Observer mod (optional)

Pair Curio with the [Curio Observer](https://github.com/LudensAgent/Curio-Observer) Fabric 1.20.1 client mod to render vanilla-style bot health, hotbar, live crafting/container windows, and thought captions while spectating. Curio exposes the read-only SSE feed at `/api/observer/stream` when `OBSERVER_FEED=true` (set `OBSERVER_FEED=false` to disable). See [docs/observer-mod-design.md](docs/observer-mod-design.md) for protocol notes.

## Memory, profiles & supervision

### Unattended supervision

`npm run supervise` (and `npm run start:local`) monitors heartbeats and memory pressure, automatically restarting on crashes, event-loop hangs, or near-OOM saves (writing crash reports to `DATA_DIR/logs/`). Press `Ctrl+C` to save state and exit cleanly.

### Optional Hindsight episodic memory

By default `MEMORY_PROVIDER=local` stores all state locally under `DATA_DIR/`. To enable Hindsight for long-term episodic consolidation and cue-based recall, see [docs/memory-hindsight.md](docs/memory-hindsight.md):

```bash
npm run memory:serve
npm run check:memory
```

### Maintenance commands

Stop the agent before running maintenance commands (and stop the Minecraft server before resetting the world):

| Command | Action |
|---|---|
| `npm run memory:clear` | Wipe `DATA_DIR` memories, logs, and self-learned skills, and remove the matching Hindsight bank |
| `npm run memory:reset` | Clear memories and reset `SERVER_DIR` world save (supports `-- --dry-run` preview) |
| `npm run agents:list` | List archived agent profiles |
| `npm run save` / `npm run load` | Snapshot or restore the active agent's memory, world, and config |
| `npm run agents:new -- <name>` | Archive current agent and create a fresh agent & world (`--random-seed` skips seed filtering) |
| `npm run agents:switch -- <id\|name>` | Archive current agent and switch back to an archived profile |
| `npm run world:seed -- --tiers` | Print spawn biome difficulty tiers |

## Project layout

```text
src/
├─ adapter/      GameAdapter abstraction and Mineflayer implementation
├─ arbiter/      Action arbiter (plan versioning, cancellation, preemption, guards)
├─ brain/        Reflex triggers, stuck detection, drives, and supply calculations
├─ building/     Architect sub-agent, blueprint compiler, construction, and archive
├─ codeskills/   Worker-thread VM sandbox, skill smith, improver, and curator
├─ config/       Layered .env loading and test-environment isolation checks
├─ knowledge/    Local Java 1.20.1 wiki loader and skill-book index
├─ maintenance/  Agent profile save/load, memory clear, and world reset tools
├─ memory/       World memory, container ledger, and Hindsight episodic client
├─ methods/      Parameterized method trials, recipe book, and experience miner
├─ mind/         Mind loop (self model, attention, activities, thinker, prompts)
├─ observer/     RCON spectator, metrics, spend tracking, and Web dashboard server
├─ perception/   Non-X-ray raycast vision, hearing, and structured percepts
├─ planner/      OpenAI-compatible LLM client, streaming trace, pricing, and budget
├─ projects/     Goal condition evaluation and material reservations
├─ seeds/        Spawn-biome difficulty seed picker
├─ skills/       Composable interaction, navigation, gathering, crafting, and combat skills
├─ spatial/      3D spatial memory session, checkpoint scheduler, and retention policy
└─ travel/       Portal and cross-dimension travel records
knowledge/       Objective Minecraft Java 1.20.1 wiki documents
skills/          Built-in skill manuals (architect, creatures, writing-skills)
public/          Local Web dashboard UI (dashboard.html)
scripts/         Supervisor, connectivity checks, memory, and profile scripts
tests/           Offline test suite (no Minecraft server required)
docs/            Architecture and protocol reference docs
```

## Documentation

- [AGENTS.md](AGENTS.md) — Agent capability boundaries, execution constraints, and prompt rules
- [docs/agent-capabilities.md](docs/agent-capabilities.md) — Capability scope and interface overview
- [docs/behavior-skills.md](docs/behavior-skills.md) — Behavior triggers and sandboxed code skills
- [docs/interaction-primitives.md](docs/interaction-primitives.md) — Body primitives and execution authorization
- [docs/knowledge-base.md](docs/knowledge-base.md) — Java 1.20.1 knowledge base protocol and neutrality boundaries
- [docs/memory-hindsight.md](docs/memory-hindsight.md) — Hindsight episodic memory setup and cleanup
- [docs/spatial-actions.md](docs/spatial-actions.md) — Spatial query and navigation actions
- [docs/observer-mod-design.md](docs/observer-mod-design.md) — Curio Observer client mod integration design
- [docs/test-environment.md](docs/test-environment.md) — Isolated `test` host environment guide

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:25565`**: Minecraft server is not running, or `MC_HOST` / `MC_PORT` does not match.
- **Bot kicked on join**: Verify `online-mode=false` and ensure no client-synced content mods are installed on the server.
- **Version mismatch**: `MC_VERSION` must match the server version (`1.20.1`).
- **RCON authentication failed**: Check that `RCON_PASSWORD` in `.env` matches `server.properties`, and restart the server after changes.
- **Bot cannot break blocks near spawn**: Set `spawn-protection=0` in `server.properties`.

## License

Licensed under the [MIT License](LICENSE).
