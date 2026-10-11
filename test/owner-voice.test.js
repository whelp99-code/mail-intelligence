import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOwnerVoice, deriveOwnerVoiceProfile } from '../src/domain/owner-voice.js';

const base = JSON.parse(readFileSync(new URL('../data/config/owner-voice-profile.v1.json', import.meta.url), 'utf8'));

test('derives repeated owner greetings and closings without retaining message text', () => {
  const profile = deriveOwnerVoiceProfile([
    { id: 'sent-2', body_text: '안녕하세요.\n요청하신 자료 보내드립니다.\n감사합니다.' },
    { id: 'sent-1', body: '안녕하세요.\n확인했습니다.\n감사합니다.' },
    { id: 'sent-3', body_text: '안녕하십니까.\n검토하겠습니다.\n고맙습니다.' },
  ], base);

  assert.deepEqual(profile.greetings[0], {
    id: 'learned-1', pattern: '안녕하세요', count: 2, examples: [],
  });
  assert.deepEqual(profile.closings[0], {
    id: 'learned-1', pattern: '감사합니다.', count: 2, examples: [],
  });
  assert.deepEqual(profile.builtFrom.evidenceIds, ['sent-1', 'sent-2', 'sent-3']);
  assert.equal(JSON.stringify(profile).includes('요청하신 자료'), false);
  assert.equal(profile.version, base.version);
  assert.deepEqual(profile.formalityByDomain, base.formalityByDomain);
});

test('empty Sent Items history preserves configured patterns', () => {
  const profile = deriveOwnerVoiceProfile([], base);
  assert.deepEqual(profile.greetings, base.greetings);
  assert.deepEqual(profile.closings, base.closings);
  assert.deepEqual(profile.sentenceEndings, base.sentenceEndings);
  assert.deepEqual(profile.builtFrom.evidenceIds, []);
});

test('learned greeting and closing are applied to a generated draft, not just returned as profile metadata', () => {
  const profile = deriveOwnerVoiceProfile([
    { id: 'sent-tone', body_text: '안녕하십니까.\n검토 부탁드립니다.\n고맙습니다.' },
  ], base);
  const voiced = applyOwnerVoice('담당자님, 안녕하세요.\n\n본문입니다.\n\n감사합니다.\n박재민 드림', {
    profile, recipients: ['buyer@example.com'],
  }).body;
  assert.match(voiced, /^담당자님, 안녕하십니까\./);
  assert.match(voiced, /고맙습니다\.$/);
  assert.doesNotMatch(voiced, /감사합니다\.\n박재민 드림/);
});

test('quoted and forwarded customer text cannot spoof learned patterns', () => {
  const profile = deriveOwnerVoiceProfile([{
    id: 'spoofed',
    body_text: [
      '안녕하세요.',
      '내부 내용입니다.',
      '',
      '-----Original Message-----',
      '안녕하십니까.',
      '박재민 드림',
      '고객의 전화번호 010-1234-5678',
    ].join('\n'),
  }, {
    id: 'quoted-lines',
    body: '확인했습니다.\n> 안녕하십니까.\n> 고객님 드림\n감사합니다.',
  }], base);

  assert.equal(profile.greetings[0].pattern, '안녕하세요');
  assert.deepEqual(profile.closings, base.closings);
  assert.equal(JSON.stringify({
    greetings: profile.greetings,
    sentenceEndings: profile.sentenceEndings,
  }).includes('010-1234'), false);
});

test('formal recipient override uses configured Nexias greeting without inventing names', () => {
  const body = applyOwnerVoice('안녕하세요.\n요청 내용을 확인했습니다.\n{기본 서명}', {
    profile: base,
    recipients: ['buyer@nexias.co.kr'],
  });
  assert.equal(body.formality, 'standard');
  assert.match(body.body, /^양해광 상무님, 안녕하세요\./);
  assert.match(body.body, /감사합니다\.\n박재민 드림/);

  const formalProfile = {
    ...base,
    defaultFormality: 'formal',
    greetings: [{ id: 'formal-hello', pattern: '안녕하십니까' }],
    closings: [{ id: 'formal-thanks', pattern: '감사드립니다.' }],
  };
  const formal = applyOwnerVoice('본문입니다.', { profile: formalProfile, recipients: ['unknown@example.com'] });
  assert.match(formal.body, /^안녕하십니까\n\n본문입니다\./);
  assert.match(formal.body, /감사드립니다\./);
  assert.doesNotMatch(formal.body, /님/);
});

test('reapplying voice does not duplicate greeting, closing, or signature', () => {
  const once = applyOwnerVoice('안녕하세요.\n본문입니다.\n{기본 서명}', {
    profile: base,
    recipients: ['buyer@gsenc.com'],
  });
  const twice = applyOwnerVoice(once.body, { profile: base, recipients: ['buyer@gsenc.com'] });
  assert.equal(twice.body, once.body);
  assert.equal(twice.body.split(base.signature.block).length - 1, 1);
  assert.equal((twice.body.match(/감사합니다\.\n박재민 드림/g) || []).length, 1);
});

test('explicit Nexias salutation replaces generated placeholder without dropping greeting', () => {
  const profile = {
    ...base,
    salutationsByDomain: { 'nexias.co.kr': '양해광 상무님' },
  };
  const derived = deriveOwnerVoiceProfile([], profile);
  assert.deepEqual(derived.salutationsByDomain, profile.salutationsByDomain);
  const voiced = applyOwnerVoice('{확인 필요} {확인 필요}님, 안녕하세요.\n첫 문단입니다.\n\n둘째 문단입니다.', {
    profile: derived,
    recipients: ['recipient@nexias.co.kr'],
  });
  assert.match(voiced.body, /^양해광 상무님, 안녕하세요\./);
  assert.match(voiced.body, /첫 문단입니다\.\n\n둘째 문단입니다\./);
  assert.doesNotMatch(voiced.body, /\{확인 필요\}/);
});
