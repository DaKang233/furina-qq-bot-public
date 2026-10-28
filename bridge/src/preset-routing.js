function listFor(scope, kind) {
  if (!scope || typeof scope !== 'object') return [];
  if (kind === 'group') return scope.groups ?? scope.group ?? [];
  if (kind === 'private') return scope.private ?? scope.privates ?? [];
  return [];
}

function includesId(scope, kind, id) {
  return listFor(scope, kind).map(String).includes(String(id));
}

export function parseConversationKey(key) {
  const match = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!match) return null;
  return { kind: match[1], id: match[2] };
}

export function isOwnerPrivate(key, cfg) {
  const conversation = parseConversationKey(key);
  return conversation?.kind === 'private'
    && cfg?.ownerQQ != null
    && conversation.id === String(cfg.ownerQQ);
}

export function isDeniedConversation(key, cfg) {
  const conversation = parseConversationKey(key);
  return !!conversation && includesId(cfg?.deny, conversation.kind, conversation.id);
}

export function isStandardAllowed(key, cfg) {
  const conversation = parseConversationKey(key);
  return !!conversation && includesId(cfg?.standardAllow, conversation.kind, conversation.id);
}

export function isConversationAllowed(key, mode, cfg) {
  const conversation = parseConversationKey(key);
  if (!conversation) return false;

  // 封闭模式沿用原语义：仅管理员私聊可进入。
  if (mode === 'closed-agent') return isOwnerPrivate(key, cfg);
  // 普通模式下显式拒绝优先于管理员、Standard 与普通允许列表。
  if (isDeniedConversation(key, cfg)) return false;
  if (isOwnerPrivate(key, cfg) || isStandardAllowed(key, cfg)) return true;

  const allowList = listFor(cfg?.allow, conversation.kind);
  if (allowList.length > 0) return allowList.map(String).includes(conversation.id);
  return cfg?.allowAllWhenEmpty === true;
}

export function selectConversationPreset(key, mode, cfg, closedAgentPreset = 'router-standard') {
  // 管理员私聊永远使用 Cordis；受限 Standard 必须逐会话显式授权。
  if (isOwnerPrivate(key, cfg)) return 'cordis';
  if (isStandardAllowed(key, cfg)) return 'restricted-standard';
  if (mode === 'closed-agent') return closedAgentPreset || 'router-standard';
  if (mode === 'reserved2') return cfg?.socialV2?.agentPreset || 'qq-chat-v2';
  return cfg?.agentPreset || 'qq-chat';
}
