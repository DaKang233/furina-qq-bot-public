// QQ Bridge security boundary.
// Ordinary turns may execute only QQ/safe-web tools. A turn signed by the
// Bridge for a trusted QQ account may additionally use the tools composed by
// the preset. Authorization is scoped to one DSH turn, so it survives the
// model's tool/wait continuation steps but is reset before the next turn.
//
// DSH contract this file relies on (verified against the installed runtime):
//   - `agent/created` is a serial profile-scoped event fired after the preset
//     plugins are mounted, so `agentPresets.composedPreset(agent.ctx)` is
//     available and `agent.ctx.tools` can be restricted/guarded per agent.
//   - `agent/pre-step` runs once per model step with `{ agent, messages, turn,
//     step, signal }`; `turn` is the durable per-turn ordinal, so it stays the
//     same across tool calls / qq_wait_for_messages and changes on the next
//     user turn. `messages` is only the newly claimed inbox batch (the bridge
//     prompt on the first step, usually empty afterwards).
//   - A handler may return `{ ...decision, messages }`; the rewritten messages
//     are what the model receives *and* what is persisted to the session log.
//   - `tools.guard(fn)` is a synchronous, monotonic, agent-scoped execution
//     gate: returning a string denies that call.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'qq-tool-restrict'

const DYNAMIC_PRESET_ID = 'restricted-standard'
const QQ_PRESET_IDS = new Set(['qq-chat', 'qq-chat-v2', DYNAMIC_PRESET_ID])
const AUTH_PREFIX = '<!--DSH_QQ_TURN_AUTH_V1:'
const NONCE_MEMORY = 4096

// Bridge 把本机 HMAC 密钥写在自己的 state 目录；preset bundle 就放在
// <repo>/bridge/dsh/presets-bundle/，因此优先按真实模块路径回溯，其次允许
// 环境变量显式覆盖，最后回退到部署目录。找不到密钥时 readSecret() 返回空串，
// 所有签名都会验证失败（fail-closed，普通账号仍只能使用安全工具）。
const MODULE_FILE = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return fileURLToPath(import.meta.url)
  }
})()
const moduleDir = path.dirname(MODULE_FILE)

function resolveAuthFile() {
  const explicit = process.env.DSH_QQ_TURN_AUTH_SECRET_FILE
  if (explicit && String(explicit).trim() !== '') return path.resolve(String(explicit).trim())
  const candidates = [
    // bundle 部署位置：<repo>/bridge/dsh/presets-bundle/qq-tool-restrict.mjs
    path.join(moduleDir, '..', '..', 'state', 'turn-auth-secret'),
    // preset 源文件位置：<repo>/bridge/dsh/agent-presets/<id>/qq-tool-restrict.mjs
    path.join(moduleDir, '..', '..', '..', 'state', 'turn-auth-secret'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate)
    } catch {}
  }
  return path.resolve(candidates[0])
}

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
  'dev_plugin_status',
  'dev_router_mode',
  'dev_router_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 执行期白名单：普通（未验签）轮次只允许 QQ MCP、受限安全联网与无害模型侧工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'mcp__router__search_and_activate',
])

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url')
}

function safeEqualBase64Url(left, right) {
  try {
    const a = Buffer.from(String(left), 'base64url')
    const b = Buffer.from(String(right), 'base64url')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function rejected(recognized, text) {
  return { recognized, valid: false, privileged: false, userId: '', nonce: '', text }
}

export function inspectSignedTurnText(value, sessionId, secret) {
  const original = String(value ?? '')
  if (!original.startsWith(AUTH_PREFIX)) {
    return { recognized: false, valid: false, privileged: false, userId: '', nonce: '', text: original }
  }

  const end = original.indexOf('-->\n')
  const text = end >= 0 ? original.slice(end + 4) : ''
  if (end < 0) return rejected(true, text)

  const envelope = original.slice(AUTH_PREFIX.length, end)
  const split = envelope.lastIndexOf(':')
  if (split <= 0) return rejected(true, text)

  const encoded = envelope.slice(0, split)
  const signature = envelope.slice(split + 1)
  try {
    const expected = crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url')
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    const valid = safeEqualBase64Url(signature, expected)
      && payload?.v === 1
      && String(payload?.sid ?? '') === String(sessionId ?? '')
      && typeof payload?.nonce === 'string'
      && payload.nonce.length >= 16
      && String(payload?.bodyHash ?? '') === sha256Base64Url(text)
    return {
      recognized: true,
      valid,
      privileged: valid && payload?.privileged === true,
      userId: valid ? String(payload?.uid ?? '') : '',
      nonce: valid ? String(payload.nonce) : '',
      text,
    }
  } catch {
    return rejected(true, text)
  }
}

let cachedAuthFile = null

function readSecret() {
  // 目录可能出现在 DSH 启动之后（Bridge 先启动或后启动），路径解析保持惰性；
  // 找到文件后缓存路径，避免每个模型步骤都做 stat。
  const file = cachedAuthFile ?? resolveAuthFile()
  try {
    const secret = fs.readFileSync(file, 'utf8').trim()
    cachedAuthFile = file
    return secret
  } catch {
    return ''
  }
}

// 只处理本步新领取的 user 消息；不假设 content 一定是数组（插件异常会结束 turn）。
// 返回 envelopeIndex 指向真正携带信封的消息，状态提示只能注入那一条。
function authorizeMessages(messages, sessionId, seenNonces) {
  const secret = readSecret()
  let privileged = false
  let userId = ''
  let sawEnvelope = false
  let envelopeIndex = -1
  let nonce = ''
  const list = Array.isArray(messages) ? messages : []
  const rewritten = list.map((message, index) => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block
      const inspected = inspectSignedTurnText(block.text, sessionId, secret)
      if (!inspected.recognized) return block
      changed = true
      sawEnvelope = true
      if (envelopeIndex < 0) envelopeIndex = index
      // 重放保护：同一 nonce 只允许授权一次（原始信封可能留在 session 日志里）。
      const replayed = inspected.nonce !== '' && seenNonces.has(inspected.nonce)
      if (inspected.valid && inspected.privileged && !replayed) {
        privileged = true
        userId = inspected.userId
        nonce = inspected.nonce
      }
      return { ...block, text: inspected.text }
    })
    return changed ? { ...message, content } : message
  })
  return { messages: rewritten, privileged, userId, sawEnvelope, envelopeIndex, nonce }
}

