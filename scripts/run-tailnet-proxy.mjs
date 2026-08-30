#!/usr/bin/env node

import { createAllowlistedTcpProxy, loadProxyConfig } from '../src/security/tcp-allowlist-proxy.js';

const config = loadProxyConfig(process.env);
const proxy = createAllowlistedTcpProxy(config);
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[tailnet-proxy] stopping on ${signal}\n`);
  try {
    await proxy.close();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`[tailnet-proxy] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await proxy.listen();
  const allowed = config.allowedCidrs.map((cidr) => cidr.source).join(',');
  process.stdout.write(
    `[tailnet-proxy] listening ${config.bindHost}:${config.bindPort} -> ${config.targetHost}:${config.targetPort} allowed=${allowed}\n`,
  );
} catch (error) {
  process.stderr.write(`[tailnet-proxy] startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
