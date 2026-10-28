import assert from 'node:assert/strict';
import {
  isConversationAllowed,
  selectConversationPreset
} from '../src/preset-routing.js';

const cfg = {
  ownerQQ: '10001',
  agentPreset: 'qq-chat',
  allowAllWhenEmpty: false,
  allow: { private: ['20001'], groups: ['30001'] },
  standardAllow: { private: ['40001'], groups: ['50001'] },
  deny: { private: ['60001'], groups: ['70001'] },
  socialV2: { agentPreset: 'qq-chat-v2' }
};

assert.equal(isConversationAllowed('private:10001', 'chat', cfg), true);
assert.equal(selectConversationPreset('private:10001', 'chat', cfg), 'cordis');
assert.equal(selectConversationPreset('private:10001', 'reserved2', cfg), 'cordis');

assert.equal(isConversationAllowed('private:40001', 'chat', cfg), true);
assert.equal(isConversationAllowed('group:50001', 'chat', cfg), true);
assert.equal(selectConversationPreset('private:40001', 'chat', cfg), 'restricted-standard');
assert.equal(selectConversationPreset('group:50001', 'reserved2', cfg), 'restricted-standard');

assert.equal(isConversationAllowed('private:20001', 'chat', cfg), true);
assert.equal(isConversationAllowed('group:30001', 'chat', cfg), true);
assert.equal(selectConversationPreset('private:20001', 'chat', cfg), 'qq-chat');
assert.equal(selectConversationPreset('group:30001', 'reserved2', cfg), 'qq-chat-v2');

assert.equal(isConversationAllowed('private:60001', 'chat', cfg), false);
assert.equal(isConversationAllowed('group:70001', 'chat', cfg), false);
assert.equal(isConversationAllowed('private:80001', 'chat', cfg), false);
assert.equal(isConversationAllowed('group:90001', 'chat', cfg), false);

assert.equal(isConversationAllowed('private:10001', 'closed-agent', cfg), true);
assert.equal(isConversationAllowed('private:20001', 'closed-agent', cfg), false);
assert.equal(selectConversationPreset('private:10001', 'closed-agent', cfg, 'standard'), 'cordis');

console.log('preset routing tests passed');
