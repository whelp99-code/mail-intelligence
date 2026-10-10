export function syntheticIdentityToken({ tenantId, principalId, clientId, nonce = '' }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    tid: tenantId,
    oid: principalId,
    azp: clientId,
    nonce,
  })}.synthetic`;
}
