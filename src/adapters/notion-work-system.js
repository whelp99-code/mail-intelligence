import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { assertWorkSystemPort } from './work-system-port.js';

function text(properties = {}, names = []) {
  for (const name of names) {
    const value = properties[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stringList(properties = {}, names = []) {
  for (const name of names) {
    const value = properties[name];
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
    }
    if (typeof value === 'string' && value.trim()) return [value.trim()];
  }
  return [];
}

export function validateSnapshotIdentity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, code: 'SNAPSHOT_INVALID', message: 'Notion snapshot is missing.' };
  }
  if (!String(snapshot.workspaceId || '').trim()) {
    return { ok: false, code: 'SNAPSHOT_WORKSPACE_MISSING', message: 'Snapshot requires workspaceId.' };
  }
  const hash = String(snapshot.snapshotHash || snapshot.schemaHash || '').trim();
  if (!/^sha256:\S+$/i.test(hash)) {
    return { ok: false, code: 'SNAPSHOT_HASH_MISSING', message: 'Snapshot requires snapshotHash or schemaHash.' };
  }
  const captured = String(snapshot.capturedAt || snapshot.captured_at || '').trim();
  if (!captured || Number.isNaN(Date.parse(captured))) {
    return { ok: false, code: 'SNAPSHOT_CAPTURED_AT_MISSING', message: 'Snapshot requires capturedAt.' };
  }
  return {
    ok: true,
    workspaceId: String(snapshot.workspaceId).trim(),
    hash,
    capturedAt: captured,
  };
}

export function assertSnapshotIdentity(snapshot) {
  const result = validateSnapshotIdentity(snapshot);
  if (!result.ok) {
    throw Object.assign(new Error(result.message), { code: result.code });
  }
  return snapshot;
}

export function loadNotionSnapshot(snapshotOrPath) {
  if (snapshotOrPath && typeof snapshotOrPath === 'object' && !Array.isArray(snapshotOrPath)) {
    return assertSnapshotIdentity(snapshotOrPath);
  }
  const path = String(snapshotOrPath || '').trim();
  if (!path) {
    throw Object.assign(new Error('Notion snapshot path is required.'), { code: 'SNAPSHOT_REQUIRED' });
  }
  const absolute = isAbsolute(path) ? path : resolve(path);
  return assertSnapshotIdentity(JSON.parse(readFileSync(absolute, 'utf8')));
}

export function mastersFromSnapshot(snapshot) {
  const accounts = (snapshot.accounts || []).map((row) => ({
    objectType: 'account',
    system: 'notion',
    externalId: String(row.sourceId || '').trim(),
    name: text(row.properties, ['회사/조직명', '회사명', 'Name', 'title']),
    projectKey: '',
    aliases: [],
    primaryEmail: text(row.properties, ['대표 이메일', '이메일']).toLowerCase(),
    nextAction: '',
    accountSourceIds: [],
  })).filter((item) => item.externalId && item.name);

  const engagements = (snapshot.projects || []).map((row) => ({
    objectType: 'engagement',
    system: 'notion',
    externalId: String(row.sourceId || '').trim(),
    name: text(row.properties, ['프로젝트명(Title)', '프로젝트명', 'Name', 'title']),
    projectKey: text(row.properties, ['프로젝트ID', '프로젝트 ID', 'Project Key']),
    aliases: stringList(row.properties, ['별칭', 'aliases']),
    primaryEmail: '',
    nextAction: text(row.properties, ['다음 행동']),
    accountSourceIds: stringList(row.properties, ['고객·파트너', '고객', 'accountSourceIds']),
  })).filter((item) => item.externalId && item.name);

  return [...engagements, ...accounts];
}

export function createNotionWorkSystem({
  snapshot,
  snapshotPath,
  readonlyCollect = null,
} = {}) {
  const port = {
    system: 'notion',
    async listMasters() {
      if (readonlyCollect && typeof readonlyCollect === 'function') {
        const result = await readonlyCollect();
        if (!result?.ok) {
          if (result?.snapshot) {
            // Stale/partial: keep last-known-good masters when collect failed.
            return mastersFromSnapshot(assertSnapshotIdentity(result.snapshot));
          }
          throw Object.assign(new Error(result?.message || 'Notion read-only collect failed.'), {
            code: result?.code || 'NOTION_READONLY_COLLECT_FAILED',
            collect: result || null,
          });
        }
        return mastersFromSnapshot(assertSnapshotIdentity(result.snapshot));
      }
      const loaded = assertSnapshotIdentity(snapshot || loadNotionSnapshot(snapshotPath));
      return mastersFromSnapshot(loaded);
    },
    async proposeActivity() {
      throw Object.assign(new Error('Notion write is disabled in Phase 1.'), { code: 'NOTION_WRITE_DISABLED' });
    },
    async fetchCommitments() {
      const masters = await port.listMasters();
      return masters
        .filter((item) => item.objectType === 'engagement' && item.nextAction)
        .map((item) => ({
          objectType: 'commitment',
          system: 'notion',
          externalId: `${item.externalId}:next-action`,
          name: item.nextAction,
          engagementExternalId: item.externalId,
        }));
    },
  };
  return assertWorkSystemPort(port);
}

export function createRecordingFetch(calls) {
  return async function recordingFetch(url, options = {}) {
    calls.push({ url: String(url), method: String(options.method || 'GET').toUpperCase() });
    throw Object.assign(new Error('Live Notion HTTP is forbidden in Phase 1.'), { code: 'NOTION_HTTP_FORBIDDEN' });
  };
}
