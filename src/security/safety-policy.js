const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function enabled(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

export function getSafetyPolicy(env = process.env) {
  return Object.freeze({
    allowSend: enabled(env.MAIL_INTELLIGENCE_ALLOW_SEND),
    allowMailMutations: enabled(env.MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS),
    allowDataPlane: enabled(env.MAIL_INTELLIGENCE_ALLOW_DATA_PLANE),
    allowExternalAi: enabled(env.MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI),
    bindHost: String(env.MAIL_INTELLIGENCE_HOST || env.HOST || '127.0.0.1').trim() || '127.0.0.1'
  });
}

export function delegatedScopesForPolicy(policy) {
  const scopes = ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.Read'];
  if (policy.allowSend) scopes.push('Mail.Send');
  return scopes.join(' ');
}

export function assertCapability(policy, capability) {
  const mapping = {
    send: ['allowSend', 'MAIL_INTELLIGENCE_ALLOW_SEND'],
    mailMutation: ['allowMailMutations', 'MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS'],
    dataPlane: ['allowDataPlane', 'MAIL_INTELLIGENCE_ALLOW_DATA_PLANE'],
    externalAi: ['allowExternalAi', 'MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI']
  };
  const [property, flag] = mapping[capability] || [];
  if (!property) {
    const error = new Error(`Unknown external action capability: ${capability}`);
    error.statusCode = 500;
    error.code = 'UNKNOWN_CAPABILITY';
    throw error;
  }
  if (!policy[property]) {
    const error = new Error(`External action is disabled. Set ${flag}=1 only after its release gate is approved.`);
    error.statusCode = 403;
    error.code = 'EXTERNAL_ACTION_DISABLED';
    throw error;
  }
}

export function publicCapabilities(policy) {
  return {
    readOnly: !policy.allowSend && !policy.allowMailMutations && !policy.allowDataPlane,
    send: policy.allowSend,
    mailMutations: policy.allowMailMutations,
    dataPlane: policy.allowDataPlane,
    externalAi: policy.allowExternalAi
  };
}
