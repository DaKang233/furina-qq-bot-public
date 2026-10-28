// Node 环境的 DSH 0.2.1 Web API 客户端。
// 一元 RPC 走官方 Connection 信封；会话日志和交互事件共用 /api/remote.mux。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const DEFAULT_AUTH_FILE = fileURLToPath(new URL('../state/dsh-auth.json', import.meta.url));

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
    this.error = null;
  }

  push(value) {
    if (this.ended || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.items.push(value);
  }

  end() {
    if (this.ended || this.error) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error) {
    if (this.ended || this.error) return;
    this.error = error instanceof Error ? error : new Error(String(error));
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
  }

  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator]() { return this; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function responseValue(value) {
  return { type: 'server-response', rpcId: randomUUID(), result: { ok: true, value } };
}

export class NodeApiClient {
  constructor(baseUrl, timeoutMs) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3081').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs ?? 30_000;
    this.authFile = process.env.DSH_AUTH_FILE || DEFAULT_AUTH_FILE;
    this.launchToken = process.env.DSH_LAUNCH_TOKEN || '';
    this.cookie = this.readSavedCookie();
    this.socket = null;
    this.socketPromise = null;
    this.streams = new Map();
    this.watchedSessions = new Set();
    this.activeEventMux = null;
    this.waterfalls = new Map();

    this.host = { describe: () => this.describeHost() };
    this.agentPresets = { list: () => this.rpc('agentPresets/list', {}) };
    this.settings = { describe: () => this.rpc('settings/describe', {}) };
    this.sessions = {
      create: (request = {}) => this.createSession(request),
      prompt: (request) => this.promptSession(request),
      cancel: (request) => this.rpcRequest('session/cancel', request),
      selectModel: (request) => this.rpcRequest('session/selectModel', request),
    };
    this.workspace = {
      create: (request) => this.rpcRequest('workspace/create', request),
      rename: (request) => this.rpcRequest('workspace/rename', request),
      delete: (request) => this.rpcRequest('workspace/delete', request),
      archiveSession: (request) => this.rpcRequest('workspace/archiveSession', request),
      unarchiveSession: (request) => this.rpcRequest('workspace/unarchiveSession', request),
      list: () => this.workspaceList(),
    };
    this.events = { mux: (_payload, signal, onOpen) => this.readEvents(signal, onOpen) };
  }

  readSavedCookie() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      return saved?.baseUrl === this.baseUrl && typeof saved.cookie === 'string' ? saved.cookie : '';
    } catch {
      return '';
    }
  }

  saveCookie(cookie) {
    fs.mkdirSync(path.dirname(this.authFile), { recursive: true });
    fs.writeFileSync(this.authFile, JSON.stringify({ version: 1, baseUrl: this.baseUrl, cookie }, null, 2) + '\n', { mode: 0o600 });
  }

  async refreshCookie() {
    if (!this.launchToken) {
      throw new Error('DSH Web API 尚未授权：请用当前 WebUI 启动令牌设置 DSH_LAUNCH_TOKEN 后运行一次桥接或自检');
    }
    const url = new URL('/', this.baseUrl);
    url.searchParams.set('token', this.launchToken);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status !== 303) throw new Error(`DSH Web API 授权失败：HTTP ${response.status}`);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('DSH Web API 授权响应没有签名 Cookie');
    this.cookie = cookie;
    this.saveCookie(cookie);
    return cookie;
  }

  async ensureCookie() {
    return this.cookie || this.refreshCookie();
  }

  async rpc(endpoint, args, retry = true) {
    const cookie = await this.ensureCookie();
    const rpcId = randomUUID();
    const response = await fetch(new URL(`/api/${endpoint}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401 && retry && this.launchToken) {
      this.cookie = '';
      await this.refreshCookie();
      return this.rpc(endpoint, args, false);
    }
    if (!response.ok) throw new Error(`DSH transport ${endpoint}: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== 'server-response' || body.rpcId !== rpcId || !body.result) {
      throw new Error(`DSH transport ${endpoint}: invalid response envelope`);
    }
    return body;
  }

  rpcRequest(endpoint, request) {
    return this.rpc(endpoint, { request });
  }

  async describeHost() {
    const probe = await this.rpc('agentPresets/list', {});
    if (!probe.result.ok) {
      const { code, message } = probe.result.error;
      throw new Error(`DSH readiness failed: ${code}: ${message}`);
    }
    return responseValue({ cwd: process.cwd(), apiVersion: '0.2.1' });
  }

  async createSession(request) {
    const response = await this.rpcRequest('session/create', request);
    if (response.result.ok && response.result.value?.sessionId) {
      await this.watchSession(response.result.value.sessionId);
    }
    return response;
  }

  async promptSession(request) {
    const response = await this.rpcRequest('session/prompt', {
      requestId: request?.requestId || randomUUID(),
      ...request,
    });
    if (response.result.ok && response.result.value && !response.result.value.command) {
      response.result.value.command = { text: '' };
    }
    return response;
  }

  async workspaceList() {
    const stream = await this.openStream('workspace/follow', { args: {} });
    try {
      const first = await stream.queue.next();
      if (first.done || !first.value || !['baseline', 'replace'].includes(first.value.type)) {
        throw new Error('workspace/follow did not return a baseline');
      }
      return responseValue(first.value.value);
    } finally {
      stream.cancel();
    }
  }

  watchSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    this.watchedSessions.add(String(sessionId));
    return this.activeEventMux?.watchSession(String(sessionId)) ?? Promise.resolve();
  }

  // 孤儿判断必须以服务端 snapshot 为准；需要校准时主动重订阅，而不是按本地静默时长猜测。
  refreshSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    this.watchedSessions.add(String(sessionId));
    return this.activeEventMux?.refreshSession(String(sessionId)) ?? Promise.resolve(false);
  }

  async ensureSocket(retry = true) {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.socketPromise) return this.socketPromise;
    const cookie = await this.ensureCookie();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socketPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Cookie: cookie } });
      let settled = false;
      socket.once('open', () => {
        settled = true;
        this.socket = socket;
        resolve(socket);
      });
      socket.once('error', (error) => {
        if (!settled) reject(error);
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.failSocket(new Error('DSH remote.mux returned a binary frame'));
          return;
        }
        try { this.handleSocketFrame(JSON.parse(data.toString('utf8'))); }
        catch (error) { this.failSocket(new Error('DSH remote.mux returned an invalid frame', { cause: error })); }
      });
      socket.once('close', () => {
        if (!settled) reject(new Error('DSH remote.mux closed before opening'));
        if (this.socket === socket) this.socket = null;
        this.failStreams(new Error('DSH remote.mux connection closed'));
      });
    }).finally(() => { this.socketPromise = null; });
    try {
      return await this.socketPromise;
    } catch (error) {
      if (retry && this.launchToken) {
        this.cookie = '';
        await this.refreshCookie();
        return this.ensureSocket(false);
      }
      throw error;
    }
  }

  failSocket(error) {
    this.failStreams(error);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(4002, 'invalid remote frame');
  }

  failStreams(error) {
    for (const stream of this.streams.values()) stream.queue.fail(error);
    this.streams.clear();
  }

  handleSocketFrame(frame) {
    if (!frame || typeof frame.streamId !== 'string' || !['item', 'error', 'end'].includes(frame.type)) {
      throw new Error('invalid remote stream frame');
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    if (frame.type === 'item') stream.queue.push(frame.value);
    else if (frame.type === 'error') {
      const error = new Error(`${frame.error?.code ?? 'gateway/internal'}: ${frame.error?.message ?? 'remote stream failed'}`);
      error.code = frame.error?.code;
      error.details = frame.error?.details;
      stream.queue.fail(error);
      this.streams.delete(frame.streamId);
    } else {
      stream.queue.end();
      this.streams.delete(frame.streamId);
    }
  }

  async openStream(endpoint, payload) {
    const socket = await this.ensureSocket();
    const streamId = randomUUID();
    const queue = new AsyncQueue();
    const stream = { streamId, queue };
    this.streams.set(streamId, stream);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
    return {
      ...stream,
      cancel: () => {
        if (!this.streams.delete(streamId)) return;
        queue.end();
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
      },
    };
  }

  async *readEvents(signal, onOpen) {
    const own = signal === undefined ? new AbortController() : null;
    const actualSignal = signal ?? own.signal;
    const adapter = new EventMuxAdapter(this, actualSignal);
    this.activeEventMux = adapter;
    try {
      await adapter.start();
      onOpen?.();
      for await (const envelope of adapter.output) yield envelope;
    } finally {
      if (this.activeEventMux === adapter) this.activeEventMux = null;
      await adapter.close();
      if (this.streams.size === 0 && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.close(1000, 'event consumer closed');
      }
      own?.abort();
    }
  }

  async respond(response) {
    const eventId = response?.rpcId;
    const pending = this.waterfalls.get(eventId);
    if (!pending) throw new Error(`DSH interaction ${String(eventId)} is no longer pending`);
    const value = response?.result?.value;
    let outcome;
    if (response?.result?.ok !== true) {
      outcome = { kind: 'rejected', error: { name: 'Error', message: 'client rejected the interaction' } };
    } else if (pending.kind === 'question') {
      const answer = value?.answer;
      outcome = Array.isArray(answer?.answers) && answer.answers.length > 0
        ? { kind: 'result', value: answer }
        : { kind: 'rejected', error: { name: 'Error', message: 'question cancelled', code: 'ASK_ABORTED' } };
    } else if (pending.kind === 'approval') {
      outcome = { kind: 'result', value: value?.outcome === 'allowed-once' ? 'allowed-once' : 'rejected' };
    } else {
      outcome = { kind: 'next' };
    }
    const result = await this.rpc('$events/result', { clientId: pending.clientId, eventId, outcome });
    if (result.result.ok) this.waterfalls.delete(eventId);
    return result;
  }
}

