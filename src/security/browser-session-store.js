import { readFile, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

export function openBrowserSessionStore(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 5000;');
  const deleteBinding = db.prepare('DELETE FROM browser_sessions WHERE access_key_binding = ?');
  const deleteExpired = db.prepare('DELETE FROM browser_sessions WHERE access_key_binding = ? AND created_at < ?');
  const selectActive = db.prepare(`
    SELECT token_hash, csrf_token, created_at, role, access_key_binding
    FROM browser_sessions
    WHERE access_key_binding = ? AND created_at >= ?
  `);
  const insertSession = db.prepare(`
    INSERT INTO browser_sessions(token_hash, csrf_token, created_at, access_key_binding, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO NOTHING
  `);

  return {
    loadActive(bindings, now, ttlMs) {
      const current = (Array.isArray(bindings) ? bindings : [bindings]).filter(Boolean);
      const oldestKept = now - ttlMs;
      if (current.length === 0) return [];
      const kept = new Set(current);
      for (const row of db.prepare('SELECT DISTINCT access_key_binding FROM browser_sessions').all()) {
        if (!kept.has(row.access_key_binding)) deleteBinding.run(row.access_key_binding);
      }
      const loaded = [];
      for (const binding of current) {
        deleteExpired.run(binding, oldestKept);
        loaded.push(...selectActive.all(binding, oldestKept));
      }
      return loaded;
    },

    replaceAll(binding, sessions) {
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteBinding.run(binding);
        for (const session of sessions) {
          const role = session.role === 'viewer' ? 'viewer' : 'operator';
          insertSession.run(session.tokenHash, session.csrfToken, session.createdAt, binding, role);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async importLegacyJson(filePath, binding) {
      let raw;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return { imported: 0 };
        return { imported: 0, warning: error.message };
      }
      let stored;
      try {
        stored = JSON.parse(raw);
      } catch (error) {
        return { imported: 0, warning: error.message };
      }
      if (stored?.binding !== binding || !Array.isArray(stored.sessions)) return { imported: 0 };
      let imported = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of stored.sessions) {
          if (typeof item?.tokenHash !== 'string' || typeof item.csrfToken !== 'string' || !Number.isFinite(item.createdAt)) continue;
          const role = item.role === 'viewer' ? 'viewer' : 'operator';
          imported += insertSession.run(item.tokenHash, item.csrfToken, item.createdAt, binding, role).changes;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      await unlink(filePath);
      return { imported };
    },

    close() {
      db.close();
    },
  };
}
