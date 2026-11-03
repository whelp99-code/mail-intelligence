import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
parentPort.on('message', () => {
  try {
    const quick = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const ok = quick.length === 1 && quick[0] === 'ok' && foreignKeys.length === 0;
    parentPort.postMessage({ ok });
  } catch {
    parentPort.postMessage({ ok: false });
  }
});
