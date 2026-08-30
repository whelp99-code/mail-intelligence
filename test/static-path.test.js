import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStaticFile } from '../src/security/static-path.js';

test('정상 정적 파일은 canonical src 경로로 해석한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mi-static-root-'));
  try {
    await writeFile(join(root, 'index.html'), '<h1>ok</h1>', 'utf8');
    const resolved = await resolveStaticFile(root, '/');
    assert.equal(resolved, join(root, 'index.html'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('인코딩된 상위 경로 이탈을 거부한다', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mi-static-traversal-'));
  const root = join(base, 'src');
  try {
    await mkdir(root);
    await writeFile(join(base, 'outside.txt'), 'secret', 'utf8');
    await assert.rejects(
      resolveStaticFile(root, '/%2e%2e%2foutside.txt'),
      (error) => error.statusCode === 403
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('src 내부 심볼릭 링크가 외부 파일을 가리키면 거부한다', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mi-static-symlink-'));
  const root = join(base, 'src');
  const outside = join(base, 'outside.txt');
  try {
    await mkdir(root);
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, join(root, 'leak.txt'));
    await assert.rejects(
      resolveStaticFile(root, '/leak.txt'),
      (error) => error.statusCode === 403
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('잘못된 URL 인코딩은 400으로 거부한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mi-static-encoding-'));
  try {
    await assert.rejects(
      resolveStaticFile(root, '/%E0%A4%A'),
      (error) => error.statusCode === 400
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
