import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  loadDeidentifiedSchema,
  schemaHash,
  validateSchemaAccess,
  validateSchemaIdentity,
} from './notion-schema-contract.js';
import { assertSnapshotIdentity, mastersFromSnapshot, validateSnapshotIdentity } from './notion-work-system.js';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';

const WRITE_METHODS = new Set(['PATCH', 'PUT', 'DELETE']);

function truthyFlag(value) {
  return String(value || '').trim() === '1';
}

function trim(value) {
  return String(value || '').trim();
}

function absPath(path, cwd = process.cwd()) {
  const raw = trim(path);
  if (!raw) return '';
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function fileReadable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover credential *presence* only. Never returns token bytes in the result
 * object (callers that need the token must read the file/env themselves).
 */
export function isNotionReadonlyEnabled(env = process.env) {
  return truthyFlag(env.MAIL_INTELLIGENCE_NOTION_READONLY);
}

export function resolveNotionReadonlyConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const enabled = isNotionReadonlyEnabled(env);
  const tokenEnvName = 'MAIL_INTELLIGENCE_NOTION_TOKEN';
  const tokenFileEnvName = 'MAIL_INTELLIGENCE_NOTION_TOKEN_FILE';
  const databaseMapEnvName = 'MAIL_INTELLIGENCE_NOTION_DATABASE_MAP';
  const outPathEnvName = 'MAIL_INTELLIGENCE_NOTION_LIVE_SNAPSHOT';
  const schemaPathEnvName = 'MAIL_INTELLIGENCE_NOTION_SCHEMA_PATH';

  const tokenFile = absPath(env[tokenFileEnvName], cwd);
  const databaseMapPath = absPath(env[databaseMapEnvName], cwd);
  const outPath = absPath(env[outPathEnvName], cwd)
    || resolve(cwd, 'data/notion-readonly/live-snapshot.json');
  const schemaPath = absPath(env[schemaPathEnvName], cwd)
    || resolve(cwd, 'test/fixtures/notion-activity-schema.deidentified.json');

  const tokenFromEnv = Boolean(trim(env[tokenEnvName]));
  const tokenFromFile = Boolean(tokenFile && fileReadable(tokenFile));
  const hasToken = tokenFromEnv || tokenFromFile;
  const hasDatabaseMap = Boolean(databaseMapPath && fileReadable(databaseMapPath));

  const discovery = {
    enabled,
    tokenEnvPresent: tokenFromEnv,
    tokenFilePath: tokenFile || null,
    tokenFileReadable: tokenFromFile,
    databaseMapPath: databaseMapPath || null,
    databaseMapReadable: hasDatabaseMap,
    outPath,
    schemaPath,
    apiBase: trim(env.MAIL_INTELLIGENCE_NOTION_API_BASE) || NOTION_API_BASE,
    notionVersion: trim(env.MAIL_INTELLIGENCE_NOTION_VERSION) || NOTION_VERSION,
  };

  if (!enabled) {
    return {
      ok: false,
      code: 'READONLY_DISABLED',
      message: 'MAIL_INTELLIGENCE_NOTION_READONLY is not 1 (default OFF).',
      discovery,
    };
  }

  if (!hasToken || !hasDatabaseMap) {
    return {
      ok: false,
      code: 'BLOCKED_ON_SECRET',
      message: 'Read-only Notion pull needs a token (env or mode-600 file) and an untracked database map path.',
      discovery,
    };
  }

  return {
    ok: true,
    code: 'READY',
    message: 'Read-only Notion credentials appear available.',
    discovery,
  };
}

export function loadNotionReadonlyToken(env = process.env, { cwd = process.cwd() } = {}) {
  const fromEnv = trim(env.MAIL_INTELLIGENCE_NOTION_TOKEN);
  if (fromEnv) return fromEnv;
  const file = absPath(env.MAIL_INTELLIGENCE_NOTION_TOKEN_FILE, cwd);
  if (!file) {
    throw Object.assign(new Error('Notion read-only token is missing.'), { code: 'BLOCKED_ON_SECRET' });
  }
  const token = trim(readFileSync(file, 'utf8'));
  if (!token) {
    throw Object.assign(new Error('Notion read-only token file is empty.'), { code: 'BLOCKED_ON_SECRET' });
  }
  return token;
}

