import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

function pathError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isInside(rootPath, candidatePath) {
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath === rootPath || candidatePath.startsWith(prefix);
}

export async function resolveStaticFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  } catch {
    throw pathError('Static path contains invalid URL encoding.', 400);
  }
  if (decoded.includes('\0')) throw pathError('Static path contains a null byte.', 400);

  const lexicalRoot = resolve(root);
  const relativePath = decoded.replace(/^[/\\]+/, '') || 'index.html';
  const lexicalCandidate = resolve(lexicalRoot, relativePath);
  if (!isInside(lexicalRoot, lexicalCandidate)) {
    throw pathError('Static path is outside the application root.', 403);
  }

  let canonicalRoot;
  let canonicalCandidate;
  try {
    [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalCandidate)
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw pathError('Static file was not found.', 404);
    }
    throw error;
  }

  if (!isInside(canonicalRoot, canonicalCandidate)) {
    throw pathError('Static symlink resolves outside the application root.', 403);
  }
  return canonicalCandidate;
}
