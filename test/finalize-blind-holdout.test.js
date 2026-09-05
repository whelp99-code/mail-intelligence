import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const finalizer = resolve('scripts/finalize-blind-holdout.mjs');

function draft(overrides = {}) {
  const sample = {
    hash: '0123456789ab',
    workState: 'action_required',
    nextActor: 'me',
    priority: 'normal',
    reference: false,
    important: true,
    reviewerNote: 'Synthetic current-message evidence locator.',
    reviewerDisagreement: false,
    currentEvidence: {
      source: 'current_content',
      field: 'currentContent',
    },
    ...(overrides.sample || {}),
  };
  return {
    version: 'independent-ground-truth-draft-v1',
    labelAdmissibilityContractVersion: 'current-message-evidence-v1',
    benchmarkId: 'synthetic-admissibility-test',
    classifierVersion: 'test-only',
    samples: [sample],
    ...overrides,
  };
}

async function runFinalizer(t, input) {
  const directory = await mkdtemp(join(tmpdir(), 'blind-label-admissibility-'));
  const inputPath = join(directory, 'draft.json');
  const outputPath = join(directory, 'labels.json');
  await writeFile(inputPath, JSON.stringify(input), 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    finalizer,
    '--input', inputPath,
    '--output', outputPath,
    '--reviewer', 'synthetic-owner',
    '--expected-count', '1',
  ], { encoding: 'utf8' });
  return { ...result, outputPath };
}

test('new Release Blind finalizer records admissible current-message provenance', async (t) => {
  const result = await runFinalizer(t, draft());
  assert.equal(result.status, 0, result.stderr);
  const frozen = JSON.parse(await readFile(result.outputPath, 'utf8'));
  assert.equal(frozen.labelAdmissibilityContractVersion, 'current-message-evidence-v1');
  assert.deepEqual(frozen.labels[0].currentEvidence, {
    source: 'current_content',
    field: 'currentContent',
  });
  assert.equal(frozen.labels[0].reviewerDisagreement, false);
});

test('new Release Blind finalizer keeps only a canonical evidence locator', async (t) => {
  const input = draft({ sample: { currentEvidence: {
    source: ' current_content ',
    field: ' currentContent ',
    exactText: 'sensitive current content',
    startOffset: 0,
    endOffset: 25,
    sourceHash: 'sensitive-hash',
    address: 'person@example.test',
  } } });
  const first = await runFinalizer(t, input);
  const second = await runFinalizer(t, input);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const [firstFrozen, secondFrozen] = await Promise.all([first, second].map(async (result) => JSON.parse(await readFile(result.outputPath, 'utf8'))));
  assert.deepEqual(firstFrozen.labels[0].currentEvidence, { source: 'current_content', field: 'currentContent' });
  assert.deepEqual(secondFrozen.labels[0].currentEvidence, firstFrozen.labels[0].currentEvidence);
});

test('new Release Blind finalizer fails closed for absent or inadmissible action evidence', async (t) => {
  const absent = await runFinalizer(t, draft({ sample: { currentEvidence: undefined } }));
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /currentEvidence is required/);

  const forbidden = await runFinalizer(t, draft({
    sample: { currentEvidence: { source: 'quoted_history', field: 'currentContent' } },
  }));
  assert.equal(forbidden.status, 2);
  assert.match(forbidden.stderr, /quoted history, footer, or disclaimer/);
});

test('new Release Blind finalizer fails closed for an unresolved reviewer disagreement', async (t) => {
  const result = await runFinalizer(t, draft({ sample: { reviewerDisagreement: true } }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /reviewerDisagreement must be resolved/);
});

test('historical frozen labels remain report-only readable without the new contract field', async () => {
  const legacy = JSON.parse(await readFile('test/fixtures/aside-qafix5-blind-fixed-50.json', 'utf8'));
  assert.equal(legacy.labelAdmissibilityContractVersion, undefined);
  assert.equal(legacy.version, 'independent-ground-truth-v1');
});
