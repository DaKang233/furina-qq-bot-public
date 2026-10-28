import assert from 'node:assert/strict';
import { createErrorRouter } from '../src/error-routing.js';

let timestamp = 100000;
const sent = [];
const logs = [];
const cfg = {
  errorRouting: {
    enabled: true,
    targetQQ: '90001',
    sourcePolicy: 'silent',
    deduplicateMs: 60000
  }
};
const route = createErrorRouter({
  getConfig: () => cfg,
  sendToQQ: async (key, message) => sent.push({ key, message }),
  log: (message) => logs.push(message),
  redact: (message) => message.replaceAll('TOKEN', '***'),
  isSensitive: (message) => message.includes('C:\\secret'),
  now: () => timestamp
});

await route('group:10001', 'agent-error', 'failed TOKEN');
assert.equal(sent.length, 1);
assert.equal(sent[0].key, 'private:90001');
assert.match(sent[0].message, /来源：group:10001/);
assert.doesNotMatch(sent[0].message, /TOKEN/);

await route('group:10001', 'agent-error', 'failed TOKEN');
assert.equal(sent.length, 1, 'duplicate error must not send again');

timestamp += 60001;
await route('private:20001', 'security-intercept', 'C:\\secret\\token.txt');
assert.equal(sent.length, 2);
assert.match(sent[1].message, /详情含敏感信息/);

cfg.errorRouting.sourcePolicy = 'generic';
timestamp += 60001;
await route('group:30001', 'prompt-rejected', 'bad request');
assert.equal(sent.length, 4);
assert.equal(sent[2].key, 'private:90001');
assert.equal(sent[3].key, 'group:30001');
assert.equal(sent[3].message, '⚠️ 处理失败，请稍后重试。');

console.log('error routing tests passed');
