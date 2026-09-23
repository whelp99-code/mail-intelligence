import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachment } from '../src/application/attachment-policy.js';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

function zipStore(files, { encryptFlag = 0, uncompressedOverride } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(encryptFlag, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressedOverride ?? data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const localFull = Buffer.concat([local, data]);
    locals.push(localFull);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(encryptFlag, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressedOverride ?? data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += localFull.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('signatures accept txt/pdf/png/jpeg and a stored office zip', () => {
  assert.equal(validateAttachment({ bytes: Buffer.from('plain text\n'), displayName: 'a.txt' }).kind, 'text');
  assert.equal(validateAttachment({ bytes: Buffer.from('%PDF-1.4\n%%EOF\n'), displayName: 'a.pdf' }).kind, 'pdf');
  assert.equal(validateAttachment({
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]),
    displayName: 'a.png',
  }).kind, 'png');
  assert.equal(validateAttachment({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), displayName: 'a.jpg' }).kind, 'jpeg');
  const docx = zipStore([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:doc/>']]);
  assert.equal(validateAttachment({ bytes: docx, displayName: 'memo.docx' }).kind, 'office-zip');
});

test('MIME disguise, HWP, encryption, macros, traversal and zip bombs fail closed', () => {
  assert.throws(() => validateAttachment({ bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]), displayName: 'note.txt' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: Buffer.from('not-a-pdf'), displayName: 'a.pdf' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), displayName: 'old.hwp' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: zipStore([['word/vbaProject.bin', 'macro']]), displayName: 'm.docx' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: zipStore([['../secret.txt', 'x']]), displayName: 'm.docx' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: zipStore([['inner.zip', 'nest']]), displayName: 'm.docx' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: zipStore([['a.txt', 'x']], { encryptFlag: 1 }), displayName: 'm.docx' }), { code: 'UNSUPPORTED_FILE' });
  assert.throws(() => validateAttachment({ bytes: zipStore([['a.txt', 'x']], { uncompressedOverride: 20000 }), displayName: 'm.docx' }), { code: 'UNSUPPORTED_FILE' });
});
