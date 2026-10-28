// Local Execution Gateway daemon：只监听 127.0.0.1，只接受带有效票据的请求。
// 校验顺序见设计文档 §4，任何一步失败都返回统一错误码。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  resolveLegPaths, loadOrCreateSecret, verifyTicket, argsDigest,
  loadGrants, isPathInside, checkCommand, appendAudit, scrubSecrets
} from './common.js';

const STATE_DIR = process.env.LEG_STATE_DIR || path.resolve(process.argv[2] || 'state');
const PORT = Number(process.env.LEG_PORT || process.argv[3] || 3210);
const BRIDGE_URL = process.env.LEG_BRIDGE_URL || 'http://127.0.0.1:3100';
const CONFIRM_OPS = new Set(String(process.env.LEG_CONFIRM_OPS || 'exec,write').split(',').map((s) => s.trim()).filter(Boolean));
const paths = resolveLegPaths(STATE_DIR);
const secret = loadOrCreateSecret(paths.secret);

/** 桥接全局要求控制台令牌；daemon 从 state/console-token 或 config.json 读。 */
function readConsoleToken() {
  try { return fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim(); } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, '..', 'config.json'), 'utf8'));
    return String(cfg.consoleToken || '');
  } catch { return ''; }
}

async function askBridgeApproval(grant, requestId, op, summary) {
  const headers = { 'content-type': 'application/json' };
  const ct = readConsoleToken();
  if (ct) headers['x-console-token'] = ct;
  try {
    const res = await fetch(`${BRIDGE_URL}/api/leg/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: grant.key, requestId, op, summary }),
      // 桥接侧有 60s 审批窗口，这里多留 15s
      signal: AbortSignal.timeout(90000)
    });
    const data = await res.json().catch(() => null);
    return !!(data && data.approved === true);
  } catch {
    return false;
  }
}

// requestId 重放缓存（10 分钟）
const seenRequests = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of seenRequests) if (v < cutoff) seenRequests.delete(k);
}, 60 * 1000).unref();

function fail(res, code, message, extra = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: message, ...extra }));
}

function ok(res, data) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, ...data }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function runPowerShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const cap = 64 * 1024;
    child.stdout.on('data', (c) => { if (out.length < cap) out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { if (err.length < cap) err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(1000, timeoutMs || 60000));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: out, stderr: err, durationMs: Date.now() - startedAt });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout: out, stderr: String(e?.message || e), durationMs: Date.now() - startedAt });
    });
  });
}

function authorize(body) {
  const payload = verifyTicket(secret, body.ticket);
  if (!payload) return { ok: false, status: 403, code: 'E_TICKET_INVALID', detail: '票据无效或签名不匹配' };
  const now = Date.now();
  if (!(Number(payload.exp) > now)) return { ok: false, status: 403, code: 'E_TICKET_INVALID', detail: '票据已过期' };
  if (Number(payload.exp) - Number(payload.iat) > 120000) return { ok: false, status: 403, code: 'E_TICKET_INVALID', detail: '票据寿命异常' };
  if (seenRequests.has(payload.requestId)) return { ok: false, status: 409, code: 'E_TICKET_INVALID', detail: '票据重放' };
  const op = String(body.op || '');
  if (String(payload.op) !== op) return { ok: false, status: 403, code: 'E_TICKET_INVALID', detail: '票据与操作不匹配' };
  const digest = argsDigest(op, body.args || {});
  if (String(payload.argsHash) !== digest) return { ok: false, status: 403, code: 'E_TICKET_INVALID', detail: '参数被篡改' };
  const store = loadGrants(paths.grants);
  const grant = store.grants?.[payload.grantId];
  if (!grant) return { ok: false, status: 403, code: 'E_GRANT_MISSING', detail: '授权不存在' };
  if (grant.status !== 'active') return { ok: false, status: 403, code: 'E_GRANT_EXPIRED', detail: `授权状态 ${grant.status}` };
  if (Number(grant.expiresAt) <= now) return { ok: false, status: 403, code: 'E_GRANT_EXPIRED', detail: '授权已到期' };
  const ops = Array.isArray(grant.scope?.ops) ? grant.scope.ops : [];
  if (!ops.includes(op)) return { ok: false, status: 403, code: 'E_OP_NOT_ALLOWED', detail: `不包含操作 ${op}` };
  // 通过全部校验后登记 requestId，之后的重复请求按重放拒绝
  seenRequests.set(payload.requestId, now);
  return { ok: true, payload, grant };
}

async function handleOp(body) {
  const auth = authorize(body);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.code, detail: auth.detail } };
  const { payload, grant } = auth;
  const op = String(body.op);
  const args = body.args || {};
  const dirs = Array.isArray(grant.scope?.dirs) ? grant.scope.dirs : [];
  const workDir = dirs[0] || process.cwd();
  const record = {
    requestId: payload.requestId,
    grantId: payload.grantId,
    op,
    stage: 'proposed',
    argsDigest: payload.argsHash,
    at: Date.now()
  };
  appendAudit(paths.auditDir, record);

  // 审批档：exec / write 需要 owner 在私聊里点「通过」
  if (CONFIRM_OPS.has(op)) {
    const summary = op === 'exec'
      ? String(args.command || '').slice(0, 200)
      : String(args.path || '');
    const approved = await askBridgeApproval(grant, payload.requestId, op, summary);
    if (!approved) {
      appendAudit(paths.auditDir, { ...record, stage: 'executed', decision: 'deny', reason: 'E_APPROVAL_DENIED' });
      return { status: 403, body: { ok: false, error: 'E_APPROVAL_DENIED', detail: 'owner 未批准或审批超时' } };
    }
    appendAudit(paths.auditDir, { ...record, stage: 'approved', decision: 'allow' });
  }

  if (op === 'list' || op === 'read' || op === 'write') {
    const target = String(args.path || '');
    if (!target) return { status: 400, body: { ok: false, error: 'E_PATH_OUT_OF_SCOPE', detail: '缺少 path' } };
    if (!isPathInside(dirs, target)) {
      appendAudit(paths.auditDir, { ...record, stage: 'executed', decision: 'deny', reason: 'E_PATH_OUT_OF_SCOPE' });
      return { status: 403, body: { ok: false, error: 'E_PATH_OUT_OF_SCOPE', detail: `不在授权目录：${target}` } };
    }
    if (op === 'list') {
      let entries = [];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 500).map((d) => ({
          name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? null : (() => { try { return fs.statSync(path.join(target, d.name)).size; } catch { return null; } })()
        }));
      } catch (e) {
        return { status: 500, body: { ok: false, error: 'E_EXEC_FAILED', detail: String(e?.message || e) } };
      }
      appendAudit(paths.auditDir, { ...record, stage: 'executed', decision: 'allow', exitCode: 0 });
      return { status: 200, body: { ok: true, op, path: target, entries } };
    }
    if (op === 'read') {
      try {
        const st = fs.statSync(target);
        if (st.size > 2 * 1024 * 1024) return { status: 400, body: { ok: false, error: 'E_EXEC_FAILED', detail: '文件超过 2MB' } };
        const content = fs.readFileSync(target, 'utf8');
        appendAudit(paths.auditDir, { ...record, stage: 'executed', decision: 'allow', exitCode: 0 });
        return { status: 200, body: { ok: true, op, path: target, content: scrubSecrets(content).slice(0, 200000) } };
      } catch (e) {
        return { status: 500, body: { ok: false, error: 'E_EXEC_FAILED', detail: String(e?.message || e) } };
      }
    }
    // write
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(args.content ?? ''), 'utf8');
      appendAudit(paths.auditDir, { ...record, stage: 'executed', decision: 'allow', exitCode: 0 });
      return { status: 200, body: { ok: true, op, path: target, bytes: Buffer.byteLength(String(args.content ?? '')) } };
    } catch (e) {
      return { status: 500, body: { ok: false, error: 'E_EXEC_FAILED', detail: String(e?.message || e) } };
    }
  }

  if (op === 'exec') {
    const command = String(args.command || '');
    const check = checkCommand(command, grant.scope?.allowCommands || []);
    if (!check.ok) {
      appendAudit(paths.auditDir, { ...record, stage: 'executed', decision: 'deny', reason: check.reason, detail: check.detail });
      return { status: 403, body: { ok: false, error: check.reason, detail: check.detail } };
    }
    const timeoutMs = Math.min(Number(args.timeoutMs) || 60000, Number(grant.scope?.maxRuntimeMs) || 300000);
    const result = await runPowerShell(command, workDir, timeoutMs);
    appendAudit(paths.auditDir, {
      ...record, stage: 'executed', decision: 'allow',
      exitCode: result.exitCode, durationMs: result.durationMs
    });
    return {
      status: 200,
      body: {
        ok: result.exitCode === 0, op, exitCode: result.exitCode,
        stdout: scrubSecrets(result.stdout), stderr: scrubSecrets(result.stderr),
        durationMs: result.durationMs, cwd: workDir
      }
    };
  }

  return { status: 400, body: { ok: false, error: 'E_OP_NOT_ALLOWED', detail: `未知操作 ${op}` } };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return ok(res, { service: 'leg-daemon', version: 1, stateDir: STATE_DIR });
    }
    if (req.method === 'POST' && req.url === '/op') {
      const body = await readBody(req);
      const out = await handleOp(body);
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(out.body));
    }
    return fail(res, 404, 'not found');
  } catch (e) {
    return fail(res, 500, String(e?.message || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[leg] daemon listening on 127.0.0.1:${PORT} state=${STATE_DIR}`);
});