export function loadNotionDatabaseMap(pathOrObject, { cwd = process.cwd() } = {}) {
  let map;
  if (pathOrObject && typeof pathOrObject === 'object' && !Array.isArray(pathOrObject)) {
    map = pathOrObject;
  } else {
    const path = absPath(pathOrObject, cwd);
    if (!path) {
      throw Object.assign(new Error('Notion database map path is required.'), { code: 'BLOCKED_ON_SECRET' });
    }
    map = JSON.parse(readFileSync(path, 'utf8'));
  }
  const workspaceId = trim(map.workspaceId);
  const accounts = trim(map.accountsDatabaseId || map.databases?.accounts);
  const projects = trim(map.projectsDatabaseId || map.databases?.projects);
  const activities = trim(map.activitiesDatabaseId || map.databases?.activities);
  if (!workspaceId || !accounts || !projects) {
    throw Object.assign(
      new Error('Database map requires workspaceId, accountsDatabaseId, and projectsDatabaseId.'),
      { code: 'DATABASE_MAP_INVALID' },
    );
  }
  return {
    workspaceId,
    accountsDatabaseId: accounts,
    projectsDatabaseId: projects,
    activitiesDatabaseId: activities || '',
    financeDatabaseId: trim(map.financeDatabaseId || map.databases?.finance),
  };
}

function parseUrl(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

function isAllowedReadonlyRequest(url, method, apiBase = NOTION_API_BASE) {
  const parsed = parseUrl(url);
  const base = parseUrl(apiBase);
  if (!parsed || !base) return { ok: false, code: 'NOTION_URL_INVALID' };
  if (parsed.origin !== base.origin) return { ok: false, code: 'NOTION_URL_REJECTED' };
  const upper = String(method || 'GET').toUpperCase();
  if (WRITE_METHODS.has(upper)) {
    return { ok: false, code: 'NOTION_WRITE_HTTP_FORBIDDEN' };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  // Notion database query is POST but read-only (no row mutation).
  if (upper === 'POST' && /^\/v1\/databases\/[^/]+\/query$/.test(path)) {
    return { ok: true, kind: 'database_query' };
  }
  if (upper === 'GET' && /^\/v1\/databases\/[^/]+$/.test(path)) {
    return { ok: true, kind: 'database_retrieve' };
  }
  if (upper === 'GET' && /^\/v1\/pages\/[^/]+$/.test(path)) {
    return { ok: true, kind: 'page_retrieve' };
  }
  if (upper === 'POST' && path === '/v1/pages') {
    return { ok: false, code: 'NOTION_WRITE_HTTP_FORBIDDEN' };
  }
  return { ok: false, code: 'NOTION_HTTP_METHOD_REJECTED' };
}

export function createNotionReadonlyFetch({
  token,
  fetchImpl = globalThis.fetch,
  apiBase = NOTION_API_BASE,
  notionVersion = NOTION_VERSION,
  calls = null,
} = {}) {
  if (!trim(token)) {
    throw Object.assign(new Error('Notion read-only token is required for HTTP.'), { code: 'BLOCKED_ON_SECRET' });
  }
  if (typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('fetchImpl is required.'), { code: 'FETCH_REQUIRED' });
  }

  return async function notionReadonlyFetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const allowed = isAllowedReadonlyRequest(url, method, apiBase);
    if (calls) {
      calls.push({ url: String(url), method, allowed: allowed.ok, kind: allowed.kind || null, code: allowed.code || null });
    }
    if (!allowed.ok) {
      throw Object.assign(
        new Error(allowed.code === 'NOTION_WRITE_HTTP_FORBIDDEN'
          ? 'Notion write HTTP is forbidden in Phase 1B read-only mode.'
          : 'Notion HTTP request is not allowed in Phase 1B read-only mode.'),
        { code: allowed.code || 'NOTION_HTTP_FORBIDDEN' },
      );
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': notionVersion,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    return fetchImpl(url, { ...options, method, headers });
  };
}

/**
 * Recorded-response harness for tests. No network. Scripts are ordered matchers.
 * Each entry: { match: (url, method, body) => boolean, status?, json } or { matchUrl, method, status?, json }.
 */
export function createRecordedNotionFetch(script = [], { calls = null } = {}) {
  const remaining = [...script];
  return async function recordedNotionFetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const allowed = isAllowedReadonlyRequest(url, method);
    if (calls) {
      calls.push({ url: String(url), method, allowed: allowed.ok, kind: allowed.kind || null, code: allowed.code || null });
    }
    if (!allowed.ok) {
      throw Object.assign(
        new Error('Notion write HTTP is forbidden in Phase 1B read-only mode.'),
        { code: allowed.code || 'NOTION_HTTP_FORBIDDEN' },
      );
    }
    const bodyText = typeof options.body === 'string' ? options.body : '';
    const index = remaining.findIndex((entry) => {
      if (typeof entry.match === 'function') return entry.match(String(url), method, bodyText);
      if (entry.matchUrl) {
        const re = entry.matchUrl instanceof RegExp ? entry.matchUrl : new RegExp(String(entry.matchUrl));
        if (!re.test(String(url))) return false;
      }
      if (entry.method && String(entry.method).toUpperCase() !== method) return false;
      return true;
    });
    if (index < 0) {
      throw Object.assign(new Error(`No recorded Notion response for ${method} ${url}`), {
        code: 'RECORDED_RESPONSE_MISS',
      });
    }
    const [entry] = remaining.splice(index, 1);
    const status = entry.status || 200;
    const payload = entry.json;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return typeof payload === 'function' ? payload() : payload;
      },
      async text() {
        return JSON.stringify(typeof payload === 'function' ? payload() : payload);
      },
    };
  };
}

