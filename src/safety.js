const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export class UnsafeListenHostError extends Error {
  constructor(host) {
    super(`Listen host ${host} is not allowed; Mail Intelligence v1.2.0 only binds to loopback.`);
    this.name = 'UnsafeListenHostError';
    this.code = 'LISTEN_HOST_NOT_LOOPBACK';
    this.host = host;
  }
}

export class MutationDisabledError extends Error {
  constructor(capability) {
    super(`External mutation "${capability}" is disabled in the v1.2.0 read-only safety baseline.`);
    this.name = 'MutationDisabledError';
    this.statusCode = 403;
    this.code = 'MUTATION_DISABLED';
    this.capability = capability;
  }
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const READ_ONLY_CAPABILITIES = Object.freeze({
  mailSend: false,
  mailReadState: false,
  mailMove: false,
  mailDelete: false,
  mailCategory: false,
  calendarWrite: false,
  taskWrite: false,
  dataPlaneWrite: false,
  fixtureWrite: false
});

function enabled(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

export function normalizeLoopbackHost(value = '127.0.0.1') {
  const host = String(value || '127.0.0.1').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new UnsafeListenHostError(host);
  }
  return host.replace(/^\[(.*)\]$/, '$1');
}

export function normalizePort(value = 3010) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('PORT must be an integer between 1 and 65535.');
    error.code = 'PORT_INVALID';
    throw error;
  }
  return port;
}

export function getSafetyPolicy(env = process.env) {
  const approved = enabled(env.MAIL_INTELLIGENCE_ACTIONS_APPROVED);
  const capabilities = {
    ...READ_ONLY_CAPABILITIES,
    mailSend: approved && enabled(env.MAIL_INTELLIGENCE_ALLOW_SEND),
    mailReadState: approved && enabled(env.MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS),
    dataPlaneWrite: approved && enabled(env.MAIL_INTELLIGENCE_ALLOW_DATA_PLANE)
  };
  return Object.freeze({
    mode: Object.values(capabilities).some(Boolean) ? 'approved-execution-test' : 'read-only',
    version: 'v1.2.0',
    policyVersion: 'read-only-v1.2.0',
    approved,
    capabilities: Object.freeze(capabilities)
  });
}

export function delegatedScopesForSafety(policy = getSafetyPolicy()) {
  const scopes = ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.Read'];
  if (policy.capabilities.mailSend) scopes.push('Mail.Send');
  if (policy.capabilities.mailReadState) scopes.push('Mail.ReadWrite');
  return scopes.join(' ');
}

export function assertMutationAllowed(policyOrCapability, maybeCapability) {
  const oneArgument = typeof policyOrCapability === 'string' && maybeCapability === undefined;
  const reversedLegacyArguments = typeof policyOrCapability === 'string'
    && maybeCapability
    && typeof maybeCapability === 'object';
  const policy = oneArgument
    ? getSafetyPolicy()
    : reversedLegacyArguments
      ? maybeCapability
      : policyOrCapability;
  const capability = oneArgument || reversedLegacyArguments ? policyOrCapability : maybeCapability;
  if (!Object.hasOwn(READ_ONLY_CAPABILITIES, capability)) {
    const error = new Error(`Unknown external mutation capability: ${capability}`);
    error.statusCode = 500;
    error.code = 'UNKNOWN_CAPABILITY';
    throw error;
  }
  if (policy?.capabilities?.[capability] === true) return;
  if (oneArgument) throw new MutationDisabledError(capability);
  const error = new Error(`External mutation "${capability}" is disabled in the v1.2.0 read-only safety baseline.`);
  error.statusCode = 403;
  error.code = 'EXTERNAL_ACTION_DISABLED';
  error.capability = capability;
  throw error;
}

export function publicSafetyStatus(policy = getSafetyPolicy()) {
  return {
    mode: policy.mode,
    version: policy.version,
    approved: policy.approved,
    capabilities: { ...policy.capabilities }
  };
}
