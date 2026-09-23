import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnavailableScanner } from '../application/mail-attachment-assets.js';

const SCAN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

export function createCommandScanner({ command, args = [], timeoutMs = SCAN_TIMEOUT_MS } = {}) {
  if (!command || typeof command !== 'string' || command.includes(' ') || command.includes('$')) {
    return createUnavailableScanner();
  }
  const argv = [command, ...args.map(String)];
  return {
    async scan({ bytes, name }) {
      const directory = await mkdtemp(join(tmpdir(), 'mi-attach-scan-'));
      await chmod(directory, 0o700);
      const filePath = join(directory, 'payload.bin');
      try {
        await writeFile(filePath, bytes, { mode: 0o600 });
        await chmod(filePath, 0o600);
        const output = await new Promise((resolve, reject) => {
          const child = spawn(argv[0], argv.slice(1).concat(filePath), {
            shell: false,
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const chunks = [];
          let size = 0;
          const collect = (chunk) => {
            size += chunk.length;
            if (size > MAX_OUTPUT_BYTES) {
              child.kill('SIGKILL');
              reject(Object.assign(new Error('SCANNER_UNAVAILABLE'), { statusCode: 503, code: 'SCANNER_UNAVAILABLE' }));
              return;
            }
            chunks.push(chunk);
          };
          child.stdout.on('data', collect);
          child.stderr.on('data', collect);
          child.on('error', () => reject(Object.assign(new Error('SCANNER_UNAVAILABLE'), { statusCode: 503, code: 'SCANNER_UNAVAILABLE' })));
          child.on('close', (code, signal) => {
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
              reject(Object.assign(new Error('SCANNER_UNAVAILABLE'), { statusCode: 503, code: 'SCANNER_UNAVAILABLE' }));
              return;
            }
            resolve({ code, text: Buffer.concat(chunks).toString('utf8') });
          });
        });
        if (output.code !== 0) fail(422, 'UNSUPPORTED_FILE');
        return { result: 'PASS', engine: 'local-command', version: String(command), outputBytes: output.text.length, name };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export function createConfiguredScanner(env = process.env) {
  const command = String(env.MAIL_ATTACHMENT_SCANNER_COMMAND || '').trim();
  if (!command) return createUnavailableScanner();
  return createCommandScanner({ command, args: [] });
}