function richTextPlain(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => item?.plain_text || item?.text?.content || '').join('').trim();
  }
  return '';
}

function titlePlain(value) {
  return richTextPlain(value);
}

function selectName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return trim(value.name);
}

function multiSelectNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => selectName(item)).filter(Boolean);
}

function relationIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => trim(item?.id || item)).filter(Boolean);
}

/**
 * Flatten a live Notion page properties object into the Phase 1A snapshot shape
 * (string / string[] values keyed by logical property name).
 */
export function flattenNotionPageProperties(properties = {}) {
  const out = {};
  for (const [name, prop] of Object.entries(properties || {})) {
    if (!prop || typeof prop !== 'object') continue;
    const type = prop.type;
    if (type === 'title') out[name] = titlePlain(prop.title);
    else if (type === 'rich_text') out[name] = richTextPlain(prop.rich_text);
    else if (type === 'email') out[name] = trim(prop.email);
    else if (type === 'select') out[name] = selectName(prop.select);
    else if (type === 'status') out[name] = selectName(prop.status);
    else if (type === 'multi_select') out[name] = multiSelectNames(prop.multi_select);
    else if (type === 'relation') out[name] = relationIds(prop.relation);
    else if (type === 'people') {
      out[name] = (prop.people || []).map((p) => trim(p?.name || p?.id)).filter(Boolean);
    } else if (type === 'number') {
      out[name] = prop.number == null ? '' : String(prop.number);
    } else if (type === 'checkbox') {
      out[name] = prop.checkbox ? 'true' : 'false';
    } else if (type === 'date') {
      out[name] = prop.date?.start || '';
    } else if (type === 'url') {
      out[name] = trim(prop.url);
    } else if (type === 'phone_number') {
      out[name] = trim(prop.phone_number);
    }
  }
  return out;
}

export function notionDatabaseToDeidentifiedSchema(database, { logicalDatabase = '활동·히스토리', capturedAt } = {}) {
  const properties = [];
  for (const [name, prop] of Object.entries(database?.properties || {})) {
    const type = prop?.type || 'unknown';
    const entry = { name, type };
    if (type === 'select' || type === 'multi_select' || type === 'status') {
      const options = prop[type]?.options || [];
      entry.options = options.map((item) => item?.name).filter(Boolean);
    }
    properties.push(entry);
  }
  properties.sort((a, b) => a.name.localeCompare(b.name));
  const schema = {
    schemaId: `live-${logicalDatabase}`,
    logicalDatabase,
    capturedAt: capturedAt || new Date().toISOString(),
    source: 'notion-readonly-collect',
    operationalMapping: 'live-pull-uncommitted',
    properties,
  };
  schema.schemaHash = schemaHash(schema);
  return schema;
}

async function queryAllPages(http, apiBase, databaseId) {
  const rows = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const response = await http(`${apiBase}/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Notion database query failed (${response.status}).`), {
        code: 'NOTION_QUERY_FAILED',
        status: response.status,
      });
    }
    const payload = await response.json();
    for (const page of payload.results || []) {
      rows.push({
        sourceId: trim(page.id),
        sourceUrl: trim(page.url),
        properties: flattenNotionPageProperties(page.properties),
        lastEditedTime: page.last_edited_time || null,
      });
    }
    cursor = payload.has_more ? payload.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function retrieveDatabase(http, apiBase, databaseId) {
  const response = await http(`${apiBase}/databases/${databaseId}`, { method: 'GET' });
  if (!response.ok) {
    throw Object.assign(new Error(`Notion database retrieve failed (${response.status}).`), {
      code: 'NOTION_DATABASE_RETRIEVE_FAILED',
      status: response.status,
    });
  }
  return response.json();
}

