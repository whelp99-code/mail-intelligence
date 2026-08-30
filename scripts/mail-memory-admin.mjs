#!/usr/bin/env node

import { resolve, join } from 'node:path';
import { PersistentMailMemoryRuntime } from '../src/application/persistent-mail-memory.js';
import { restoreDatabaseFromBackup } from '../src/storage/backup-restore.js';
import { importLegacyMailCache } from '../src/storage/legacy-import.js';
import { resolveStoragePaths } from '../src/storage/storage-paths.js';

function usage() {
  return `Mail Intelligence persistent-memory administration

Usage:
  node scripts/mail-memory-admin.mjs status
  node scripts/mail-memory-admin.mjs integrity
  node scripts/mail-memory-admin.mjs backup [absolute-or-relative-target]
  node scripts/mail-memory-admin.mjs import-legacy [absolute-or-relative-json]
  node scripts/mail-memory-admin.mjs restore <absolute-or-relative-backup> --confirm-stopped

Restore is intentionally available only through this offline CLI. Stop the Mail
Intelligence server first; the command preserves the previous live database as
an owner-only rollback file.`;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command = '', ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const paths = resolveStoragePaths();
  const migrationsDir = join(paths.appRoot, 'migrations');
  const backupDirectory = resolve(process.env.MAIL_INTELLIGENCE_BACKUP_DIR || join(paths.dataDir, 'backups'));

  if (command === 'restore') {
    const backupArgument = args.find((value) => !value.startsWith('--'));
    if (!backupArgument) throw new Error('restore requires a backup path.');
    const confirmServerStopped = args.includes('--confirm-stopped');
    const result = await restoreDatabaseFromBackup({
      backupPath: resolve(backupArgument),
      databasePath: paths.databasePath,
      rollbackDirectory: join(backupDirectory, 'restore-rollbacks'),
      confirmServerStopped,
    });
    print({ command, ...result });
    return;
  }

  const runtime = new PersistentMailMemoryRuntime({
    databasePath: paths.databasePath,
    migrationsDir,
    backupDirectory,
    legacyCachePaths: [paths.legacyCachePath],
  });
  try {
    await runtime.initialize();
    if (command === 'status') {
      print({
        command,
        databasePath: paths.databasePath,
        backupDirectory,
        ...runtime.storageStatus(process.env.OUTLOOK_MAILBOX_USER || ''),
      });
      return;
    }
    if (command === 'integrity') {
      print({
        command,
        databasePath: paths.databasePath,
        ...runtime.store.integrityCheck(),
      });
      return;
    }
    if (command === 'backup') {
      const target = args[0] ? resolve(args[0]) : '';
      const result = await runtime.backup({ targetPath: target });
      print({
        command,
        backupName: result.manifest.backup_name,
        checksumSha256: result.checksumSha256,
        sizeBytes: result.sizeBytes,
        schemaVersion: result.schemaVersion,
        validation: result.validation,
      });
      return;
    }
    if (command === 'import-legacy') {
      const sourcePath = resolve(args[0] || paths.legacyCachePath);
      const result = await importLegacyMailCache({
        store: runtime.store,
        sourcePath,
      });
      print({ command, sourcePath, ...result });
      return;
    }
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  } finally {
    runtime.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code || 'MAIL_MEMORY_ADMIN_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
