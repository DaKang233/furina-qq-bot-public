# QQ ↔ DeepSeek Harness 桥接 / Bridge

把 QQ 消息接进一个 DSH agent 会话：QQ 消息变成 agent 的用户消息，agent 的回复（含提问、工具审批）发回 QQ。

Bridges QQ into a DeepSeek Harness agent session: QQ messages become agent user messages, and agent replies (including questions and tool-approval requests) go back to QQ.

> ✅ **这是本仓库当前的「主线」技术路线：QQ → DSH agent。** 旧路线（仓库根目录的 `plugins/`，AstrBot 插件）已归档，不再演进。桥接让一个带工具的 agent 直接在 QQ 上收发消息；能力更强的代价是：把 agent 接入 QQ 等于把账号控制权交给模型，安全边界必须由你自己划清（见 [`RULES.md`](RULES.md)）。
>
> ✅ **This is the repository's main route today: QQ → DSH agent.** The old route (`plugins/` at the repo root, AstrBot plugins) is archived and no longer developed. The bridge lets a tool-equipped agent send and receive on QQ directly; the price of that capability is that wiring an agent to QQ hands account control to the model, so you must draw the security boundary yourself (see [`RULES.md`](RULES.md)).

## 文档 / Docs

- [`README.zh.md`](README.zh.md) — 完整中文说明（架构、配置全解、运行模式）
- [`README.en.md`](README.en.md) — English README
- [`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md) — 内外核说明书（数据流、调试、改进指南）
- [`docs/DSH_SETUP.md`](docs/DSH_SETUP.md) — DSH 端安装
- [`RULES.md`](RULES.md) — 开发约定
- [`ANDROID-适配说明.md`](ANDROID-适配说明.md) — 在安卓上跑的适配记录

## 快速开始 / Quick start

> ⚠️ **Agent 必读**：桥接必须以**可见的控制台窗口**运行（`cmd /k node src/bridge.js` 或 `restart.bat`）。禁止 `-WindowStyle Hidden` / `-NoNewWindow` 等无窗口方式启动 —— 窗口是 owner 唯一的实时观察面。**直连 SnowLuma / OneBot** 只允许 `cordis` preset 的 agent（owner 私聊），其它 preset 一律禁止。详见 [`RULES.md`](RULES.md) 顶部「Agent 必读」。
>
> **Agent must-read**: the bridge must run in a **visible console window**. Hidden/no-window launches are forbidden. Direct SnowLuma / OneBot access is allowed only to the `cordis` preset agent (owner private chat); all other presets are forbidden. See the "Agent 必读" sections at the top of [`RULES.md`](RULES.md).

```bash
npm install                              # postinstall 会修补 SDK 的 ESM 打包问题
cp config.example.json config.json       # 然后编辑：填 OneBot 地址、白名单、模型
npm start
```

需要：Node.js ≥ 22.13、一个跑着的 DSH Web（本部署使用 `127.0.0.1:3081`）、一个 OneBot v11 协议端。

Requires Node.js ≥ 22.13, a running DSH Web (this deployment uses `127.0.0.1:3081`), and an OneBot v11 implementation.

## 安全须知 / Security

- `config.example.json` 是脱敏模板，真实 `config.json` 与 `state/` 不入库（见 `.gitignore`）。
- `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」。**先填白名单再上线。**
- `src/mcp-snowluma-safe.js` 只暴露 QQ 动作的安全子集，发送走强制白名单。
- `dsh/agent-presets/*/qq-tool-restrict.mjs` 用两道机制挡开发/管理工具：`tools.restrict` 隐藏，`tools.guard` 白名单在执行期兜底 —— 即使将来新增 `dev_*` 工具也会被拒绝。
- `src/safe-fetch.js` 带 SSRF 防护（含 NAT64 / 6to4 内嵌 IPv4 这类绕过手法）。

---

- `config.example.json` is a redacted template; the real `config.json` and `state/` are gitignored.
- `allowAllWhenEmpty: true` means "allow everything if the allowlist is empty". **Fill the allowlist before going live.**
- `src/mcp-snowluma-safe.js` exposes only a safe subset of QQ actions, with a mandatory send allowlist.
- `dsh/agent-presets/*/qq-tool-restrict.mjs` blocks dev/admin tools twice over: `tools.restrict` hides them, and a `tools.guard` allowlist rejects at execution time — so future `dev_*` tools are denied too.
- `src/safe-fetch.js` includes SSRF defenses (covering NAT64 / 6to4 embedded-IPv4 bypasses).

## 说明 / Notes

- `public-console.html` 是桥接自带的本地 Web 控制台（原路径 `public/console.html`）。
- `plugins-dsh/` 是配套的 DSH 插件 `qq-mode-console`（原路径 `plugins/`，改名以免和仓库根的 `plugins/` 混淆）。
- `assets/`（介绍视频、立绘）未包含在公开仓库里 —— 12 MB 的二进制对 clone 不友好，且不影响运行。
- `bridge.js` 是单文件约 1.2 万行的主程序，不是打包产物，可以直接读改。

---

- `public-console.html` is the bridge's built-in local web console (originally `public/console.html`).
- `plugins-dsh/` holds the companion DSH plugin `qq-mode-console` (originally `plugins/`, renamed to avoid confusion with the repo-root `plugins/`).
- `assets/` (intro video, artwork) is not included here — 12 MB of binaries is unfriendly to clone and isn't needed to run.
- `bridge.js` is a ~12k-line single-file main program, not a build artifact; read and edit it directly.
