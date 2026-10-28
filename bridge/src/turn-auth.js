import crypto from 'node:crypto';

export const TURN_AUTH_PREFIX = '<!--DSH_QQ_TURN_AUTH_V1:';

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function sealTurnPrompt(secret, { sessionId, userId = '', privileged = false, text }) {
  if (!secret) throw new Error('QQ turn auth secret is empty');
  const body = String(text ?? '');
  const payload = {
    v: 1,
    sid: String(sessionId ?? ''),
    uid: String(userId ?? ''),
    privileged: privileged === true,
    nonce: crypto.randomBytes(16).toString('base64url'),
    bodyHash: sha256Base64Url(body),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  return `${TURN_AUTH_PREFIX}${encoded}:${signature}-->\n${body}`;
}

