import assert from 'node:assert/strict';
import { domainFromAddress, resolveEntityForMessage, toEntityCandidates } from '../src/entityResolution.mjs';

const partner = resolveEntityForMessage({
  id: 'm1',
  from: 'sales@partner.co.kr',
  fromName: 'Partner Inc',
  subject: '총판 협력 제안',
  bodyPreview: 'partner program'
}, { mailboxUser: 'me@blro.co.kr' });

assert.equal(partner?.entityRole, 'partner');
assert.ok(partner.confidence >= 0.7);

const customer = resolveEntityForMessage({
  id: 'm2',
  from: 'buyer@acme.com',
  subject: '견적 요청',
  bodyPreview: 'quote for VDI'
}, { mailboxUser: 'me@blro.co.kr' });

assert.equal(customer?.entityRole, 'customer');

const list = toEntityCandidates({
  mailboxUser: 'me@blro.co.kr',
  messages: [
    { id: 'm1', from: 'a@acme.com', fromName: 'Acme', subject: '견적', bodyPreview: 'quote' },
    { id: 'm2', from: 'b@acme.com', fromName: 'Acme B', subject: 'follow up', bodyPreview: 'po' }
  ],
  threadGroups: [{ key: 't1', label: 'Acme 견적', participants: ['a@acme.com'], count: 2 }]
});

assert.equal(list.length, 1);
assert.equal(list[0].domain, 'acme.com');
assert.ok(list[0].messageCount >= 2);

console.log('verify-entity-resolution: PASS');