class EventMuxAdapter {
  constructor(client, signal) {
    this.client = client;
    this.signal = signal;
    this.output = new AsyncQueue();
    this.global = null;
    this.sessionStarts = new Map();
    this.sessionStreams = new Map();
    this.sessionRetryTimers = new Map(); // sessionId -> 重订阅定时器
    this.sessionRetryCount = new Map();  // sessionId -> 已重试次数
    this.refreshingSessions = new Set(); // 主动校准中的会话不再叠加自动重试
    this.closed = false;
    this.abort = () => this.output.end();
    signal.addEventListener('abort', this.abort, { once: true });
  }

  async start() {
    this.signal.throwIfAborted();
    const globalReady = deferred();
    this.global = await this.client.openStream('$events', { args: {} });
    this.pumpGlobal(this.global, globalReady).catch((error) => this.output.fail(error));
    const sessions = [...this.client.watchedSessions];
    await Promise.all([globalReady.promise, ...sessions.map((id) => this.watchSession(id))]);
  }

  watchSession(sessionId) {
    if (this.closed) return Promise.resolve();
    const existing = this.sessionStarts.get(sessionId);
    if (existing) return existing;
    const start = this.startSession(sessionId).catch((error) => {
      console.warn(`[dsh-client] 无法跟踪会话 ${sessionId}: ${error?.message ?? error}`);
      // 连 snapshot 都没拿到也要进入重订阅，否则 sessionStarts 会把失败永久缓存。
      if (!this.closed) this.scheduleSessionResubscribe(sessionId);
    });
    this.sessionStarts.set(sessionId, start);
    return start;
  }

