import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { catalogFor, rememberSession, selectSession, validateSessionName, parseSessionCommand } from '../src/session-catalog.js';

const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const key = 'group:100';
const makeState = () => ({ sessions: { [key]: 'old' }, presets: { [key]: 'standard-furina' }, presetOverrides: {} });

test('catalog migrates lazily, persists names and uses stable one-based indices', () => {
  const state = makeState();
  rememberSession(state, key, { sessionId: 'old', preset: 'standard-furina', name: '日常' });
  rememberSession(state, key, { sessionId: 'second', preset: 'qq-chat-v2', name: '开发' });
  const saved = JSON.parse(JSON.stringify(state));
  assert.equal(selectSession(saved, key, '1').sessionId, 'old');
  assert.equal(selectSession(saved, key, '开发').sessionId, 'second');
  assert.equal(selectSession(saved, key, 'second').preset, 'qq-chat-v2');
  assert.throws(() => rememberSession(saved, key, { sessionId: 'third', name: '开发' }), /名称已存在/);
  assert.equal(catalogFor(saved, key).length, 2);
});

test('arbitrary, cross-chat and unknown-preset sessions cannot be selected', () => {
  const state = makeState();
  rememberSession(state, key, { sessionId: 'old', preset: 'standard-furina' });
  assert.throws(() => selectSession(state, key, 'private-webui'), /没有这个会话/);
  assert.throws(() => rememberSession(state, 'private:200', { sessionId: 'old', preset: 'cordis' }), /其他 QQ/);
  state.sessionCatalog['private:200'] = [{ sessionId: 'old', name: '篡改', preset: 'cordis' }];
  assert.throws(() => selectSession(state, 'private:200', '篡改'), /其他 QQ/);
  rememberSession(state, key, { sessionId: 'unknown' });
  assert.throws(() => selectSession(state, key, 'unknown'), /preset 未记录/);
});

test('command aliases and names do not accept numeric or control-character labels', () => {
  assert.deepEqual(parseSessionCommand('/会话 切换 开发 讨论'), { op: 'switch', arg: '开发 讨论' });
  assert.deepEqual(parseSessionCommand('/sessions'), { op: 'list', arg: '' });
  assert.equal(parseSessionCommand('/sessionx'), null);
  assert.equal(validateSessionName(' 日常 '), '日常');
  for (const value of ['', '123', 'a\nb', 'a'.repeat(41)]) assert.throws(() => validateSessionName(value));
});

