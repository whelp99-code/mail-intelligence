import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandScanner, createConfiguredScanner } from '../src/adapters/attachment-scanner.js';

test('shell-like scanner commands stay unavailable and never spawn a shell', async () => {
  const spaced = createConfiguredScanner({ MAIL_ATTACHMENT_SCANNER_COMMAND: '/bin/true; rm -rf /' });
  await assert.rejects(spaced.scan({ bytes: Buffer.from('x'), name: 'a.txt' }), { code: 'SCANNER_UNAVAILABLE', statusCode: 503 });
  const dollar = createConfiguredScanner({ MAIL_ATTACHMENT_SCANNER_COMMAND: '$HOME/scanner' });
  await assert.rejects(dollar.scan({ bytes: Buffer.from('x'), name: 'a.txt' }), { code: 'SCANNER_UNAVAILABLE', statusCode: 503 });
  const missing = createConfiguredScanner({});
  await assert.rejects(missing.scan({ bytes: Buffer.from('x'), name: 'a.txt' }), { code: 'SCANNER_UNAVAILABLE', statusCode: 503 });
});

test('command scanner uses a fixed argv, 0600 payload, and fail-closed timeout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mi-scan-cmd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'check-mode.mjs');
  await writeFile(script, `import { statSync } from 'node:fs';
const path = process.argv[2];
const mode = statSync(path).mode & 0o777;
if (mode !== 0o600) process.exit(3);
process.exit(0);
`, { mode: 0o700 });
  await chmod(script, 0o700);
  const scanner = createCommandScanner({ command: process.execPath, args: [script] });
  const result = await scanner.scan({ bytes: Buffer.from('plain text\n'), name: 'a.txt' });
  assert.equal(result.result, 'PASS');
  await assert.rejects(
    createCommandScanner({ command: '/bin/false' }).scan({ bytes: Buffer.from('x'), name: 'a.txt' }),
    { code: 'UNSUPPORTED_FILE', statusCode: 422 },
  );
  const hang = join(directory, 'hang.mjs');
  await writeFile(hang, 'setTimeout(() => {}, 10_000);\n', { mode: 0o700 });
  await chmod(hang, 0o700);
  await assert.rejects(
    createCommandScanner({ command: process.execPath, args: [hang], timeoutMs: 80 }).scan({ bytes: Buffer.from('x'), name: 'a.txt' }),
    { code: 'SCANNER_UNAVAILABLE', statusCode: 503 },
  );
});
