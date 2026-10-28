# 芙宁娜 QQ 机器人 · furina-qq-bot

[中文](#中文) · [English](#english)

> 一个跑在 QQ 群里、由 DeepSeek Harness（DSH）的 agent 驱动的 AI 群友。人格：**芙宁娜**。
> 技术路线：**`bridge/`** —— QQ ↔ DSH 桥接（Node.js）。旧的 AstrBot 插件路线已归档，不再演进。

---

## 中文

### 这是什么

不是客服式问答机器人。目标是**混在群里像个真人**：会看消息、会挑着接话、会发表情包、看得见图、记得住人，也会判断「这句不值得回」然后继续潜水。

它现在这样做：

- **QQ 侧**：SnowLuma（第三方 QQ 网关）以 OneBot v11 提供 WebSocket（收）与 HTTP API（发）。
- **DSH 侧**：`bridge/` 把 QQ 消息投给一个 DSH agent 会话，再把 agent 的动作发回 QQ。agent 拿到的是**工具**，不是一条转发管道——说什么、分几条发、要不要引用、什么时候潜水，由它自己判断。
- **人格与边界**：角色卡、运行模式、白名单、工具白名单由桥接注入并强制执行；群友在群里怎么诱导都改不了。
- **可观察**：本地控制台 `http://127.0.0.1:3100` 看状态、切模式、改角色、看活动日志；DSH 里能直接打开「QQ 聊天」工作区看每个回合的工具调用。

### 架构

```
QQ 客户端
   │  OneBot v11（WS 收 / HTTP 发）
   ▼
SnowLuma（QQ 网关，第三方）
   │  ws://127.0.0.1:3001      http://127.0.0.1:3000
   ▼
bridge（bridge/src/bridge.js）
   │  DSH 0.2.1 Web API + /api/remote.mux 事件流
   ▼
DSH Web（默认 http://127.0.0.1:3081）
   └─ agent 会话（preset：qq-chat / qq-chat-v2 / restricted-standard / standard-furina）
        └─ MCP：snowluma（安全 QQ 工具）/ snowluma-host（网关进程管理）/ web-search-safe（只读联网）/ leg（本地执行网关）
```

常用端口（全部只绑回环）：

| 端口 | 归属 |
|---|---|
| 3081 | DSH Web API / WebUI |
| 3001 / 3000 | SnowLuma 的 OneBot WebSocket（收）/ HTTP API（发） |
| 3100 | 桥接自带控制台 |
| 3210 | Local Execution Gateway daemon（本地执行，走票据） |

各层职责：

| 层 | 位置 | 职责 |
|---|---|---|
| QQ 网关 | SnowLuma（外部安装） | 登录 QQ、OneBot v11 协议端 |
| 桥接 | `bridge/src/bridge.js`（约 1.2 万行单文件） | 消息接入、白名单/模式、会话映射、DSH 投递、发送链、控制台 API、审计 |
| DSH 客户端 | `bridge/src/dsh-client.js` | 官方 Connection 信封、`/api/remote.mux` 多路流、turn 收集 |
| agent 工具 | `bridge/src/mcp-snowluma-safe.js`、`mcp-host-server.js`、`mcp-web-search-safe.js` | 以 MCP server 形式暴露给 agent，只给安全子集 |
| 本地执行网关 | `bridge/src/leg/` | 只监听 127.0.0.1:3210；owner 轮次的本地执行请求按票据二次校验后由 daemon 执行 |
| 控制台 | `bridge/public-console.html` | 单页管理台，需令牌，默认 3100 端口 |

### 一条消息怎么走

1. QQ 消息经 SnowLuma 进来，桥接先做**白名单/黑名单与模式检查**；`/role`、`/silent` 等管理命令由桥接直接执行（不经过模型），群友发的一律拦截。
2. 每个 QQ 会话（群/私聊）映射到一个独立 DSH 会话，统一归组到「QQ 聊天」工作区（映射存 `bridge/state/sessions.json`）。
3. 二代仿真模式下，消息**不会**被自动拼进 prompt：agent 通过 `qq_get_unread_messages` / `qq_get_recent_messages` 自己看，通过 `qq_get_prompt` 拿角色、推荐值与会话令牌。
4. agent 要说话就调发送工具（`qq_send_message` / `qq_reply` / `qq_send_burst` / `qq_send_sticker` …）。桥接在出口做**目标白名单 + 频率限制 + 敏感信息审计**，再经 OneBot HTTP 发出。
5. 不想说话就 `qq_mark_read` + `qq_set_wake_config`，把下一次唤醒条件（@、名字、关键词、提问、戳一戳、指定人、静默时长）设好。

### 四种运行模式

模式在 DSH 设置页的 **qq-mode** 卡片里切换（也可回退到 `bridge/state/mode.json`），桥接每 5 秒读取一次，新会话即时生效。

| 模式 | 允许通道 | agent preset | 用途 |
|---|---|---|---|
| `chat` | 白名单群 + 白名单私聊 | `qq-chat` | 日常聊天，文本回合结束统一发送 |
| `closed-agent` | **仅** owner 私聊 | 完整工具 preset（代码默认 `router-standard`，部分配置写作 `standard`） | 在 QQ 私聊里远程操控 DSH（完整本地工具，仅此模式） |
| `reserved` | 暂同 chat | `qq-chat` | 一代仿真：观望/活跃/试探/退场状态机，按空格分句 |
| `reserved2` | 暂同 chat | `qq-chat-v2` | **二代仿真（默认）**：不自动转发，agent 用工具自主看消息、发言、等待、潜水 |

### 四个 agent preset

preset 源在 `bridge/dsh/agent-presets/`。当前 DSH 版本从 profile bundle `@local/dsh-qq-presets` 里读它们——由 `bridge/dsh/presets-bundle/build.mjs` 生成，四个 preset 都在里面。`bridge/scripts/setup-dsh.mjs` 仍按旧的 `.agent-presets/` 目录布局安装（只含前三个），装完请在 DSH 设置页确认四个 preset 是否都出现；缺 `standard-furina` 时用 bundle 方式重新生成/注册。

| preset | 人格与能力 |
|---|---|
| `qq-chat` | 通用 QQ 聊天角色；群友可触达的最低权限面 |
| `qq-chat-v2` | 二代仿真专用：文本不自动转发，靠工具自主收发（当前默认） |
| `restricted-standard` | 保留二代仿真能力；普通账号只有 v2 工具，**受信任账号**（owner / `privilegedQQ`）发起的单轮任务里临时获得 Standard 本地能力，turn 结束即失效 |
| `standard-furina` | 芙宁娜版受限 Standard：本地能力**只认 owner**，统一走 Local Execution Gateway 二次校验 |

> 逐轮授权是安全边界而不是提示词：桥接用本机 HMAC 密钥给受信任账号的消息签名，DSH 侧在 `agent/pre-step` 验签；签名缺失、不匹配、会话不符、nonce 重放、preset 创建失败，一律**回退到普通账号权限**（fail-closed）。

### 仓库结构

| 目录 | 内容 | 状态 |
|---|---|---|
| [`bridge/`](bridge/) | QQ ↔ DSH 桥接：主程序、MCP server、预设、控制台、脚本 | **主线，持续更新** |
| [`bridge/docs/`](bridge/docs/) | `PROJECT_GUIDE.md`（内外核说明书）、`DSH_SETUP.md`（DSH 端安装） | 主线文档 |
| [`bridge/dsh/agent-presets/`](bridge/dsh/agent-presets/) | 四个 agent preset 模板 | 主线 |
| `SnowLuma/`、`SnowLuma-*.zip` | 本机安装的 QQ 网关与安装包（含 token 与聊天数据） | **不入库**，自行下载 |
| [`plugins/`](plugins/) | 59 个 AstrBot 插件（旧路线全部能力） | 归档，不再演进 |
| [`console/`](console/)、[`mobile-controller/`](mobile-controller/)、[`desktop-controller/`](desktop-controller/)、[`server/`](server/)、[`deploy/`](deploy/) | 旧路线的安卓/Windows 控制台、服务端看护与部署清单 | 配套旧路线，非 bridge 所需 |
| [`node-studio/`](node-studio/) | 行为节点的可视化离线原型（与机器人完全隔离） | 独立实验项目 |
| [`docs/`](docs/) | 54 份技术文档：部署手册、根因分析、实测记录 | 旧路线实测记录，仍有参考价值 |

### 快速开始（Windows 单机）

前置：

1. 一个 Windows 10/11 桌面（桥接必须跑在**可见的控制台窗口**里——那是 owner 唯一的实时观察面）。
2. Node.js ≥ 22.13。
3. 已安装 **DeepSeek Harness**（下面第 4 步会启动它，默认 `http://127.0.0.1:3081`）。
4. 一个能跑的 **SnowLuma**，并在其 WebUI 里开启 OneBot **WebSocket 服务端**（默认 3001）和 **HTTP API**（默认 3000）。

步骤（在仓库根目录执行）：

```powershell
# 1. 装桥接依赖（postinstall 会修补 @snowluma/sdk 的 ESM 打包问题）
cd bridge
npm install

# 2. 生成配置并填写：DSH 地址、OneBot 地址、ownerQQ、白名单
copy config.example.json config.json

# 3. 安装 DSH 端（preset + MCP server + qq-mode 控制台插件，并写入默认模式 reserved2）
node scripts/setup-dsh.mjs

# 4. 启动 DSH Web（公开仓库不附带启停脚本；用你自己的方式启动 qqbot 预设，监听 3081）

# 5. 启动桥接（在可见窗口里跑；崩溃后由 restart.bat 一键重启）
npm start
```

看到 `SnowLuma 已连接` 即成功。控制台地址 `http://127.0.0.1:3100`，令牌在 `config.json` 的 `consoleToken`（留空时自动生成并打印在启动日志、保存到 `bridge/state/console-token`）。

`config.json` 必须填对的关键项：

| 字段 | 说明 |
|---|---|
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3081` |
| `dsh.provider` / `dsh.model` | 会话使用的模型；填你 DSH 设置页里可用的模型，选择失败只打日志 |
| `snowluma.wsUrl` | OneBot **WebSocket** 地址（收消息） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（发消息）；别填成 WS 端口，否则报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，没配置就留空 |
| `ownerQQ` | 管理员 QQ 号；`/role`、`/silent` 等管理命令只认它 |
| `allow.private` / `allow.groups` | 白名单；**先填再上线**（`allowAllWhenEmpty` 为 true 时留空等于全部放行） |
| `standardAllow.*` / `privilegedQQ` | 哪些会话/账号可使用「受限 Standard」的轮次本地能力 |
| `consolePort` / `consoleToken` | 本地控制台端口与令牌 |

自测（不需要 SnowLuma / QQ，只验 DSH 链路）：

```bash
npm run self-test
```

> 公开仓库**不附带**本机的 DSH 启停脚本（`start/stop/restart-qqbot-webui.ps1` 等已移除，避免把本机路径和内网信息带进公开代码）。桥接的 `/dshstart`、`/dshstatus`、`/dshrestart` 依赖这些脚本：缺脚本时会直接回复「找不到脚本」，需要这些能力请用你自己的启停方式，或在本机补回同名脚本。

### 机器人能做什么

工具都挂在 `mcp__snowluma__` 命名空间下（只读 + 安全发送子集，没有禁言/踢人/文件上传下载）：

- **收发**：`qq_send_message`（支持数组分条）、`qq_send_burst`、`qq_reply`（引用回复）、`qq_send_poke`（戳一戳）。
- **看消息**：`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_group_history`、`qq_get_message_detail`、`qq_get_active_members`、合并转发展开。
- **图片与表情**：`qq_get_message_images`、`qq_list_stickers` / `qq_send_sticker`（收藏表情）、`qq_list_local_stickers` / `qq_send_local_sticker`（本地表情包库，支持分类与备注）、`qq_collect_sticker`。
- **节奏**：`qq_wait_for_messages`（含 `quietMs` 等对方说完）、`qq_set_wake_config`（唤醒条件/潜水时长）、`qq_mark_read`（已读并收尾）。
- **记忆与黑话**：`qq_memory_append` / `qq_memory_query` / `qq_memory_remove` / `qq_memory_clear`；`qq_slang_query` / `qq_slang_submit`（黑话由管理员在控制台确认后才生效）。
- **联网**：`mcp__web-search-safe__web_search` / `web_fetch`（只读、带 SSRF 防护），供 agent 查梗、查资料。

### 安全边界

把 agent 接进 QQ 等于把账号控制权交给模型，所以边界必须由代码强制，而不是写在提示词里：

1. **目标白名单**：所有发送类工具的目标必须命中 `allow.groups` / `allow.private`，否则拒绝执行。
2. **工具面隔离**：`qq-chat` / `qq-chat-v2` 预设**物理上没有** bash/pwsh、文件读写、子代理、工作流；`tools.restrict` 隐藏 + `tools.guard` 执行期兜底，连将来的 `dev_*` 工具也会被拒绝。
3. **逐轮授权**：`restricted-standard` / `standard-furina` 的本地能力只存在于 Bridge 验签通过的**单个 DSH turn** 内；签名/会话/nonce 任何一项不对都 fail-closed。
4. **本地执行网关**：`bridge/src/leg/` 的 daemon 只监听 `127.0.0.1`，只接受带有效票据的请求；owner 的本地操作经二次校验，路径与命令都要过检查。
5. **出口审计**：回复里出现本机路径或凭据特征（token/password/secret/api key 等）→ 整条拦截不发送。
6. **只读联网**：DSH 内置 web 工具在 QQ 会话里被关掉，统一走 `web-search-safe`；SSRF 防护覆盖私网/环回/链路本地/CGNAT、DNS rebinding 与逐跳重定向复验。
7. **人格不可被改**：角色由桥接注入（`bridge/state/current-role.json` + `bridge/roles/<角色>.md`），群友说「改角色」只会被拦掉。仓库里只带示例角色卡（`小鲸鱼.md`、`傲娇助手.md`）；当前在用的芙宁娜角色卡含本机个人设定，走 `bridge/.gitignore` 不入库。
8. **单实例 + 可见窗口**：桥接有单实例锁，重复启动会被拒；不允许无窗口启动（详见 [`bridge/RULES.md`](bridge/RULES.md)）。
9. **明文风险**：桥接控制台是**本地明文 HTTP**，令牌等同于管理权限，别把 3100 端口暴露到公网。

### 运维

- **重启桥接**：`restart.bat`（自动杀旧实例 → 清锁 → 重新启动）；Linux 用 `restart.sh`。
- **改配置**：改 `config.json` / `roles/` / `state/current-role.json` 后重启**桥接**；改 preset 或 MCP 配置后重启 **DSH**。
- **日志**：`bridge/state/bridge.log`（留档）、`qq-activity.log`（最近收发）、DSH 侧 `logs/`。
- **DSH 重启不用动桥接**：桥接每 5 秒探活，DSH 恢复后自动补投；期间消息入队缓存（每会话最多 50 条）。

常见问题：

| 现象 | 先查 |
|---|---|
| 启动即报「已有实例在运行」 | 任务管理器里多余的 `node ...bridge.js`；或 `state/bridge.lock` |
| MCP 工具报 HTTP 426 | `snowluma.httpUrl` 填成了 WebSocket 端口 |
| 群里没反应 | 控制台看 `qqConnected` / `dshReady`；再看白名单与当前模式 |
| 群友发了消息 agent 没看见 | `reserved2` 下文本不自动转发，agent 要靠 `qq_get_unread_messages` 主动看 |
| 改 preset 不生效 | 重启 DSH，不是重启桥接 |

测试与自检（`bridge/package.json` 的 `scripts`）：

```bash
npm run self-test          # DSH 链路自测
npm run test-routing       # preset 路由
npm run test-turn-auth     # 逐轮授权
npm run test-turn-auth-guard
npm run test-error-routing
npm run test-stickers
npm run test-slang
node scripts/verify-install.mjs   # 安装完整性检查
```

### 已知限制

- **回复是回合制的**：agent 一轮结束后一次性发送，不做流式逐字转发；超长回复自动分段。
- **图片/语音/视频以占位文本进入上下文**：图片可以再用 `qq_get_message_images` 真正看到；语音/视频能不能读取决于你接入的能力，桥接本身不做转写。
- **Markdown 会被压成纯文本**（链接保留 `文字 (url)`），因为 QQ 不渲染 Markdown。
- **依赖 DSH 协议**：桥接用的是 DSH 0.2.1 的 `remote.mux` 与 Connection 信封，DSH 大版本升级可能需要跟着改。
- **QQ 账号有风控风险**：掉线后按 SnowLuma 的提示重新登录/扫码。桥接会自动重连 OneBot 连接，但账号本身的登录状态不归桥接管。
- **明文控制台**：见上，令牌泄露等于管理权泄露。
- **配置模板不是全集**：`config.example.json` 是脱敏样例，比真实配置少一些可选段（如 `leg`、`tts`、`song`、`image`）；以字段表和源码为准。

### 文档

| 文档 | 内容 |
|---|---|
| [`bridge/docs/PROJECT_GUIDE.md`](bridge/docs/PROJECT_GUIDE.md) | 桥接内外核说明书：数据流、配置全解、调试与改进指南 |
| [`bridge/docs/DSH_SETUP.md`](bridge/docs/DSH_SETUP.md) | 在另一台设备/新环境安装 DSH 端（preset、MCP、控制台插件） |
| [`bridge/RULES.md`](bridge/RULES.md) | 权限与安全规则：四模式、权限分层、硬边界、管理员操作手册 |
| [`bridge/README.zh.md`](bridge/README.zh.md) | 桥接的中文详版说明（架构、配置、运行与运维） |
| [`docs/`](docs/) | 旧路线 54 份技术文档：部署手册、根因分析与实测记录（很多结论对 bridge 同样成立） |

### 旧路线：AstrBot 插件（已归档）

改走 bridge 之前，这个仓库是一套 AstrBot 插件方案：59 个插件分别负责说话质量、多模态、记忆与群管，配合安卓/Windows 控制台和服务端看护。这条路线的代码、文档和实测数据都还在：

- [`plugins/`](plugins/)：59 个 AstrBot 插件（最后更新 2026-09）。
- [`console/`](console/) / [`mobile-controller/`](mobile-controller/) / [`desktop-controller/`](desktop-controller/)：旧路线的手机与桌面控制台。
- [`server/`](server/) / [`deploy/`](deploy/)：NapCat 看护脚本与部署清单。
- [`docs/`](docs/)：从「答非所问」到「识图档位顺序」的完整排查记录，多数教训与具体框架无关。

这些目录**不再随主线更新**，保留是为了可查阅、可复用；新功能和修复只进 `bridge/`。

另外两点说明：仓库原名 **DaFeiYu QQ Bot**（`dafeiyu-qq-bot`），改这条路线时一并更名为 `furina-qq-bot`；根目录还散落着 13 个 `dsh-*` 目录，它们是 `plugins/dsh-*` 的**不完整历史副本**（同名但文件不全，可忽略），`.github/workflows/` 里的两个工作流也只负责打包旧控制台，bridge 目前没有 CI。

### 隐私与合规

- 运行配置与状态全部在 `.gitignore` 里（`config.json`、`bridge/state/`、`SnowLuma/`、`logs/`、`backups/`、`browser-profile/`）——里面有 accessToken、QQ 号、聊天原文与本机路径，**绝不入库**。
- 本项目（DaKang233）提交的源码与历史已脱敏：本机路径、内网 IP/SSH 指纹、owner QQ 号、本机专用启停脚本都已替换或移除。**上游（nanbengxian-cyber）的旧路线历史保持原样**——其中的旧文档与测试可能仍包含真实 QQ 号/群名片，不属于本次清理范围。
- SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系；使用前请阅读其 EULA 与《QQ 用户协议》，仅用于学习与技术研究。

### 许可

MIT，见 [LICENSE](LICENSE)。

---

## English

### What this is

An AI group member living in a QQ group, driven by a **DeepSeek Harness (DSH)** agent. Persona: **Furina**.

The technical route is **`bridge/`** — a Node.js bridge between QQ (OneBot v11, via SnowLuma) and a DSH agent session. The older AstrBot plugin route is archived and no longer developed.

### Architecture

```
QQ  ──OneBot v11──►  SnowLuma (QQ gateway)
                        │  ws://127.0.0.1:3001 / http://127.0.0.1:3000
                        ▼
                     bridge (bridge/src/bridge.js)
                        │  DSH 0.2.1 Web API + /api/remote.mux
                        ▼
                     DSH Web (http://127.0.0.1:3081)
                        └─ agent session (preset: qq-chat / qq-chat-v2 /
                           restricted-standard / standard-furina)
                             └─ MCP: snowluma (safe QQ tools),
                                snowluma-host, web-search-safe, leg (local execution gateway)
```

Instead of forwarding text, the bridge gives the agent **tools**: read unread/recent messages, send (single or burst), quote-reply, poke, fetch images, manage stickers, wait for replies, set wake/sleep conditions, remember people, look up group slang, search the web. The agent decides what to say, how many messages, and when to stay silent.

### Run modes and presets

| Mode | Channel | Preset | Purpose |
|---|---|---|---|
| `chat` | allowlisted groups / DMs | `qq-chat` | plain chat |
| `closed-agent` | owner DM only | full-tool preset (`router-standard` by default) | remote-control DSH from QQ (full local tools, this mode only) |
| `reserved` | same as chat | `qq-chat` | first-gen simulation (observe/active/probe/exit state machine) |
| `reserved2` | same as chat | `qq-chat-v2` | **second-gen simulation (default)**: no auto-forwarding; the agent reads, replies, waits and dives with tools |

`restricted-standard` and `standard-furina` add **turn-scoped** local capability for a verified owner/trusted account. The bridge signs each trusted message with a local HMAC key; DSH verifies it in `agent/pre-step`. Missing/invalid signature, session mismatch, nonce replay or preset creation failure all fall back to ordinary permissions (fail-closed). `standard-furina` further restricts local execution to the owner only, routed through a loopback-only Local Execution Gateway (`bridge/src/leg/`) with ticket re-validation.

### Quick start (Windows, single machine)

Requires Node.js ≥ 22.13, an installed DSH (started in step 4) and a running SnowLuma with OneBot WebSocket (3001) and HTTP API (3000) enabled.

```powershell
# run from the repository root
cd bridge
npm install                            # postinstall patches the @snowluma/sdk ESM issue
copy config.example.json config.json   # fill DSH / SnowLuma / ownerQQ / allowlists
node scripts/setup-dsh.mjs             # install presets + MCP servers + qq-mode plugin
# start DSH Web yourself (machine-specific helper scripts are not shipped in this repo)
npm start                              # run in a visible console window
```

The bridge console is at `http://127.0.0.1:3100` (token in `config.json` or auto-generated to `bridge/state/console-token`). Run `npm run self-test` to check the DSH link without QQ.

### Security

- All send tools are restricted to the `allow.groups` / `allow.private` allowlist.
- `qq-chat` / `qq-chat-v2` sessions physically have no shell, file, subagent or workflow tools; `tools.restrict` hides them and a `tools.guard` allowlist rejects at execution time.
- Replies containing local paths or credential-like strings are blocked at the bridge.
- Web access is read-only and SSRF-hardened (private ranges, loopback, CGNAT, DNS rebinding, per-hop redirect checks).
- Roles are injected by the bridge; group members cannot change them.
- The console is plaintext local HTTP — never expose port 3100 publicly.

Details: [`bridge/RULES.md`](bridge/RULES.md) and [`bridge/docs/PROJECT_GUIDE.md`](bridge/docs/PROJECT_GUIDE.md).

### Repository layout

| Path | What it is | State |
|---|---|---|
| [`bridge/`](bridge/) | QQ ↔ DSH bridge, MCP servers, presets, console, scripts | **main line** |
| [`plugins/`](plugins/) | 59 AstrBot plugins (old route) | archived |
| [`console/`](console/), [`mobile-controller/`](mobile-controller/), [`desktop-controller/`](desktop-controller/), [`server/`](server/), [`deploy/`](deploy/) | old-route consoles, watchdog and deploy manifests | legacy |
| [`node-studio/`](node-studio/) | visual behaviour-node prototype, fully isolated | experiment |
| [`docs/`](docs/) | 54 technical documents (deployment, root-cause analyses, measurements) | reference |

### Limitations

- Replies are sent at the end of a turn (no token streaming); long replies are split.
- Images/voice/video arrive as placeholder text; the agent must call `qq_get_message_images` to actually see an image.
- Markdown is flattened to plain text for QQ.
- The bridge targets DSH 0.2.1's `remote.mux` protocol; major DSH upgrades may need matching changes.
- A QQ account can be rate-limited and dropped; recovery follows SnowLuma's prompts. The bridge reconnects OneBot, but the account login itself is not managed by the bridge.

### License

MIT — see [LICENSE](LICENSE). SnowLuma is an independent third-party project; read its EULA before use.
