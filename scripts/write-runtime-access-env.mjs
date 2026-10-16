#!/usr/bin/env node
import { writeRuntimeAccessEnv } from '../src/security/runtime-access-env.js';

const dataDir = process.argv[2];
const allowedProxyHosts = process.argv[3] ?? '';
if (!dataDir) {
  process.stderr.write('data dir is required.\n');
  process.exit(64);
}

try {
  const { username } = await writeRuntimeAccessEnv({ dataDir, allowedProxyHosts });
  process.stdout.write(username);
} catch (error) {
  process.stderr.write(`${error?.message || 'Access key failed validation.'}\n`);
  process.exit(1);
}
