// Only sessions registered to this QQ conversation may be selected. Never look
// up an arbitrary DSH session ID: that would expose unrelated private history.
const KEY = /^(group|private):[1-9]\d*$/;

export function catalogFor(state, key) {
  if (!KEY.test(key)) throw new Error('无效的 QQ 会话');
  if (!state.sessionCatalog || typeof state.sessionCatalog !== 'object' || Array.isArray(state.sessionCatalog)) state.sessionCatalog = {};
  if (!Array.isArray(state.sessionCatalog[key])) state.sessionCatalog[key] = [];
  return state.sessionCatalog[key];
}

export function validateSessionName(name) {
  const value = String(name ?? '').trim();
  if (!value || value.length > 40 || /^[0-9]+$/.test(value) || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new Error('会话名称需为 1～40 字，不能是纯数字或含换行');
  }
  return value;
}

export function rememberSession(state, key, { sessionId, preset = null, name, now = Date.now() }) {
  const list = catalogFor(state, key);
  if (!sessionId || typeof sessionId !== 'string') throw new Error('DSH 会话 ID 无效');
  for (const [otherKey, otherList] of Object.entries(state.sessionCatalog)) {
    if (otherKey !== key && Array.isArray(otherList) && otherList.some((s) => s.sessionId === sessionId)) {
      throw new Error('该 DSH 会话已经属于其他 QQ 聊天');
    }
  }
  if (Object.entries(state.sessions ?? {}).some(([k, sid]) => k !== key && sid === sessionId)) {
    throw new Error('该 DSH 会话已经属于其他 QQ 聊天');
  }
  let record = list.find((s) => s.sessionId === sessionId);
  const label = name === undefined ? record?.name : validateSessionName(name);
  if (label && list.some((s) => s !== record && s.name === label)) throw new Error('会话名称已存在');
  if (!record) {
    let n = list.length + 1;
    while (list.some((s) => s.name === `会话${n}`)) n++;
    record = { sessionId, name: label || `会话${n}`, preset, registeredAt: now };
    list.push(record);
  } else {
    if (label) record.name = label;
    if (preset) record.preset = preset;
  }
  return record;
}

export function selectSession(state, key, reference) {
  const list = catalogFor(state, key);
  const ref = String(reference ?? '').trim();
  const record = /^[1-9]\d*$/.test(ref)
    ? list[Number(ref) - 1]
    : list.find((s) => s.name === ref || s.sessionId === ref);
  if (!record) throw new Error('本 QQ 聊天没有这个会话，请先用 /session list 查看');
  if (!record.preset) throw new Error('该历史会话的 preset 未记录，不能安全切换');
  // Re-run ownership checks even for a manually edited/corrupted catalog.
  rememberSession(state, key, record);
  return record;
}

export function parseSessionCommand(text) {
  const match = /^\/(?:session|sessions|会话)(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  const rest = (match[1] || '').trim();
  const action = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  const op = (action?.[1] || 'list').toLowerCase();
  const aliases = { '列表': 'list', '新建': 'new', '切换': 'switch', '重命名': 'rename', '当前': 'current' };
  return { op: aliases[op] || op, arg: (action?.[2] || '').trim() };
}
