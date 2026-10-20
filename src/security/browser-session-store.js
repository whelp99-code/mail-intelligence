import { readFile, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

export function openBrowserSessionStore(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 5000;');
  const removeStale = db.prepare(
    'DELETE FROM browser_sessions WHERE access_key_binding != ? OR created_at < ?',
  );
  const selectActive = db.prepare(`
    SELECT token_hash, csrf_token, created_at
    FROM browser_sessions
    WHERE access_key_binding = ? AND created_at >= ?
  `);
  const insertSession = db.prepare(`
    INSERT INTO browser_sessions(token_hash, csrf_token, created_at, access_key_binding)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token_hash) DO NOTHING
  `);
  const deleteAll = db.prepare('DELETE FROM browser_sessions');

  return {
    loadActive(binding, now, ttlMs) {
      const oldestKept = now - ttlMs;
      removeStale.run(binding, oldestKept);
      return selectActive.all(binding, oldestKept);
    },

    replaceAll(binding, sessions) {
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteAll.run();
        for (const session of sessions) {
          insertSession.run(session.tokenHash, session.csrfToken, session.createdAt, binding);
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
          imported += insertSession.run(item.tokenHash, item.csrfToken, item.createdAt, binding).changes;
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
