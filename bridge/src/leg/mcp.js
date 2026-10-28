// LEG MCP shim：把执行请求转发给 daemon，票据由桥接按会话签发。
// 工具：local_exec / local_read / local_write / local_list / local_grant_status
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..', '..');
const BRIDGE = process.env.LEG_BRIDGE_URL || 'http://127.0.0.1:3100';
const DAEMON = process.env.LEG_DAEMON_URL || 'http://127.0.0.1:3210';

/** 桥接全局要求控制台令牌：优先 config.json，其次 state/console-token。 */
function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(BRIDGE_ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function postJson(url, payload, timeoutMs = 300000) {
  const headers = { 'content-type': 'application/json' };
  const ct = readConsoleToken();
  if (ct) headers['x-console-token'] = ct;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

async function runOp({ key, token, op, args }) {
  // 1) 向桥接要票据（桥接负责 owner 校验、授权范围、配额）
  const ticketRes = await postJson(`${BRIDGE}/api/leg/ticket`, { key, token, op, args }, 30000);
  if (!ticketRes?.ok || !ticketRes.ticket) {
    return { ok: false, error: ticketRes?.error || 'E_NO_TICKET', detail: ticketRes?.detail || '' };
  }
  // 2) 交给执行器（执行器独立验签 + 二次范围/命令检查）
  try {
    const out = await postJson(`${DAEMON}/op`, { op, args, ticket: ticketRes.ticket }, 300000);
    return out;
  } catch (e) {
    return { ok: false, error: e?.payload?.error || 'E_EXEC_FAILED', detail: e?.payload?.detail || String(e?.message || e) };
  }
}

const server = new McpServer({ name: 'leg', version: '0.1.0' });

const base = {
  key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
  token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
};

server.tool(
  'local_exec',
  '在授权目录里执行一条 PowerShell 命令（受任务授权约束：目录、命令白名单、超时）。没有有效授权时会返回 E_NO_TICKET / E_GRANT_EXPIRED，此时应该告诉用户需要他在私聊里发 /grant 授权，而不是反复重试。',
  {
    ...base,
    command: z.string().describe('要执行的 PowerShell 命令'),
    timeoutMs: z.number().optional().describe('超时毫秒，默认 60000，上限取授权里的 maxRuntimeMs')
  },
  async ({ key, token, command, timeoutMs }) => {
    const out = await runOp({ key, token, op: 'exec', args: { command, timeoutMs: timeoutMs || null } });
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out.ok === false };
  }
);

server.tool(
  'local_read',
  '读取授权目录内的文本文件（上限 2MB，返回内容会做凭据脱敏）。',
  { ...base, path: z.string().describe('文件绝对路径，必须在授权目录内') },
  async ({ key, token, path: p }) => {
    const out = await runOp({ key, token, op: 'read', args: { path: p } });
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out.ok === false };
  }
);

server.tool(
  'local_write',
  '在授权目录内写入文本文件（覆盖式，自动创建父目录）。',
  { ...base, path: z.string().describe('文件绝对路径，必须在授权目录内'), content: z.string().describe('文件内容') },
  async ({ key, token, path: p, content }) => {
    const out = await runOp({ key, token, op: 'write', args: { path: p, content } });
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out.ok === false };
  }
);

server.tool(
  'local_list',
  '列出授权目录内的文件（最多 500 条）。',
  { ...base, path: z.string().describe('目录绝对路径，必须在授权目录内') },
  async ({ key, token, path: p }) => {
    const out = await runOp({ key, token, op: 'list', args: { path: p } });
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out.ok === false };
  }
);

server.tool(
  'local_grant_status',
  '查看当前会话的任务授权状态（是否有有效 grant、范围、剩余时间、已用配额）。不消耗配额。',
  { ...base },
  async ({ key, token }) => {
    try {
      // 注意：query 里的 token 会被桥接的全局控制台鉴权当成控制台令牌，agent 令牌必须走 header。
      const url = `${BRIDGE}/api/leg/status?key=${encodeURIComponent(key)}`;
      const headers = { 'x-agent-token': token };
      const ct = readConsoleToken();
      if (ct) headers['x-console-token'] = ct;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const data = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `查询授权状态失败：${e?.message || e}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
