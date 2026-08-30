import { buildSangforActions } from './sangfor.js';

const PROFILE_BUILDERS = {
  sangfor: buildSangforActions
};

export function buildDomainProfileActions(profileId = 'generic', context = {}) {
  const builder = PROFILE_BUILDERS[String(profileId || '').toLowerCase()];
  return builder ? builder(context) : [];
}

export function supportedDomainProfiles() {
  return ['generic', ...Object.keys(PROFILE_BUILDERS)];
}
