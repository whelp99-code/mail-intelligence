import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export function normalizeCwosPrincipalId(value) {
  return String(value || '').trim();
}

export async function resolveCwosCredentialFile(value, {
  realpathImpl = realpath,
  statImpl = stat,
} = {}) {
  const path = await realpathImpl(resolve(String(value || '').trim()));
  return { path, metadata: await statImpl(path) };
}
