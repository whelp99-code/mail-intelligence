#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const WORK_STATES = new Set(['action_required', 'waiting', 'decision_required', 'completed', 'reference', 'review_required']);
const NEXT_ACTORS = new Set(['me', 'internal_team', 'external_party', 'shared', 'none', 'unknown']);
const PRIORITIES = new Set(['critical', 'high', 'normal', 'low']);
const LABEL_ADMISSIBILITY_CONTRACT_VERSION = 'current-message-evidence-v1';
const ACTIONABLE_WORK_STATES = new Set(['action_required', 'waiting', 'decision_required']);
const CURRENT_CONTENT_FIELDS = new Set(['currentContent']);
const CURRENT_METADATA_FIELDS = new Set(['direction', 'lifecycle', 'isDraft', 'isPromotional', 'receivedAt', 'sentAt', 'importance', 'folderName']);
const FORBIDDEN_EVIDENCE_SOURCE = /(?:quoted|history|footer|disclaimer)/i;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

function fail(message) {
  console.error(JSON.stringify({ command: 'finalize-blind-holdout', status: 'ERROR', message }, null, 2));
  process.exit(2);
}


function validateCurrentEvidence(sample, index) {
  const evidence = sample.currentEvidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail(`samples[${index}].currentEvidence is required for actionable labels.`);
  }
  const source = String(evidence.source || '').trim();
  const field = String(evidence.field || '').trim();
  if (FORBIDDEN_EVIDENCE_SOURCE.test(source) || FORBIDDEN_EVIDENCE_SOURCE.test(field)) {
    fail(`samples[${index}].currentEvidence cannot rely on quoted history, footer, or disclaimer evidence.`);
  }
  if (source === 'current_content' && CURRENT_CONTENT_FIELDS.has(field)) return;
  if (source === 'current_metadata' && CURRENT_METADATA_FIELDS.has(field)) return;
  fail(`samples[${index}].currentEvidence must use current_content/currentContent or approved current_metadata.`);
}

function validateLabelAdmissibility(sample, index) {
  if (sample.reviewerDisagreement !== false) {
    fail(`samples[${index}].reviewerDisagreement must be resolved before finalization.`);
  }
  if (ACTIONABLE_WORK_STATES.has(sample.workState)) validateCurrentEvidence(sample, index);
}

function finalizedEvidence(sample) {
  if (!ACTIONABLE_WORK_STATES.has(sample.workState)) return undefined;
  return {
    source: String(sample.currentEvidence.source || '').trim(),
    field: String(sample.currentEvidence.field || '').trim(),
  };
}
const inputPath = resolve(argumentValue('--input') || 'data/qa/qa-fix5-blind-holdout-template.json');
const outputPath = resolve(argumentValue('--output') || 'data/qa/qa-fix5-blind-holdout-labels.json');
const reviewer = argumentValue('--reviewer');
const overwrite = process.argv.includes('--overwrite');
const expectedCount = Number.parseInt(argumentValue('--expected-count') || '50', 10);

if (!reviewer || reviewer.length > 120) fail('--reviewer is required and must be 120 characters or fewer.');
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 200) fail('--expected-count must be an integer between 1 and 200.');
if (!existsSync(inputPath)) fail('Completed blind holdout template was not found.');
if (existsSync(outputPath) && !overwrite) fail('Final label output already exists. Do not overwrite frozen labels.');

const inputBytes = readFileSync(inputPath);
let draft;
try {
  draft = JSON.parse(inputBytes.toString('utf8'));
} catch {
  fail('Completed blind holdout template is not valid JSON.');
}
if (draft.version !== 'independent-ground-truth-draft-v1') fail('Input must retain independent-ground-truth-draft-v1 until finalization.');
if (!Array.isArray(draft.samples) || draft.samples.length !== expectedCount) fail(`Input must contain exactly ${expectedCount} samples.`);

if (draft.labelAdmissibilityContractVersion !== LABEL_ADMISSIBILITY_CONTRACT_VERSION) {
  fail(`Input must declare labelAdmissibilityContractVersion=${LABEL_ADMISSIBILITY_CONTRACT_VERSION}.`);
}
const seen = new Set();
const labels = draft.samples.map((sample, index) => {
  const hash = String(sample.hash || '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hash)) fail(`samples[${index}].hash is invalid.`);
  if (seen.has(hash)) fail(`Duplicate sample hash: ${hash}`);
  seen.add(hash);
  if (!WORK_STATES.has(sample.workState)) fail(`samples[${index}].workState is incomplete or invalid.`);
  if (!NEXT_ACTORS.has(sample.nextActor)) fail(`samples[${index}].nextActor is incomplete or invalid.`);
  if (!PRIORITIES.has(sample.priority)) fail(`samples[${index}].priority is incomplete or invalid.`);
  if (typeof sample.reference !== 'boolean') fail(`samples[${index}].reference must be true or false.`);
  if (typeof sample.important !== 'boolean') fail(`samples[${index}].important must be true or false.`);
  validateLabelAdmissibility(sample, index);
  return {
    hash,
    workState: sample.workState,
    nextActor: sample.nextActor,
    priority: sample.priority,
    reference: sample.reference,
    important: sample.important,
    reviewerNote: String(sample.reviewerNote || '').slice(0, 1000),
    reviewerDisagreement: false,
    ...(finalizedEvidence(sample) ? { currentEvidence: finalizedEvidence(sample) } : {}),
  };
});

const payload = {
  version: 'independent-ground-truth-v1',
  labelAdmissibilityContractVersion: LABEL_ADMISSIBILITY_CONTRACT_VERSION,
  benchmarkId: String(draft.benchmarkId || ''),
  evaluationNow: new Date().toISOString(),
  frozenAt: new Date().toISOString(),
  reviewer,
  sourceTemplateSha256: createHash('sha256').update(inputBytes).digest('hex'),
  sourceClassifierVersion: String(draft.classifierVersion || ''),
  labels,
};
const outputDirectory = dirname(outputPath);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
chmodSync(outputDirectory, 0o700);
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
chmodSync(outputPath, 0o600);
console.log(JSON.stringify({
  command: 'finalize-blind-holdout',
  status: 'PASS',
  output: outputPath,
  benchmarkId: payload.benchmarkId,
  labels: labels.length,
  labelSha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
  labelAdmissibilityContractVersion: LABEL_ADMISSIBILITY_CONTRACT_VERSION,
  warning: 'Labels are now frozen. Do not edit them after scoring.',
}, null, 2));
