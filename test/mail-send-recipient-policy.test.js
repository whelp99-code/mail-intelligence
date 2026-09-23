import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMailSendRecipientsAllowed,
  mailSendRecipientAllowlistFromEnvironment,
} from '../src/security/mail-send-recipient-policy.js';

test('recipient allowlist is optional and normalizes exact addresses', () => {
  assert.equal(mailSendRecipientAllowlistFromEnvironment({}), null);
  assert.deepEqual(
    mailSendRecipientAllowlistFromEnvironment({
      MAIL_INTELLIGENCE_SEND_RECIPIENT_ALLOWLIST: ' Owner.Test@Example.com,second@example.com,owner.test@example.com ',
    }),
    ['owner.test@example.com', 'second@example.com'],
  );
});

test('configured empty or invalid recipient allowlist fails closed', () => {
  for (const value of ['', '   ', ',', 'allowed@example.com,', 'not-an-address', 'a@example.com\nb@example.com']) {
    assert.throws(
      () => mailSendRecipientAllowlistFromEnvironment({ MAIL_INTELLIGENCE_SEND_RECIPIENT_ALLOWLIST: value }),
      { code: 'MAIL_SEND_RECIPIENT_ALLOWLIST_INVALID' },
    );
  }
});

test('recipient policy checks normalized to and cc without exposing an address', () => {
  const allowlist = ['owner.test@example.com'];
  assert.doesNotThrow(() => assertMailSendRecipientsAllowed(allowlist, {
    to: ['OWNER.TEST@example.com'], cc: [],
  }));
  for (const draft of [
    { to: ['blocked@example.com'], cc: [] },
    { to: ['owner.test@example.com'], cc: ['blocked@example.com'] },
  ]) {
    assert.throws(() => assertMailSendRecipientsAllowed(allowlist, draft), (error) => {
      assert.equal(error.code, 'RECIPIENT_NOT_ALLOWED');
      assert.equal(error.statusCode, 403);
      assert.equal(error.message.includes('blocked@example.com'), false);
      return true;
    });
  }
});