function harness() {
  const state = makeState();
  const context = {
    state, catalogFor, rememberSession, selectSession, validateSessionName, crypto,
    dshReady: true, sessionSwitches: new Set(), sessionVersions: new Map(),
    acceptedDeliveryQueues: new Map(), submittingDeliveryQueues: new Map(),
    reverse: new Map([['old', key]]), KNOWN_AGENT_TOKENS: new Set(['original-token']),
    st: { agentToken: 'original-token', unread: [1], activeTopics: ['共享话题'] },
    calls: [], saved: [], failCancel: false, failCreate: false,
    api: {}, log() {}, clearTimeout, pending: new Map(),
    sessionVersion(k) { return context.sessionVersions.get(k) || 0; },
    getSocialV2State() { return context.st; },
    saveState() { context.saved.push(JSON.parse(JSON.stringify(state))); },
    saveSocialV2State() {},
    unwrap(value) { if (!value.result.ok) throw new Error('cancel failed'); return value.result.value; },
    async ensureSession(k) {
      if (context.failCreate) throw new Error('create failed');
      state.sessions[k] = 'new'; state.presets[k] = 'standard-furina';
      context.reverse.set('new', k);
      return 'new';
    },
  };
  for (const name of ['collectors', 'collectorLastEventAt', 'activeTurnIdsBySession', 'v2TurnStartAt',
    'pendingSendToolCalls', 'toolCallNames', 'snapshotRefreshAt', 'sessionPromises', 'wakeConfigMissCount']) context[name] = new Map();
  context.sendToolSucceededSessions = new Set(); context.pendingWakeKeys = new Set();
  for (const name of ['drainRetryQueue', 'drainPromptQueue', 'cancelSocialTimers', 'clearSocialV2Timers',
    'legRevokeGrant', 'disarmPendingWakeLease', 'disarmTurnLease', 'scheduleProactiveCheckV2', 'setupSleepTimerV2']) {
    context[name] = (...args) => context.calls.push([name, ...args]);
  }
  context.cancelPendingEntry = async () => context.calls.push(['cancelPendingEntry']);
  context.api = {
    sessions: { cancel: async ({ sessionId }) => {
      assert.ok(context.sessionSwitches.has(key));
      assert.notEqual(context.st.agentToken, 'original-token');
      context.calls.push(['cancel', sessionId]);
      return { result: { ok: !context.failCancel, value: {} } };
    } },
    watchSession: async (sid) => context.calls.push(['watch', sid]),
    workspace: { unarchiveSession: async ({ sessionId }) => {
      context.calls.push(['unarchive', sessionId]);
      return { result: { ok: true, value: {} } };
    } },
  };
  const start = source.indexOf('  function rememberActiveSession(key)');
  const end = source.indexOf('  async function handleSessionCommand', start);
  assert.ok(start > 0 && end > start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.switchSession = switchDshSession;', context);
  return context;
}

test('switch cancels old turn, revokes old token/grant and restores the selected preset', async () => {
  const h = harness();
  const target = rememberSession(h.state, key, { sessionId: 'second', preset: 'qq-chat-v2', name: '开发' });
  const result = await h.switchSession(key, { target });
  assert.equal(result.name, '开发');
  assert.equal(h.state.sessions[key], 'second');
  assert.equal(h.state.presetOverrides[key], 'qq-chat-v2');
  assert.equal(h.reverse.has('old'), false);
  assert.equal(h.reverse.get('second'), key);
  assert.equal(h.st.bootstrapSent, false);
  assert.equal(h.st.unread.length, 0);
  assert.equal(h.st.activeTopics[0], '共享话题');
  assert.ok(h.calls.some(([name]) => name === 'legRevokeGrant'));
  assert.equal(h.sessionSwitches.size, 0);
  assert.equal(h.sessionVersion('group:200'), 0);
});

test('new session preserves old history and can switch back after a simulated restart', async () => {
  const h = harness();
  await h.switchSession(key, { name: '研究' });
  assert.equal(h.state.sessions[key], 'new');
  assert.equal(selectSession(h.state, key, '研究').sessionId, 'new');
  assert.equal(selectSession(JSON.parse(JSON.stringify(h.state)), key, 'old').preset, 'standard-furina');
  assert.equal(h.calls.some(([name]) => name === 'archive'), false);
});

test('failed cancellation or new-session creation restores the old binding', async () => {
  for (const failure of ['failCancel', 'failCreate']) {
    const h = harness(); h[failure] = true;
    h.state.presetOverrides[key] = 'standard-furina';
    await assert.rejects(h.switchSession(key, { name: '研究' }), /failed/);
    assert.equal(h.state.sessions[key], 'old');
    assert.equal(h.reverse.get('old'), key);
    assert.equal(h.state.presetOverrides[key], 'standard-furina');
    assert.equal(h.sessionSwitches.size, 0);
    assert.equal(h.st.bootstrapSent, false);
  }
});

test('a cold old session does not block selecting another session', async () => {
  const h = harness();
  h.api.sessions.cancel = async () => ({ result: { ok: false, error: { code: 'session/not-found' } } });
  await h.switchSession(key, { name: '研究' });
  assert.equal(h.state.sessions[key], 'new');
});

test('unstarted DSH submissions and concurrent switches are rejected before cancellation', async () => {
  for (const queue of ['acceptedDeliveryQueues', 'submittingDeliveryQueues']) {
    const h = harness(); h[queue].set('old', ['pending']);
    await assert.rejects(h.switchSession(key, { name: '研究' }), /排队投递|等待 DSH/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.sessions[key], 'old');
  }
  const h = harness(); h.sessionSwitches.add(key);
  await assert.rejects(h.switchSession(key, { name: '研究' }), /正在切换/);
});

test('an async media send authorized before switching cannot send after switching', async () => {
  const h = harness();
  h.toolRequestContext = new AsyncLocalStorage();
  const start = source.indexOf('  function assertCurrentSessionOutput(key)');
  const end = source.indexOf('\n  const promptQueues', start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.checkOutput = assertCurrentSessionOutput;', h);
  await h.toolRequestContext.run({ authorization: { key, version: 0 } }, async () => {
    h.checkOutput(key);
    await Promise.resolve(); // image generation / TTS / queued sending
    h.sessionVersions.set(key, 1);
    assert.throws(() => h.checkOutput(key), /旧工具请求/);
    h.checkOutput('group:200');
  });
});

test('a prompt building media during switching is discarded before DSH submission', async () => {
  const h = harness();
  let submitted = false;
  Object.assign(h, {
    ensureDelivery: () => ({ deliveryId: 'delivery', key }),
    signRestrictedTurnText: (_key, _sid, body) => body,
    withSlangContext: (s) => s,
    resolveMediaList: async () => { h.sessionVersions.set(key, 1); return []; },
    rollbackDelivery: () => {},
    beginDeliverySubmission: () => {},
  });
  h.api.sessions.prompt = async () => { submitted = true; };
  const start = source.indexOf('  async function deliverPromptNow(');
  const end = source.indexOf('\n  // 每个 QQ 会话串行投递', start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.deliver = deliverPromptNow;', h);
  const result = await h.deliver(key, '旧任务', { media: [{}] });
  assert.equal(result.superseded, true);
  assert.equal(submitted, false);
});

test('session commands require owner and run before pending-question consumption', () => {
  const start = source.indexOf('    const sessionCommand = parseSessionCommand(plainContent)');
  const end = source.indexOf("    if (p && (p.kind === 'question' || isOwner))", start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /if \(!isOwner\)/);
  assert.match(block, /handleNonOwnerAdminCommand/);
  assert.match(block, /handleSessionCommand/);
});