  async refreshSession(sessionId) {
    if (this.closed) return false;
    const timer = this.sessionRetryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.sessionRetryTimers.delete(sessionId);
    this.refreshingSessions.add(sessionId);
    try {
      this.sessionStreams.get(sessionId)?.cancel();
      this.sessionStreams.delete(sessionId);
      this.sessionStarts.delete(sessionId);
      // 主动重订阅拿新 snapshot，供 bridge 重建真实活跃 turn。
      await this.watchSession(sessionId);
      this.sessionRetryCount.delete(sessionId);
      return true;
    } finally {
      this.refreshingSessions.delete(sessionId);
    }
  }

  // 单会话事件流断了要自己重订阅：否则收不到 turn/start、turn/end，也无法用 snapshot 校准孤儿状态。
  scheduleSessionResubscribe(sessionId) {
    if (this.closed) return;
    const attempt = (this.sessionRetryCount.get(sessionId) ?? 0) + 1;
    this.sessionRetryCount.set(sessionId, attempt);
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt - 1));
    if (this.sessionRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.sessionRetryTimers.delete(sessionId);
      if (this.closed) return;
      this.sessionStarts.delete(sessionId);
      console.warn(`[dsh-client] 重订阅会话事件流 ${sessionId}（第 ${attempt} 次）`);
      this.watchSession(sessionId).catch(() => {});
    }, delay);
    timer.unref?.();
    this.sessionRetryTimers.set(sessionId, timer);
  }

  async startSession(sessionId) {
    const stream = await this.client.openStream('session/follow', {
      args: { request: { address: { kind: 'session', sessionId } } },
    });
    if (this.closed) { stream.cancel(); return; }
    this.sessionStreams.set(sessionId, stream);
    const first = await stream.queue.next();
    if (first.done || first.value?.type !== 'snapshot') {
      stream.cancel();
      throw new Error('session/follow did not return a snapshot');
    }
    // snapshot 不能丢：桥接靠它校准活跃 turn，避免把慢 turn 当孤儿或让已结束 turn 永久占 busy。
    this.output.push({
      rpcId: `${stream.streamId}:snapshot`,
      payload: { type: 'session/snapshot', sessionId, snapshot: first.value },
    });
    this.sessionRetryCount.delete(sessionId);
    this.pumpSession(sessionId, stream).catch((error) => {
      if (!this.closed) console.warn(`[dsh-client] 会话事件流 ${sessionId} 中断: ${error?.message ?? error}`);
    });
  }

  async pumpSession(sessionId, stream) {
    try {
      for await (const frame of stream.queue) {
        if (frame?.type !== 'event' || !frame.event) continue;
        this.output.push({
          rpcId: `${stream.streamId}:${String(frame.event.seq ?? randomUUID())}`,
          payload: { type: 'session/event', sessionId, event: frame.event },
        });
      }
    } finally {
      if (this.sessionStreams.get(sessionId) === stream) this.sessionStreams.delete(sessionId);
      // 非主动关闭 → 断线，安排重订阅（指数退避，最长 60 秒）
      if (!this.closed && !this.refreshingSessions.has(sessionId)) this.scheduleSessionResubscribe(sessionId);
    }
  }

  async pumpGlobal(stream, ready) {
    let clientId = '';
    try {
      for await (const frame of stream.queue) {
        if (frame?.type === 'ready') {
          clientId = frame.clientId;
          ready.resolve();
          continue;
        }
        if (frame?.type === 'cancel') {
          this.client.waterfalls.delete(frame.eventId);
          continue;
        }
        if (frame?.type !== 'waterfall' || !clientId) continue;
        if (frame.event === 'user-questions/request') {
          this.client.waterfalls.set(frame.eventId, { kind: 'question', clientId });
          this.output.push({
            rpcId: frame.eventId,
            payload: {
              type: 'question/requested',
              sessionId: frame.agentId,
              questions: Array.isArray(frame.request?.questions) ? frame.request.questions : [],
            },
          });
        } else if (frame.event === 'approval/request') {
          this.client.waterfalls.set(frame.eventId, { kind: 'approval', clientId });
          this.output.push({
            rpcId: frame.eventId,
            payload: {
              type: 'approval/requested',
              sessionId: frame.agentId,
              approvalId: frame.eventId,
              toolName: frame.request?.toolName ?? '',
              reason: frame.request?.displayReason?.['zh-CN'] ?? frame.request?.reason ?? '',
            },
          });
        } else {
          this.client.waterfalls.set(frame.eventId, { kind: 'next', clientId });
          await this.client.respond({ type: 'client-response', rpcId: frame.eventId, result: { ok: true, value: {} } });
        }
      }
      ready.resolve();
      this.output.end();
    } catch (error) {
      ready.reject(error);
      this.output.fail(error);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    this.global?.cancel();
    for (const stream of this.sessionStreams.values()) stream.cancel();
    this.sessionStreams.clear();
    // 关闭 mux 时取消未触发的重订阅，避免旧 adapter 复活会话流。
    for (const timer of this.sessionRetryTimers.values()) clearTimeout(timer);
    this.sessionRetryTimers.clear();
    this.refreshingSessions.clear();
    this.output.end();
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map();
  return {
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') return null;
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) { return turns.has(turn); },
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
