import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  assertGoogleApiUrl,
  createGoogleDriveClient,
  exportExtension,
} from '../src/adapters/google-drive-client.js';

const pdf = Buffer.from('%PDF-1.4 fixture', 'utf8');

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

test('assertGoogleApiUrl allows only Google API origins and rejects permissions writes', () => {
  assert.equal(assertGoogleApiUrl('https://www.googleapis.com/drive/v3/files/abc').hostname, 'www.googleapis.com');
  assert.throws(() => assertGoogleApiUrl('https://evil.example/drive/v3/files/abc'), { code: 'DRIVE_DOWNLOAD_FAILED' });
  assert.throws(() => assertGoogleApiUrl('https://www.googleapis.com/drive/v3/files/abc/permissions'), { code: 'DRIVE_ACCESS_DENIED' });
});

test('download and export stay on the Google origin, bound size, and reject redirects', async () => {
  const calls = [];
  const client = createGoogleDriveClient({
    maxBytes: 32,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', redirect: options.redirect });
      if (String(url).includes('permissions')) return json({}, 200);
      if (String(url).includes('/export')) return new Response(pdf);
      if (String(url).includes('alt=media')) return new Response(pdf);
      return json({
        id: 'file1', name: 'note.pdf', mimeType: 'application/pdf', size: pdf.length, version: '3',
        modifiedTime: '2026-09-10T00:00:00Z', trashed: false, capabilities: { canDownload: true },
      });
    },
  });
  const meta = await client.getMetadata({ accessToken: 'tok', fileId: 'file1' });
  assert.equal(meta.version, '3');
  assert.equal(Buffer.compare(await client.download({ accessToken: 'tok', fileId: 'file1' }), pdf), 0);
  assert.equal(Buffer.compare(await client.exportFile({
    accessToken: 'tok', fileId: 'file1', exportMime: 'application/pdf',
  }), pdf), 0);
  assert.equal(calls.every((item) => item.redirect === 'manual'), true);
  assert.equal(calls.every((item) => !item.url.includes('/permissions')), true);
  assert.equal(exportExtension('application/vnd.google-apps.document', 'application/pdf'), '.pdf');
});

test('oversized export and off-origin redirects fail closed', async () => {
  const huge = Buffer.alloc(40, 0x61);
  const oversized = createGoogleDriveClient({
    maxBytes: 32,
    fetchImpl: async () => new Response(Readable.from(huge)),
  });
  await assert.rejects(oversized.exportFile({
    accessToken: 'tok', fileId: 'file1', exportMime: 'application/pdf',
  }), { code: 'ATTACHMENT_TOO_LARGE' });
  const redirected = createGoogleDriveClient({
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/file' } }),
  });
  await assert.rejects(redirected.download({ accessToken: 'tok', fileId: 'file1' }), { code: 'DRIVE_DOWNLOAD_FAILED' });
});