function snapshotContentHash(snapshot) {
  const canonical = JSON.stringify({
    workspaceId: snapshot.workspaceId,
    accounts: (snapshot.accounts || []).map((row) => ({ sourceId: row.sourceId, properties: row.properties })),
    projects: (snapshot.projects || []).map((row) => ({ sourceId: row.sourceId, properties: row.properties })),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function loadLastKnownGood(path) {
  if (!path || !fileReadable(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Collect a Phase 1B read-only snapshot via Notion HTTP (or recorded harness).
 * On schema/partial failure, keeps last-known-good file and returns stale/partial.
 */
export async function collectNotionReadonlySnapshot({
  env = process.env,
  cwd = process.cwd(),
  http = null,
  fetchImpl = null,
  token = null,
  databaseMap = null,
  expectedActivitySchema = null,
  outPath = null,
  now = () => new Date().toISOString(),
  skipCredentialGate = false,
} = {}) {
  const resolved = resolveNotionReadonlyConfig(env, { cwd });
  if (!skipCredentialGate && !resolved.ok && resolved.code === 'READONLY_DISABLED') {
    return {
      ok: false,
      code: 'READONLY_DISABLED',
      message: resolved.message,
      discovery: resolved.discovery,
      stale: true,
      completeness: 'partial',
      watermarks: { source: null, analysisComplete: null },
      metrics: null,
    };
  }
  if (!skipCredentialGate && !resolved.ok && resolved.code === 'BLOCKED_ON_SECRET') {
    return {
      ok: false,
      code: 'BLOCKED_ON_SECRET',
      message: resolved.message,
      discovery: resolved.discovery,
      stale: true,
      completeness: 'partial',
      watermarks: { source: null, analysisComplete: null },
      metrics: null,
    };
  }

  const discovery = resolved.discovery || resolveNotionReadonlyConfig({
    ...env,
    MAIL_INTELLIGENCE_NOTION_READONLY: '1',
  }, { cwd }).discovery;

  const targetOut = outPath || discovery.outPath;
  const lkg = loadLastKnownGood(targetOut);
  const apiBase = discovery.apiBase || NOTION_API_BASE;
  const notionVersion = discovery.notionVersion || NOTION_VERSION;

  let map;
  try {
    map = databaseMap
      ? loadNotionDatabaseMap(databaseMap, { cwd })
      : loadNotionDatabaseMap(discovery.databaseMapPath, { cwd });
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'DATABASE_MAP_INVALID',
      message: error.message,
      discovery,
      stale: true,
      completeness: 'partial',
      lastKnownGood: Boolean(lkg),
      watermarks: {
        source: lkg?.capturedAt || null,
        analysisComplete: lkg?.analysisCompleteAt || null,
      },
      metrics: null,
    };
  }

  const expectedSchema = expectedActivitySchema
    || loadDeidentifiedSchema(discovery.schemaPath);

  let client = http;
  if (!client) {
    const secret = token || loadNotionReadonlyToken(env, { cwd });
    client = createNotionReadonlyFetch({
      token: secret,
      fetchImpl: fetchImpl || globalThis.fetch,
      apiBase,
      notionVersion,
    });
  }

  const capturedAt = now();
  try {
    let activitySchema = null;
    if (map.activitiesDatabaseId) {
      const activityDb = await retrieveDatabase(client, apiBase, map.activitiesDatabaseId);
      activitySchema = notionDatabaseToDeidentifiedSchema(activityDb, {
        logicalDatabase: expectedSchema.logicalDatabase || '활동·히스토리',
        capturedAt,
      });
      const identity = validateSchemaIdentity(activitySchema);
      if (!identity.ok) {
        throw Object.assign(new Error(identity.message), { code: identity.code });
      }
      const access = validateSchemaAccess(activitySchema, { permission: 'read' });
      if (!access.ok) {
        throw Object.assign(new Error(access.message), { code: access.code });
      }
      // Fail closed if live select option sets diverge from the de-identified contract hash family:
      // require the same property names/types for mapped Activity evidence fields.
      const byName = new Map((activitySchema.properties || []).map((item) => [item.name, item]));
      for (const prop of expectedSchema.properties || []) {
        const live = byName.get(prop.name);
        if (!live) {
          throw Object.assign(new Error(`Live schema missing property: ${prop.name}`), {
            code: 'SCHEMA_PROPERTY_MISSING',
          });
        }
        if (live.type !== prop.type) {
          throw Object.assign(new Error(`Live schema type mismatch for ${prop.name}`), {
            code: 'SCHEMA_TYPE_MISMATCH',
          });
        }
      }
    }

    const [accounts, projects] = await Promise.all([
      queryAllPages(client, apiBase, map.accountsDatabaseId),
      queryAllPages(client, apiBase, map.projectsDatabaseId),
    ]);

    const snapshot = {
      workspaceId: map.workspaceId,
      snapshotId: `live-${capturedAt}`,
      capturedAt,
      analysisCompleteAt: capturedAt,
      readOnlySource: true,
      source: 'notion-readonly-collect',
      accounts,
      projects,
      activities: [],
      finance: [],
      activitySchemaHash: activitySchema?.schemaHash || expectedSchema.schemaHash || null,
    };
    snapshot.snapshotHash = snapshotContentHash(snapshot);
    assertSnapshotIdentity(snapshot);

    atomicWriteJson(targetOut, snapshot);

    const masters = mastersFromSnapshot(snapshot);
    return {
      ok: true,
      code: 'COLLECTED',
      message: 'Read-only Notion snapshot collected.',
      discovery,
      stale: false,
      completeness: 'complete',
      snapshotPath: targetOut,
      snapshot,
      watermarks: {
        source: snapshot.capturedAt,
        analysisComplete: snapshot.analysisCompleteAt,
      },
      metrics: {
        accountCount: accounts.length,
        projectCount: projects.length,
        masterCount: masters.length,
        schemaHash: snapshot.activitySchemaHash,
        snapshotHash: snapshot.snapshotHash,
        workspaceIdRedacted: Boolean(map.workspaceId),
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'COLLECT_FAILED',
      message: error.message || 'Notion read-only collect failed.',
      discovery,
      stale: true,
      completeness: 'partial',
      lastKnownGood: Boolean(lkg),
      snapshotPath: lkg ? targetOut : null,
      snapshot: lkg,
      watermarks: {
        source: lkg?.capturedAt || null,
        analysisComplete: lkg?.analysisCompleteAt || null,
      },
      metrics: lkg
        ? {
          accountCount: (lkg.accounts || []).length,
          projectCount: (lkg.projects || []).length,
          schemaHash: lkg.activitySchemaHash || lkg.schemaHash || null,
          snapshotHash: lkg.snapshotHash || null,
          fromLastKnownGood: true,
        }
        : null,
    };
  }
}

export function createLiveShapedRecordedScript({
  accountsDatabaseId = 'syn-db-accounts',
  projectsDatabaseId = 'syn-db-projects',
  activitiesDatabaseId = 'syn-db-activities',
  accountPages = [],
  projectPages = [],
  activityDatabaseProperties = null,
} = {}) {
  const activityProps = activityDatabaseProperties || {
    '활동명': { type: 'title', title: {} },
    '유형': { type: 'select', select: { options: [{ name: '메일 수신' }] } },
    '활동일': { type: 'date', date: {} },
    '요약': { type: 'rich_text', rich_text: {} },
    '출처 ID/경로': { type: 'rich_text', rich_text: {} },
    '근거등급': {
      type: 'select',
      select: {
        options: [
          { name: '확인된 사실' },
          { name: 'AI 추론' },
          { name: '사용자 제안' },
          { name: '가정' },
          { name: '기각' },
          { name: '이전 버전' },
        ],
      },
    },
    '확신도': {
      type: 'select',
      select: { options: [{ name: '높음' }, { name: '보통' }, { name: '낮음' }] },
    },
    '검토상태': {
      type: 'select',
      select: { options: [{ name: '검증완료' }, { name: '연결검토' }, { name: '제외' }] },
    },
    '자연키': { type: 'rich_text', rich_text: {} },
    '프로젝트': { type: 'relation', relation: {} },
    '고객·파트너': { type: 'relation', relation: {} },
  };

  return [
    {
      method: 'GET',
      matchUrl: new RegExp(`/databases/${activitiesDatabaseId}$`),
      json: {
        object: 'database',
        id: activitiesDatabaseId,
        properties: activityProps,
      },
    },
    {
      method: 'POST',
      matchUrl: new RegExp(`/databases/${accountsDatabaseId}/query`),
      json: {
        object: 'list',
        results: accountPages,
        has_more: false,
        next_cursor: null,
      },
    },
    {
      method: 'POST',
      matchUrl: new RegExp(`/databases/${projectsDatabaseId}/query`),
      json: {
        object: 'list',
        results: projectPages,
        has_more: false,
        next_cursor: null,
      },
    },
  ];
}

export { validateSnapshotIdentity };
