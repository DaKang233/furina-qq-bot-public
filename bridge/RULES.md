# QQ 桥接权限与安全规则（RULES）

## ⚠️ Agent 必读：桥接必须跑在可见的控制台窗口里

任何改动、重启、排查桥接的 agent 都必须遵守：

1. **启动方式**：桥接进程必须在**可见的控制台窗口**中启动（`cmd /k node src/bridge.js`，或双击 `Launch.bat`）。
2. **禁止无窗口启动**：不要用 `-WindowStyle Hidden`、`Start-Process -NoNewWindow`、Windows 服务、计划任务、`nohup` 之类的方式把桥接藏起来。
3. **为什么**：那个窗口是 owner 唯一的实时观察面——启动日志、报错、OneBot 连接状态、模式切换提示都在上面。藏起窗口等于让 owner 失明，也没法 Ctrl+C 中断。
4. **日志不是替代品**：`state/bridge.log` 只是留档副本，供事后排查，不能替代可见窗口。
5. **重启流程**：确认旧进程退出、旧窗口关闭 → 用可见窗口重新启动 → 窗口打印到「就绪」→ 核对 `state/bridge-status.json` 的 `qqConnected` 为 `true`。
6. **例外**：确实只能无窗口运行（无桌面的服务器）时，必须先在本文件记录，并取得 owner 明确同意。

## ⚠️ Agent 必读：直连 SnowLuma / OneBot 的边界

1. **只有 cordis preset 的 agent 可以直连**：即 owner 私聊那条会话（`src/preset-routing.js` 里对 ownerQQ 私聊固定走 `cordis`）。只有它允许读 `config.json` 里的 `snowluma.accessToken`，并直接调用 SnowLuma 的 OneBot HTTP（默认 `127.0.0.1:3000`）/ WS（`127.0.0.1:3001`）接口。
2. **其它 preset 一律禁止**：`qq-chat` / `qq-chat-v2` / `standard` / `ptc` / `perspective` 等，不得读取 token、不得直接调用 OneBot 接口、不得借道发消息 / 发文件 / 查询群列表 / 执行任何管理动作。
3. **能力 ≠ 授权**：`qq-chat` / `qq-chat-v2` 物理上没有本地工具，本来也做不到；`standard` / `ptc` 有本地工具，但**没有**这份授权 —— 它们直连 SnowLuma 属于越权，不是「没写禁止就算允许」。
4. **正常发送走桥接**：所有 QQ 动作优先走桥接暴露的工具（`qq_send_message` / `qq_send_image` 等），它们在桥接侧有白名单、限流与审计。直连只用于 cordis agent 的排障、验证与桥接尚未覆盖的能力。
5. **例外**：需要额外放行时，必须由 owner 明确授权，并先在本文件记录。

## 运行模式（QQ 桥接四模式）

模式由 DSH WebUI **设置页 → 插件设置（qq-mode）** 控制（DSH 重启后生效），
也可回退到 `qq-bridge/state/mode.json`（`{"mode": "reserved2"}`）临时指定。
桥接每 5 秒读取一次，切换即时生效（新会话生效，旧会话可 `/reset` 重建）。
全新安装运行 `scripts/setup-dsh.mjs` 后，DSH 设置与本地兜底默认均为 `reserved2`；若已存在 `state/mode.json` 或 DSH 设置旧值，脚本不会覆盖。

