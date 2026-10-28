// restricted-standard 的在线自检（需要 qqbot DSH 正在运行、Bridge 已完成过一次启动）。
//
// 验证内容：
//   1. restricted-standard 已在 DSH 注册（能列出）；
//   2. 能用该 preset 创建会话（证明 preset 的全部插件都能装载）；
//   3. 同一会话里：
//        a) 未签名（普通账号）请求本地命令 → 被 qq-tool-restrict 拒绝；
//        b) Bridge 签名（受信任账号）请求本地命令 → 放行并返回结果；
//        c) 紧接着的未签名请求 → 再次被拒绝（turn 结束即收回权限）。
//
// 用法：node scripts/test-restricted-standard-live.mjs [baseUrl]
// 默认 baseUrl=http://127.0.0.1:3081；需要 state/dsh-auth.json 已授权、
// state/turn-auth-secret 存在。该脚本不会发送任何 QQ 消息（提示词里明确禁止）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { sealTurnPrompt } from '../src/turn-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SECRET_FILE = process.env.DSH_QQ_TURN_AUTH_SECRET_FILE
  || path.join(ROOT, 'state', 'turn-auth-secret');

const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const bad = (m) => { console.error(`❌ ${m}`); process.exitCode = 1; };

function readSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { return ''; }
}

// 复用一条 remote.mux 连接：每问一次都新建/关闭连接会触发 dsh-client 的
// failStreams，因此这里用一个常驻 pump 把事件广播给当前等待者。
function createEventPump(api) {
  const listeners = new Set();
  let markOpened;
  const opened = new Promise((resolve) => { markOpened = resolve; });
  (async () => {
    try {
      for await (const env of api.events.mux({}, undefined, () => markOpened())) {
        for (const listener of [...listeners]) {
          try { listener(env.payload); } catch {}
        }
      }
    } catch {}
  })();
  return {
    opened,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function ask(api, pump, sessionId, promptText) {
  const collector = createTurnCollector();
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('等待回复超时（180s）')); }, 180_000);
    const unsubscribe = pump.subscribe((frame) => {
      if (frame.type === 'stream/error') {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(`事件流错误: ${JSON.stringify(frame.error)}`));
        return;
      }
      if (frame.type !== 'session/event' || frame.sessionId !== sessionId) return;
      const ended = collector.push(frame.event);
      if (ended) {
        clearTimeout(timer);
        unsubscribe();
        resolve(ended);
      }
    });
  });
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }), 'session.prompt');
  const ended = await answer;
  return String(ended.text ?? '').trim();
}

async function main() {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3081';
  const api = new NodeApiClient(baseUrl);
  const secret = readSecret();
  if (!secret) {
    bad(`找不到 turn-auth-secret（${SECRET_FILE}）。请先启动 Bridge 生成密钥。`);
    return;
  }

  const { presets } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
  const preset = presets.find((p) => p.id === 'restricted-standard');
  if (!preset) bad('restricted-standard 未注册（检查 qqbot profile 的 bundle 是否已重新构建并重启）');
  else ok(`preset 已注册：${preset.id}（${preset.name ?? ''}，order=${preset.order ?? '?'}）`);
  if (process.exitCode) return;

  // 用真实 QQ 会话的工作目录（state/agents）做自检，避免新建目录缺少
  // WRITE_DAC 权限导致 DSH 的 Windows 沙箱 grantWrite 失败（Win32 5）。
  const cwd = path.join(ROOT, 'state', 'agents');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'restricted-standard' }), 'session.create');
  const sessionId = created.sessionId;
  ok(`会话已创建：${sessionId}（preset=${created.agentPreset ?? 'restricted-standard'}）`);

  const pump = createEventPump(api);
  await pump.opened;

  const guard = '这是安装自检，不涉及 QQ 群聊。不要调用任何 mcp__ 开头的工具，不要发送任何 QQ 消息。';

  // a) 普通账号：未签名，要求执行本地命令。
  const ordinary1 = await ask(api, pump, sessionId,
    `${guard}\n请调用 pwsh 工具执行命令 echo 42，把工具返回的结果原样贴出来；如果工具调用被拒绝，只回复一行 DENIED:<拒绝原因>。`);
  console.log(`—— 未签名（普通账号）请求 pwsh ——\n${ordinary1}\n`);
  if (/DENIED/i.test(ordinary1)) ok('未签名轮次调用 pwsh 被拒绝（执行期守卫生效）');
  else warn('模型没有按 DENIED 格式回复，请人工确认上面输出；若出现 42 则说明守卫未生效');

  // b) 受信任账号：Bridge 签名。
  const privilegedText = `${guard}\n请调用 pwsh 工具执行命令 echo 42，把工具返回的结果原样贴出来，格式 OK:<输出>。`;
  const signed = sealTurnPrompt(secret, {
    sessionId,
    userId: '123456789',
    privileged: true,
    text: privilegedText,
  });
  const privileged = await ask(api, pump, sessionId, signed);
  console.log(`—— 已签名（受信任账号）请求 pwsh ——\n${privileged}\n`);
  if (/\b42\b/.test(privileged)) ok('受信任轮次调用 pwsh 成功（返回 42）');
  else warn('受信任轮次未返回 42，请人工检查；可能是模型未调用工具或审批阻挡');

  // c) 权限收回：同一会话紧接着的未签名请求。
  const ordinary2 = await ask(api, pump, sessionId,
    `${guard}\n请调用 pwsh 工具执行命令 echo 99。如果工具调用被拒绝，只回复一行 DENIED:<拒绝原因>。`);
  console.log(`—— 受信任轮次之后的未签名请求 ——\n${ordinary2}\n`);
  if (/DENIED/i.test(ordinary2)) ok('新一轮未签名请求再次被拒绝（权限随 turn 收回）');
  else warn('模型没有按 DENIED 格式回复，请人工确认上面输出');

  await api.close?.();
  // 常驻 remote.mux 会保持事件循环，正常结束后显式退出。
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error('❌ 在线自检失败:', error?.message ?? error);
  process.exit(1);
});
