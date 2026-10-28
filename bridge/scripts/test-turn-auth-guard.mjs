// 逐轮授权守卫的契约测试（不依赖真实 DSH 进程）。
//
// 用最小化的 fake ctx/agent 复现 DSH 的 agent/created 与 agent/pre-step 行为，
// 验证 qq-tool-restrict.mjs 的以下不变量：
//   1. 受信任账号签名的 turn：Standard 工具放行，且同一 turn 的后续 step 保持授权；
//   2. 新 turn 由普通账号发起：授权立即失效，Standard 工具被拒绝；
//   3. 状态提示只注入真正携带签名信封的那条消息（不误伤前置的 runtime context）；
//   4. 重放旧签名信封不会再次获得授权；
//   5. 签名被篡改 / 会话不匹配 / 未知来源：一律拒绝；
//   6. 普通账号所在 turn 里的 QQ/安全联网工具仍然可用；
//   7. 已被 tools.restrict 永久隐藏的开发注入器不会因为 turn 授权而复活（隐藏层独立）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 让插件从临时密钥文件读取，避免污染真实 state 目录。
const secret = 'guard-test-secret-0123456789abcdef';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-turn-auth-'));
const secretFile = path.join(tempDir, 'turn-auth-secret');
fs.writeFileSync(secretFile, secret, 'utf8');
process.env.DSH_QQ_TURN_AUTH_SECRET_FILE = secretFile;

const { sealTurnPrompt } = await import('../src/turn-auth.js');
const guardPlugin = await import('../dsh/agent-presets/restricted-standard/qq-tool-restrict.mjs');
assert.equal(guardPlugin.name, 'qq-tool-restrict');

const SESSION_ID = 'session-guard-test';

function createFakeEnv(presetId) {
  const created = [];
  const denyRestricted = [];
  let agentCtx = null;
  const fakeCtx = {
    get: (ns) => (ns === 'agentPresets' ? { composedPreset: () => presetId } : undefined),
    on: (event, handler) => {
      if (event === 'agent/created') created.push(handler);
      return () => {};
    },
  };
  const tools = {
    restrict: (filter) => { denyRestricted.push(...(filter?.deny ?? [])); },
    guard: (fn) => { agentCtx.guard = fn; return () => {}; },
  };
  agentCtx = {
    on: (event, handler) => {
      if (event === 'agent/pre-step') agentCtx.preStep = handler;
      return () => {};
    },
    tools,
  };
  guardPlugin.apply(fakeCtx);
  assert.equal(created.length, 1, 'agent/created handler registered');
  created[0]({ agent: { id: SESSION_ID, ctx: agentCtx } });
  assert.equal(typeof agentCtx.preStep, 'function', 'pre-step handler registered');
  assert.equal(typeof agentCtx.guard, 'function', 'tools.guard registered');
  return { agentCtx, denyRestricted };
}

function userMessage(text, id = `msg-${Math.random().toString(16).slice(2)}`) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

// 模拟一次 pre-step：next() 返回 DSH 默认 decision（把 messages 交给模型）。
async function runPreStep(agentCtx, turn, messages = []) {
  return agentCtx.preStep({ agent: { id: SESSION_ID }, turn }, async () => ({
    kind: 'enter',
    messages,
  }));
}

const { agentCtx, denyRestricted } = createFakeEnv('restricted-standard');
assert.ok(denyRestricted.includes('dev_inject_plugin'), '开发注入器被永久隐藏');

// ── turn 1：受信任账号（签名有效），且签名消息不是第一条 ──────────────────
const privilegedText = '请读取工作区里的文件';
const signed = sealTurnPrompt(secret, {
  sessionId: SESSION_ID,
  userId: '123456789',
  privileged: true,
  text: privilegedText,
});
const runtimeContext = userMessage('【时间】2026-10-24 00:00', 'ctx-1');
const turn1 = await runPreStep(agentCtx, 1, [runtimeContext, userMessage(signed, 'user-1')]);
assert.equal(turn1.messages.length, 2);
assert.equal(turn1.messages[0].content[0].text, runtimeContext.content[0].text, '前置 runtime context 不被注入状态');
assert.match(turn1.messages[1].content[0].text, /Bridge 已验签/);
assert.match(turn1.messages[1].content[0].text, /123456789/);
assert.equal(turn1.messages[1].content[1].text, privilegedText, '信封被剥离，正文保留');

