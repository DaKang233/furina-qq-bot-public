// Local Execution Gateway 共用工具：密钥、票据签名、授权读写、路径/命令检查、审计。
// 设计见 state/agents/local-exec-gateway-design.md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LEG_DIR = path.join(process.env.DSHQQ_BRIDGE_STATE || '', '');

export function resolveLegPaths(stateDir) {
  const base = path.join(stateDir, 'leg');
  return {
    base,
    secret: path.join(base, 'secret.key'),
    grants: path.join(base, 'grants.json'),
    auditDir: base
  };
}

/** 读取或创建 HMAC 密钥（32 字节 hex）。 */
export function loadOrCreateSecret(secretPath) {
  try {
    const v = fs.readFileSync(secretPath, 'utf8').trim();
    if (v.length >= 32) return v;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** 规范化参数后求摘要（执行器与桥接必须用同一算法）。 */
export function argsDigest(op, args) {
  const keys = Object.keys(args || {}).sort();
  const norm = keys.map((k) => `${k}=${JSON.stringify(args[k] ?? null)}`).join('\n');
  return sha256Hex(`${op}\n${norm}`);
}

export function signTicket(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyTicket(secret, ticket) {
  const [body, sig] = String(ticket || '').split('.');
  if (!body || !sig) return null;
  const expect = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  return payload;
}

export function loadGrants(grantsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(grantsPath, 'utf8'));
    return raw && typeof raw === 'object' && raw.grants ? raw : { grants: {} };
  } catch {
    return { grants: {} };
  }
}

export function saveGrants(grantsPath, store) {
  fs.mkdirSync(path.dirname(grantsPath), { recursive: true });
  fs.writeFileSync(grantsPath, JSON.stringify(store, null, 2));
}

/** target 是否在 base 目录内（realpath 展开，防符号链接与 C:\foo vs C:\foobar）。 */
export function isPathInside(baseDirs, target) {
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    // 目标还不存在时，用父目录 realpath + 文件名兜底
    const parent = path.dirname(target);
    try { real = path.join(fs.realpathSync(parent), path.basename(target)); } catch { real = path.resolve(target); }
  }
  for (const dir of baseDirs || []) {
    let base;
    try { base = fs.realpathSync(dir); } catch { base = path.resolve(dir); }
    const b = base.replace(/[\\/]+$/, '');
    const t = real.replace(/[\\/]+$/, '');
    if (t === b) return true;
    if (t.toLowerCase().startsWith((b + path.sep).toLowerCase())) return true;
  }
  return false;
}

const DENY_PATTERNS = [
  /(^|[^\w])[a-zA-Z]:[\\/]/,           // 绝对路径调用
  /\bImport-Module\b/i,
  /\bStart-Process\b/i,
  /\bInvoke-Expression\b/i,
  /\b(Invoke-WebRequest|iwr|curl|wget|certutil|bitsadmin)\b/i,
  /\bschtasks\b/i,
  /\breg(\.exe)?\s+add\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bNew-Service\b|\bsc(\.exe)?\s+create\b/i,
  /\bRemove-Item\b.*-Recurse.*(C:\\|D:\\|E:\\)/i,
  /\bFormat-Volume\b|\bdiskpart\b/i
];

/** 命令检查：命中 deny 直接拒；配置了 allowCommands 则必须命中其一。 */
export function checkCommand(command, allowCommands = []) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, reason: 'E_COMMAND_DENIED', detail: '空命令' };
  for (const re of DENY_PATTERNS) {
    if (re.test(cmd)) return { ok: false, reason: 'E_COMMAND_DENIED', detail: `命中禁止规则 ${re}` };
  }
  const allow = Array.isArray(allowCommands) ? allowCommands.filter(Boolean) : [];
  if (allow.length) {
    const hit = allow.some((p) => cmd.toLowerCase().includes(String(p).toLowerCase()));
    if (!hit) return { ok: false, reason: 'E_COMMAND_DENIED', detail: '不在允许的命令前缀里' };
  }
  return { ok: true };
}

export function appendAudit(auditDir, record) {
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const file = path.join(auditDir, `audit-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch {}
}

export function scrubSecrets(text) {
  return String(text ?? '')
    .replace(/\b(sk-[A-Za-z0-9_\-]{12,})/g, 'sk-***')
    .replace(/\b(token|password|passwd|secret|apikey|api_key)\s*[:=]\s*\S+/gi, '$1=***');
}
