import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diagnoseProjectRegistry } from '../src/domain/project-registry-diagnostic.js';

// Explicit sanitized projection only: {notionProjects:[{sourceId,projectKey}],
// miProjects:[{id,projectKey,status}]}. No DB, credentials, network or default paths.
export function diagnoseProjectRegistryFile({ input, expectedSha256 }) {
  if (typeof input !== 'string' || !input || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) {
    throw new Error('Explicit projection and SHA256 required.');
  }
  const bytes = readFileSync(input);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('Projection digest mismatch.');
  return { inputSha256: sha256, ...diagnoseProjectRegistry(JSON.parse(bytes.toString('utf8'))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      input: { type: 'string' }, 'expected-sha256': { type: 'string' },
    }, allowPositionals: false });
    console.log(JSON.stringify(diagnoseProjectRegistryFile({ input: values.input,
      expectedSha256: values['expected-sha256'] }), null, 2));
  } catch {
    // Malformed or unauthorized input must never leak source-bearing exceptions.
    console.error('Project registry diagnostic failed.');
    process.exitCode = 1;
  }
}