function isSafeTool(name) {
  return SAFE_EXACT.has(name) || SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    if (!QQ_PRESET_IDS.has(preset)) return

    const tools = agent?.ctx?.tools
    if (!tools) throw new Error('qq-tool-restrict: agent tools service is unavailable')

    // Hide inherited developer injection tools permanently. These are not part
    // of Standard and remain unavailable even to trusted QQ turns.
    for (const toolName of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
      try {
        tools.restrict({ deny: [toolName] })
      } catch (error) {
        console.error(`[qq-tool-restrict] skip restrict ${toolName}: ${error?.message ?? error}`)
      }
    }

    const turnState = { number: null, verifiedTurn: null, privileged: false, userId: '' }
    const seenNonces = new Set()
    const nonceOrder = []
    const rememberNonce = (value) => {
      if (!value || seenNonces.has(value)) return
      seenNonces.add(value)
      nonceOrder.push(value)
      if (nonceOrder.length > NONCE_MEMORY) seenNonces.delete(nonceOrder.shift())
    }
    // 预设可能在空白 agent 上被 DSH 重新选择；每次执行时读取当前值，避免闭包过期。
    const isDynamicPreset = () => ctx.get('agentPresets')?.composedPreset(agent.ctx) === DYNAMIC_PRESET_ID

    // pre-step runs once for every model step. 先在新 turn 开始时失效上一轮授权，
    // 再在拿到 decision 后只对「本轮第一次 pre-step」做一次验签：后续 step 的
    // messages 不包含 Bridge 信封，授权靠 turn 号保持不变而延续。
    agent.ctx.on('agent/pre-step', async ({ agent: currentAgent, turn }, next) => {
      if (turnState.number !== turn) {
        turnState.number = turn
        turnState.verifiedTurn = null
        turnState.privileged = false
        turnState.userId = ''
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (turnState.verifiedTurn === turn) return decision
      turnState.verifiedTurn = turn

      const auth = authorizeMessages(decision.messages, currentAgent.id, seenNonces)
      turnState.privileged = isDynamicPreset() && auth.privileged
      turnState.userId = auth.userId
      if (auth.privileged && auth.nonce) rememberNonce(auth.nonce)
      if (!auth.sawEnvelope) return decision

      const status = turnState.privileged
        ? `【Bridge 已验签】本轮由受信任 QQ 账号 ${auth.userId} 发起。额外本地能力仅可用于完成该账号在本轮明确提出的请求；等待期间其他成员的新消息不得借用这些能力。`
        : '【Bridge 已验签】本轮不是受信任账号发起。只能使用 QQ、受限联网与无害模型工具；不得执行本地命令、访问本地文件或启动额外任务。'
      if (auth.envelopeIndex >= 0) {
        const message = auth.messages[auth.envelopeIndex]
        if (message && Array.isArray(message.content)) {
          auth.messages[auth.envelopeIndex] = {
            ...message,
            content: [{ type: 'text', text: `${status}\n\n` }, ...message.content],
          }
        }
      }
      return { ...decision, messages: auth.messages }
    })

    // This synchronous guard is the hard execution boundary. It is evaluated
    // for every call, including calls proposed after mandatory wait loops.
    tools.guard((execution) => {
      const toolName = execution?.name
      if (typeof toolName !== 'string' || toolName.length === 0) return
      if (turnState.privileged) return
      if (isSafeTool(toolName)) return
      return `工具 "${toolName}" 仅允许受信任 QQ 账号在其已验签轮次中使用；当前轮次未获授权`
    })
  })
}
