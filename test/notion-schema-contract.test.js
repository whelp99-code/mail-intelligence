import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  ACTIVITY_PROPERTY_MAP,
  displayConfidence,
  loadDeidentifiedSchema,
  schemaHash,
  validateActivityProposal,
  validateSchemaAccess,
  validateSchemaIdentity,
} from '../src/adapters/notion-schema-contract.js';

const FIXTURE = resolve('test/fixtures/notion-activity-schema.deidentified.json');

test('de-identified Activity schema has logical evidence fields and no live Notion ids', () => {
  const raw = readFileSync(FIXTURE, 'utf8');
  const withoutHash = raw.replace(/"schemaHash": "sha256:[0-9a-f]+"/i, '"schemaHash": "redacted"');
  assert.doesNotMatch(withoutHash, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(withoutHash, /[0-9a-f]{32}/i);
  assert.doesNotMatch(raw, /https:\/\/www\.notion\.so/);
  const schema = loadDeidentifiedSchema(FIXTURE);
  assert.equal(schema.operationalMapping, 'unverified');
  assert.equal(schema.logicalDatabase, '활동·히스토리');
  for (const name of Object.values(ACTIVITY_PROPERTY_MAP)) {
    assert.ok(schema.properties.some((item) => item.name === name), name);
  }
  const confidence = schema.properties.find((item) => item.name === '확신도');
  assert.equal(confidence.type, 'select');
  assert.deepEqual(confidence.options, ['높음', '보통', '낮음']);
  const hash = schemaHash(schema);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(schema.schemaHash, hash);
});

test('schema validator flags select mismatch, rename, bad relation, duplicate key, and read denial', () => {
  const schema = loadDeidentifiedSchema(FIXTURE);
  assert.equal(displayConfidence(0.91), '높음');
  assert.equal(displayConfidence(0.5), '보통');
  assert.equal(displayConfidence(0.2), '낮음');

  const selectMismatch = validateActivityProposal(schema, { confidenceDisplay: 0.81 });
  assert.equal(selectMismatch.ok, false);
  assert.ok(selectMismatch.errors.some((item) => item.code === 'SELECT_TYPE_MISMATCH'));

  const booleanReview = validateActivityProposal(schema, { reviewStatus: true });
  assert.equal(booleanReview.ok, false);
  assert.ok(booleanReview.errors.some((item) => item.code === 'SELECT_TYPE_MISMATCH' && item.property === '검토상태'));

  const renamed = validateActivityProposal(schema, { properties: { 신뢰도: 0.9 } });
  assert.equal(renamed.ok, false);
  assert.ok(renamed.errors.some((item) => item.code === 'RENAMED_PROPERTY'));

  const badRelation = validateActivityProposal(schema, {
    relations: { 프로젝트: 'missing-project' },
    knownRelationIds: ['syn-project-sunjin-hci'],
  });
  assert.equal(badRelation.ok, false);
  assert.ok(badRelation.errors.some((item) => item.code === 'BAD_RELATION'));

  const duplicate = validateActivityProposal(schema, {
    naturalKey: 'mail:syn-mail-quote:activity:inbound',
    existingNaturalKeys: ['mail:syn-mail-quote:activity:inbound'],
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((item) => item.code === 'NATURAL_KEY_DUPLICATE'));

  const denied = validateSchemaAccess(schema, { permission: 'none' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'INSUFFICIENT_READ_PERMISSION');

  const ok = validateActivityProposal(schema, {
    confidence: 0.91,
    confidenceDisplay: '높음',
    reviewStatus: '연결검토',
    evidenceTier: 'AI 추론',
    naturalKey: 'mail:syn-mail-quote:activity:inbound',
    existingNaturalKeys: [],
    relations: { 프로젝트: 'syn-project-sunjin-hci' },
    knownRelationIds: ['syn-project-sunjin-hci'],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.confidenceDisplay, '높음');
  assert.ok(ok.rawConfidenceStoredAt.includes('work_links.confidence'));
});

function schemaWithRecalculatedHash(base, mutate) {
  const schema = structuredClone(base);
  mutate(schema);
  schema.schemaHash = schemaHash(schema);
  return schema;
}

test('V03 rejects schema option gap, review type mismatch, and invalid evidence tier', () => {
  const base = loadDeidentifiedSchema(FIXTURE);

  const confidenceOptionsRemoved = schemaWithRecalculatedHash(base, (schema) => {
    const confidence = schema.properties.find((item) => item.name === '확신도');
    confidence.options = ['낮음'];
  });
  const removedOption = validateActivityProposal(confidenceOptionsRemoved, { confidenceDisplay: '높음' });
  assert.equal(removedOption.ok, false);
  assert.ok(removedOption.errors.some((item) => item.code === 'SELECT_TYPE_MISMATCH' && item.property === '확신도' && item.value === '높음'));

  const reviewAsCheckbox = schemaWithRecalculatedHash(base, (schema) => {
    const review = schema.properties.find((item) => item.name === '검토상태');
    review.type = 'checkbox';
    delete review.options;
  });
  const typeMismatch = validateActivityProposal(reviewAsCheckbox, { reviewStatus: '검증완료' });
  assert.equal(typeMismatch.ok, false);
  assert.ok(typeMismatch.errors.some((item) => (
    item.property === '검토상태'
    && (item.code === 'SELECT_TYPE_MISMATCH' || item.code === 'FIELD_TYPE_MISMATCH')
  )));

  const invalidTier = validateActivityProposal(base, { evidenceTier: 'INVALID-TIER-FIXTURE' });
  assert.equal(invalidTier.ok, false);
  assert.ok(invalidTier.errors.some((item) => item.property === '근거등급' && item.value === 'INVALID-TIER-FIXTURE'));
});

test('schema identity requires matching schemaHash and capturedAt without live Notion', () => {
  const schema = loadDeidentifiedSchema(FIXTURE);
  assert.equal(validateSchemaIdentity(schema).ok, true);
  assert.equal(validateSchemaIdentity(schema).capturedAt, '2026-09-11T00:00:00Z');
  assert.equal(validateSchemaIdentity({ ...schema, capturedAt: '' }).code, 'SCHEMA_CAPTURED_AT_MISSING');
  assert.equal(validateSchemaIdentity({ ...schema, schemaHash: '' }).code, 'SCHEMA_HASH_MISSING');
  assert.equal(validateSchemaIdentity({ ...schema, schemaHash: 'sha256:deadbeef' }).code, 'SCHEMA_HASH_MISMATCH');
  assert.equal(validateSchemaAccess({
    logicalDatabase: schema.logicalDatabase,
    properties: schema.properties,
  }).code, 'SCHEMA_CAPTURED_AT_MISSING');
});
