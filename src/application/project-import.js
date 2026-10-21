import { planProjectRegistration } from '../domain/project-registration.js';
import { resolveProject } from '../domain/precision-classifier.js';

// RFC 4180 records, including quoted commas, escaped quotes and embedded newlines.
export function parseProjectCsv(text) {
  const records = [];
  let record = [], field = '', quoted = false, closed = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      record.push(field); field = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && source[i + 1] === '\n') i += 1;
        if (record.some(Boolean)) records.push(record);
        record = [];
      }
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('Invalid CSV quoting.');
      field += char;
    }
  }
  if (quoted) throw new Error('Unclosed CSV field.');
  if (field || record.length || closed) { record.push(field); records.push(record); }
  const header = records.shift();
  if (!header || new Set(header).size !== header.length
    || !['project_key', 'name', 'status', 'aliases'].every((key) => header.includes(key))) {
    throw new Error('Required CSV columns: project_key, name, status, aliases.');
  }
  const keys = new Set();
  return records.map((values, index) => {
    const fail = () => { throw new Error(`Invalid project CSV row ${index + 2}.`); };
    if (values.length !== header.length) fail();
    const row = Object.fromEntries(header.map((key, n) => [key, values[n]]));
    const key = row.project_key.toLowerCase().replace(/-/g, '');
    if (!/^[a-f0-9]{32}$/.test(key) || keys.has(key)) fail();
    keys.add(key);
    let aliases;
    try { aliases = JSON.parse(row.aliases); } catch { fail(); }
    if (!Array.isArray(aliases) || aliases.length > 30
      || aliases.some((item) => typeof item !== 'string' || item.trim().length < 2 || item.length > 200)
      || row.name.trim().length < 2 || row.name.length > 200) fail();
    const status = { '진행': 'active', '종료': 'archived', active: 'active', archived: 'archived' }[row.status];
    if (!status) fail();
    // Customer and evidence columns are not registry fields and are never inferred.
    return { projectKey: key, name: row.name, aliases, status, createdBy: 'import' };
  });
}

export function previewProjectImport(rows, existing = []) {
  const projects = existing.map((item) => ({ ...item }));
  const plans = [];
  let nextId = Math.max(0, ...projects.map((item) => item.id)) + 1;
  const keys = new Set();
  for (const row of rows) {
    if (keys.has(row.projectKey)) throw new Error('Duplicate import key.');
    keys.add(row.projectKey);
    const plan = planProjectRegistration(row, projects);
    const project = { ...plan.project, id: plan.existing?.id ?? nextId++ };
    if (plan.existing) projects.splice(projects.findIndex((item) => item.id === project.id), 1, project);
    else projects.push(project);
    plans.push({ action: plan.action, projectKey: project.projectKey, name: project.name,
      aliases: project.aliases, status: project.status });
  }
  return { plans, projects };
}

export function importProjects(store, mailboxId, rows) {
  return store.transaction(() => {
    previewProjectImport(rows, store.listProjects(mailboxId, { includeArchived: true }));
    return rows.map((row) => store.createProject(mailboxId, row));
  });
}

export function evaluateProjectImpact(messages, before, after) {
  const counts = { total: 0, confirmed: 0, review_required: 0, unchanged: 0, other_changed: 0 };
  const resolutions = { confirmed: 0, review_required: 0, candidate: 0, unassigned: 0 };
  const signature = (result) => JSON.stringify([result.projectResolution, result.primaryProjectId,
    result.projectResolution === 'review_required' ? result.projectCandidate.matches.map((item) => item.projectKey).sort() : null]);
  for (const message of messages) {
    const previous = resolveProject(message, before);
    const proposed = resolveProject(message, after);
    counts.total += 1;
    resolutions[proposed.projectResolution] += 1;
    if (signature(previous) === signature(proposed)) counts.unchanged += 1;
    else if (['confirmed', 'review_required'].includes(proposed.projectResolution)) counts[proposed.projectResolution] += 1;
    else counts.other_changed += 1;
  }
  return { counts, resolutions };
}