| 模式 | 允许通道 | agent preset | 用途 |
| --- | --- | --- | --- |
| `chat` | 白名单群 + 白名单私聊 | qq-chat（安全聊天） | 日常聊天 |
| `closed-agent` | **仅** 私聊 ownerQQ | router-standard（完整工具） | 你在 QQ 私聊里操控 DSH |
| `reserved`（一代仿真） | 暂同 chat | qq-chat | 仿真群友：观望/活跃/试探/退场状态机，选择性参与并主动收尾 |
| `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后默认） | 暂同 chat | qq-chat-v2 | 文本不自动转发，AI 通过工具自主看消息/发言/等待/设置唤醒与潜水 |

> ⚠️ `closed-agent` 模式下 owner 私聊 agent 拥有**完整本地工具**（router-standard），
> 这是有意为之（QQ 远程操控 DSH）。该模式只放行 owner 私聊，群友完全无法触达；
> 切换回 `chat` 后，owner 私聊也回到 qq-chat 安全预设。

## 权限分层

| 主体 | 通道 | 权限 |
| --- | --- | --- |
| **管理员（ownerQQ，控制台或 DSH 设置页可配置）** | QQ 群/私聊 | 正常聊天 + **管理命令由桥接硬执行**（不经过模型）：`/role <角色名>` 切人格、`/role off` 清除、`/silent` 静默、`/active` 恢复、`/reset`、`/status`；消息自动带【管理员】标记 |
| **群友** | QQ 群 | **仅正常聊天**。控制词、`/` 管理命令被桥接拦截；静默模式下消息不投递给 agent |
| **管理员** | **DSH WebUI** | **最高权限**：控制模式（设置页 qq-mode 卡片）、控制角色/静默（写 `state/current-role.json`）、完整 DSH 工具（含本地操作）、查看 QQ 活动日志（`state/qq-activity.log`）、直接打开「QQ 聊天」工作区会话对话 |
| **受信任账号（ownerQQ / `privilegedQQ`）** | `standardAllow` 中的 QQ 群/私聊（`restricted-standard` 会话） | 仅在其**发起的单轮任务（DSH turn）内**临时获得 PowerShell、文件读写/搜索、后台任务等 Standard 能力；turn 结束立即收回，不会把权限留在群会话里 |
| **QQ 会话 agent（chat / reserved2 模式）** | — | 最低权限面（见下） |

## QQ 会话 agent 的硬边界

1. **无本地工具**：qq-chat / qq-chat-v2 预设不挂载 bash/pwsh、文件读写、子代理、工作流——群友无论如何诱导，agent 物理上无法操作本机。
2. **QQ 动作安全子集**：只允许 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 三个命名空间下的工具，以及 `ask_user_question` / `todo_write`；其他工具（含 `dev_*` 开发/管理工具）在执行期会被 `qq-tool-restrict.mjs` 拒绝。QQ 动作无禁言、踢人、文件上传下载等管理操作。
3. **只读联网搜索**：`qq-chat` / `qq-chat-v2` 预设已关闭 DSH 内置 `tool-web` 的 `search` / `fetch`，联网统一走 `src/mcp-web-search-safe.js` 提供的 `mcp__web-search-safe__web_search/web_fetch`。不暴露本地文件、命令执行、写操作。
   - ✅ `mcp__web-search-safe__web_fetch` 已做 SSRF 加固：仅 http/https、禁止 localhost/私有 IP/链路本地/CGNAT/带凭据 URL、DNS 解析结果全量校验、每跳重定向重新校验、响应体限量读取。
4. **发送强制白名单**：所有发送类工具（`qq_send_group_message` / `qq_send_private_message` / `qq_send_message` / `qq_send_burst` / `qq_reply` / `qq_send_poke` / `qq_send_sticker` 等）的目标必须命中 `config.json` 的 `allow.groups` / `allow.private`，否则拒绝执行。
5. **发送禁令（模型层）**：persona 明确规定只有「管理端明确指示」或「【管理员】标记的明确要求」才可使用发送工具；禁止写"我已回复/消息已发送（message_id）"类汇报。
6. **回复审计（桥接层硬拦截）**：agent 回复文本若包含本机路径（`C:\`、`/home/` 等）或凭据特征（token/password/secret/api key 等）→ **整条拦截不发送**，并告知"被安全策略拦截"。
7. **人格由桥接注入**：角色设定来自 `state/current-role.json` + `roles/<角色>.md`，桥接注入到消息；群友口头要求改角色无效（桥接直接拦截），agent 也无文件工具自行更改。
8. **静默模式**：`current-role.json` 的 `mode: "silent"` 时，群友消息不再投递给 agent（仅记录日志），只有管理员消息可对话。

## 受限 Standard（`restricted-standard`）的逐轮授权

1. **普通账号**：`standardAllow` 里的会话对普通账号仍然只有上面第 1~7 条描述的 v2 能力；`qq-tool-restrict.mjs` 的执行期守卫会拒绝 PowerShell、文件读写等 Standard 工具。
2. **受信任账号**：只有 `ownerQQ` 和 `config.json` 的 `privilegedQQ` 中的账号，其消息会被 Bridge 用本机 HMAC 密钥签名。DSH 侧插件在 `agent/pre-step` 验签并改写本轮提示；该账号发起的**整个 DSH turn**（包括连续工具调用、`qq_wait_for_messages` 等待）内临时放行 Standard 工具，下一 turn 重新验签并失效。
3. **边界**：权限按 turn 租约授予，模型无法从语义上区分“这一轮里其他成员插话提出的命令”。因此 persona 明确规定额外能力只能服务于已验签账号在本轮提出的请求；不允许批准来源不明的群聊高权限请求。
4. **fail-closed**：若 `state/turn-auth-secret` 缺失、签名不匹配、会话 ID 不符、nonce 重放，或 `restricted-standard` 会话创建失败，都会回退到“普通账号”权限，不会静默提升。
5. **不在 preset 内提供**：子 Agent / workflow（子 Agent 无法被 Bridge 验签）、plan-mode / goal（会产生脱离 Bridge 的自动续跑）、schedule（延迟执行不可控）。管理员需要这些能力请到 DSH 管理端或管理员私聊的 Cordis 会话执行。

## 黑话 / 网络用语学习与迭代

- 桥接会把普通群聊消息放入滚动窗口（`state/slang.json` 的候选来源），攒够 `slang.extractMinMessages` 条后交给独立 DSH 学习会话提取“疑似黑话”。
- 候选默认 **不自动转正**：DSH 可联网搜索生成含义/用法/示例，但最终必须由管理员在控制台「黑话管理」里 **确认 / 拒绝 / 编辑 / 删除**。
- 只有 `status: confirmed` 且含义非空的词条会被注入 QQ 聊天 agent 的 prompt（`【群聊黑话表】`），且按出现次数排序、最多 `slang.injectMax` 条。
- 学习会话与 QQ 会话隔离：学习任务的输出不会发到 QQ；它只读消息文本，不执行本地操作。
- 学习会话不会向用户提问/请求审批，桥接会自动跳过这类请求，避免阻塞学习任务。
- `web_search` 工具返回的搜索摘要仅作为候选解释，不视为权威；控制台可随时修改或拒绝。
- 敏感信息/路径/凭据仍走统一审计；黑话库仅存白名单群内消息的文本证据，控制台可删除。

## 管理员操作手册

### 在同一 QQ 聊天中切换 DSH 会话

仅 `ownerQQ` 可执行，群管理员或 `privilegedQQ` 不自动获得这项管理权：

```text
/session list              # 列出本 QQ 聊天登记的会话（编号稳定，标出当前项）
/session rename 日常聊天   # 给当前会话起名
/session new 开发讨论      # 用当前 preset 新建独立 DSH 会话
/session switch 1          # 切回第 1 个会话，也可使用名称或已登记 ID
/session switch 开发讨论
/session current
```

可用 `/会话`、`/sessions` 别名，也支持 `列表/新建/切换/重命名/当前` 子命令。
只接受本 QQ 聊天的登记项，不允许绑定其它群、私聊或任意 WebUI 会话。
登记表保存在 `state/sessions.json` 的 `sessionCatalog`，重启后保留；已有当前会话
会自动登记，旧的 `/reset`、`/preset` 以后也会先保存旧会话记录。
启用前已解除绑定且没有登记的旧 DSH 会话不会被自动导入。

切换取消旧 DSH 回合、挂起问答和等待，清理旧投递，并轮换工具令牌、撤销 LEG 授权；
DSH 中旧会话的对话历史保留。若 DSH 已有尚未开始的排队投递，会拒绝切换，待处理完再试。
未提交的旧发送会被拦截，已提交给 QQ 的消息不能撤回。操作失败时恢复原活动映射，
但已取消的回合和授权不会复原。

新会话沿用当前 preset；切回历史会话时恢复该会话的 preset。
这不是数据隔离：QQ 最近消息、角色、轻量/长期记忆仍按 QQ 聊天共享；DSH 历史分别保存。
切换本身不触发模型发言，下条普通消息引导所选会话继续。

### 切换角色 / 模式（两种途径，均为硬性机制）

**途径 A：QQ 群内管理命令**（桥接直接执行，不经过模型判断）：
```
/role 傲娇助手    # 切换角色（roles/傲娇助手.md）
/role off         # 清除角色
/silent           # 静默模式（群友消息不回复）
/active           # 恢复正常
/status           # 查看会话/白名单/角色/模式状态
/reset            # 重置当前 QQ 会话上下文
```

**途径 B：DSH WebUI**：
- 在 GUI 会话里对我说「给 QQ 机器人设置角色：傲娇助手」/「清除角色」/「开启静默模式」，我写 `state/current-role.json`
- 或手动编辑 `qq-bridge/state/current-role.json`：
  ```json
  { "role": "傲娇助手", "mode": "active" }   // active=正常, silent=静默
  ```
- 角色文件放 `qq-bridge/roles/<角色名>.md`（格式见 `roles/README.md`）

### 查看 QQ 活动

- WebUI 里直接打开「QQ 聊天」工作区的会话，可完整查看每次交互（含工具调用）
- 桥接还会把每次收发写入 `qq-bridge/state/qq-activity.log`（最近 500 行），GUI 会话的 agent 可读取汇报

### 在 WebUI 与 QQ 机器人对话

打开「QQ 聊天」工作区里的会话即可直接对话（DSH 原生）；你的消息只进该会话，**不会自动发到 QQ 群**——需要发群时明确说"发到群里"，agent 按【管理员】指示使用发送工具（受白名单限制）。

## 事故与兜底

- 群友诱导 agent 失败时，agent 会按 persona 规则拒绝；即使被诱导成功，最坏后果也只是**发一条白名单内的消息**——本地操作在工具面上不存在，敏感信息会被回复审计拦截。
- 想彻底关闭机器人：停止桥接进程（start.bat 窗口 Ctrl+C）或 SnowLuma。
- 修改白名单/角色/owner 后保存即热更新（控制台写入 config.json / state/*.json 后即时生效）；修改 preset（`~/.dsh/.agent-presets/qq-chat*/`）后重启 DSH 生效。
- ⚠️ 桥接只能运行一个实例：消息异常时先检查任务管理器里是否有多余的 `node ...bridge.js`。