// 同一 turn 的后续 step（messages 为空）仍保持授权。
const turn1Step2 = await runPreStep(agentCtx, 1);
assert.equal(turn1Step2.messages.length, 0);
assert.equal(agentCtx.guard({ name: 'pwsh' }), undefined, '受信任 turn 内 pwsh 放行');
assert.equal(agentCtx.guard({ name: 'read_file' }), undefined, '受信任 turn 内文件工具放行');

// ── turn 2：普通账号（未被签名为受信任） ───────────────────────────────────
const ordinaryText = '帮我执行一下命令';
const signedOrdinary = sealTurnPrompt(secret, {
  sessionId: SESSION_ID,
  userId: '123456',
  privileged: false,
  text: ordinaryText,
});
const turn2 = await runPreStep(agentCtx, 2, [userMessage(signedOrdinary)]);
assert.match(turn2.messages[0].content[0].text, /不是受信任账号发起/);
assert.equal(typeof agentCtx.guard({ name: 'pwsh' }), 'string', '普通 turn 拒绝 pwsh');
assert.equal(typeof agentCtx.guard({ name: 'read_file' }), 'string', '普通 turn 拒绝文件工具');
assert.equal(agentCtx.guard({ name: 'mcp__snowluma__qq_send_message' }), undefined, '普通 turn 仍可发 QQ 消息');
assert.equal(agentCtx.guard({ name: 'mcp__web-search-safe__web_search' }), undefined, '普通 turn 仍可安全联网');
assert.equal(agentCtx.guard({ name: 'ask_user_question' }), undefined, '普通 turn 仍可提问');
assert.equal(typeof agentCtx.guard({ name: 'dev_inject_plugin' }), 'string', '开发注入器始终被拒绝');

// ── turn 3：无签名（Bridge 未签名 / 普通文本） ─────────────────────────────
const turn3 = await runPreStep(agentCtx, 3, [userMessage('普通文本')]);
assert.doesNotMatch(turn3.messages[0].content[0]?.text ?? '', /Bridge 已验签/);
assert.equal(typeof agentCtx.guard({ name: 'pwsh' }), 'string', '无签名 turn 拒绝 pwsh');

// ── turn 4：篡改签名 / 会话不匹配 ──────────────────────────────────────────
const tampered = sealTurnPrompt(secret, {
  sessionId: SESSION_ID,
  userId: '123456789',
  privileged: true,
  text: '原请求',
}).replace('原请求', '被修改的请求');
const turn4 = await runPreStep(agentCtx, 4, [userMessage(tampered)]);
assert.match(turn4.messages[0].content[0].text, /不是受信任账号发起/);
assert.equal(typeof agentCtx.guard({ name: 'pwsh' }), 'string', '篡改签名后拒绝 pwsh');

const wrongSession = sealTurnPrompt(secret, {
  sessionId: 'other-session',
  userId: '123456789',
  privileged: true,
  text: '跨会话重放',
});
const turn5 = await runPreStep(agentCtx, 5, [userMessage(wrongSession)]);
assert.equal(typeof agentCtx.guard({ name: 'pwsh' }), 'string', '跨会话重放被拒绝');

// ── turn 6：重放 turn 1 的旧信封（nonce 已消费） ───────────────────────────
const turn6 = await runPreStep(agentCtx, 6, [userMessage(signed)]);
assert.match(turn6.messages[0].content[0].text, /不是受信任账号发起/);
assert.equal(typeof agentCtx.guard({ name: 'pwsh' }), 'string', '旧签名重放不授权');

// ── turn 7：content 不是数组时不抛异常 ─────────────────────────────────────
const weird = { id: 'weird', role: 'user', source: { kind: 'user' }, content: 'plain' };
const turn7 = await runPreStep(agentCtx, 7, [weird]);
assert.equal(turn7.messages.length, 1);
assert.equal(typeof agentCtx.guard({ name: 'pwsh' }), 'string');

// ── 非 restricted-standard preset：权限永不生效 ────────────────────────────
{
  const env = createFakeEnv('qq-chat-v2');
  const signedForV2 = sealTurnPrompt(secret, {
    sessionId: SESSION_ID,
    userId: '123456789',
    privileged: true,
    text: 'v2 会话不应获得 Standard 能力',
  });
  const decision = await runPreStep(env.agentCtx, 1, [userMessage(signedForV2)]);
  assert.match(decision.messages[0].content[0].text, /不是受信任账号发起/);
  assert.equal(typeof env.agentCtx.guard({ name: 'pwsh' }), 'string', 'v2 preset 即使签名受信任也拒绝 pwsh');
}

fs.rmSync(tempDir, { recursive: true, force: true });
delete process.env.DSH_QQ_TURN_AUTH_SECRET_FILE;
console.log('turn auth guard tests passed');
