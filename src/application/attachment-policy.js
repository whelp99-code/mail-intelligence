const MAX_FILE_BYTES = 2_097_152;
const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_ZIP_RATIO = 100;
const MACRO_NAME = /vba|macros\/|oleobject/i;
const NESTED_ARCHIVE = /\.(zip|7z|rar|cab)$/i;

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function startsWith(bytes, signature) {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function inspectZip(bytes) {
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let index = bytes.length - 22; index >= min; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail(422, 'UNSUPPORTED_FILE');
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES || cdOffset + cdSize > bytes.length) fail(422, 'UNSUPPORTED_FILE');
  let cursor = cdOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes[cursor] !== 0x50 || bytes[cursor + 1] !== 0x4b) fail(422, 'UNSUPPORTED_FILE');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (flags & 0x0001) fail(422, 'UNSUPPORTED_FILE');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) fail(422, 'UNSUPPORTED_FILE');
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) fail(422, 'UNSUPPORTED_FILE');
    if (MACRO_NAME.test(name) || NESTED_ARCHIVE.test(name)) fail(422, 'UNSUPPORTED_FILE');
    if (compressed > 0 && uncompressed / compressed > MAX_ZIP_RATIO) fail(422, 'UNSUPPORTED_FILE');
    uncompressedTotal += uncompressed;
    if (uncompressedTotal > MAX_ZIP_UNCOMPRESSED) fail(422, 'UNSUPPORTED_FILE');
    if (method !== 0 && method !== 8) fail(422, 'UNSUPPORTED_FILE');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

function assertUtf8Text(bytes) {
  if (bytes.includes(0)) fail(422, 'UNSUPPORTED_FILE');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(422, 'UNSUPPORTED_FILE');
  }
}

export function validateAttachment({ bytes, displayName }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_FILE_BYTES) {
    fail(bytes?.length > MAX_FILE_BYTES ? 413 : 422, bytes?.length > MAX_FILE_BYTES ? 'ATTACHMENT_TOO_LARGE' : 'UNSUPPORTED_FILE');
  }
  const name = String(displayName || '');
  const mime = 'application/octet-stream';
  const lower = name.toLowerCase();
  if (startsWith(bytes, [0x4d, 0x5a]) || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) fail(422, 'UNSUPPORTED_FILE');
  if (lower.endsWith('.txt') || lower.endsWith('.csv')) {
    assertUtf8Text(bytes);
    return { name, mime, kind: 'text' };
  }
  if (lower.endsWith('.pdf')) {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) fail(422, 'UNSUPPORTED_FILE');
    return { name, mime, kind: 'pdf' };
  }
  if (lower.endsWith('.png')) {
    if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) fail(422, 'UNSUPPORTED_FILE');
    return { name, mime, kind: 'png' };
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    if (!startsWith(bytes, [0xff, 0xd8, 0xff])) fail(422, 'UNSUPPORTED_FILE');
    return { name, mime, kind: 'jpeg' };
  }
  if (lower.endsWith('.hwp')) fail(422, 'UNSUPPORTED_FILE');
  if (lower.endsWith('.docx') || lower.endsWith('.xlsx') || lower.endsWith('.pptx') || lower.endsWith('.hwpx')) {
    if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && !startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) fail(422, 'UNSUPPORTED_FILE');
    inspectZip(bytes);
    return { name, mime, kind: 'office-zip' };
  }
  fail(422, 'UNSUPPORTED_FILE');
}
