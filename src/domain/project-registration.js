export function normalizeProjectName(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeProjectKey(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

export function prepareProject({ name, projectKey = '', aliases = [], status = 'active', createdBy = 'user' } = {}) {
  const cleanName = String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200);
  const normalizedName = normalizeProjectName(cleanName);
  if (normalizedName.length < 2) throw new Error('Project name must contain at least two characters.');
  if (!['active', 'archived'].includes(status)) throw new Error('Invalid project status.');
  if (!['user', 'import'].includes(createdBy)) throw new Error('Invalid project creation source.');
  const cleanAliases = [...new Set((Array.isArray(aliases) ? aliases : [])
    .map((value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter((value) => value.length >= 2 && normalizeProjectName(value) !== normalizedName))].slice(0, 30);
  const key = normalizeProjectKey(projectKey || cleanName);
  if (!key) throw new Error('Project key is invalid.');
  return { name: cleanName, normalizedName, projectKey: key, aliases: cleanAliases, status, createdBy };
}

export function planProjectRegistration(input, projects) {
  const project = prepareProject(input);
  const existing = projects.find((item) => item.projectKey === project.projectKey);
  const updating = project.createdBy === 'import' && existing?.createdBy === 'import';
  if (existing && project.createdBy === 'import' && !updating) {
    throw new Error('Import cannot overwrite a user-created project.');
  }
  const terms = new Set([project.normalizedName, ...project.aliases.map(normalizeProjectName)]);
  for (const item of projects) {
    if (updating && item.id === existing.id) continue;
    if ([item.normalizedName, ...item.aliases.map(normalizeProjectName)].some((term) => terms.has(term))) {
      const error = new Error(`Project name or alias already belongs to ${item.name}.`);
      error.code = 'PROJECT_ALIAS_CONFLICT';
      throw error;
    }
  }
  const unchanged = updating && project.name === existing.name && project.status === existing.status
    && JSON.stringify(project.aliases) === JSON.stringify(existing.aliases);
  return { project, existing, action: unchanged ? 'unchanged' : updating ? 'update' : 'create' };
}
