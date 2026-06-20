#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { applyRuleBasedGroupKeys, summarizeThreadGroups, unifyGroupKeysBySubject } from '../src/threadGrouping.mjs';
import { resolveDataPath, DATA_FILES } from '../src/dataPaths.mjs';

const baseUrl = process.env.MAIL_VERIFY_URL || 'http://localhost:3010';
const top = Number(process.env.MAIL_VERIFY_TOP || 50);

async function loadCacheMessages() {
  const mailCachePath = await resolveDataPath(DATA_FILES.mailCache, DATA_FILES.legacyMailCache);
  const raw = await readFile(mailCachePath, 'utf8');
  const cache = JSON.parse(raw);
  const mailbox = Object.values(cache.mailboxes || {})[0];
  return mailbox?.messages || [];
}

function printGsVdiReport(messages, threadGroups) {
  const needle = /gs건설\s*vdi\s*구동\s*가능\s*최대\s*vm/i;
  const hits = messages.filter((message) => needle.test(message.subject || ''));
  const grouped = (threadGroups || []).find((group) =>
    group.messageIds?.some((id) => hits.some((message) => message.id === id))
  );
  console.log('\n=== GS VDI max VM thread ===');
  if (grouped) {
    console.log(JSON.stringify(grouped, null, 2));
    console.log(grouped.count >= 2 && grouped.userReplied ? '\nPASS: merged thread with reply detection.' : '\nWARN: thread found but check count/replied.');
    return grouped.count >= 2;
  }
  console.log('hits in display slice:', hits.length);
  hits.forEach((message) => {
    console.log(`- ${message.fromName || message.from} | ${message.subject} | group=${message.aiGroupKey || '(none)'}`);
  });
  return hits.length >= 2 && new Set(hits.map((m) => m.aiGroupKey)).size === 1;
}

async function main() {
  console.log('Fetching', `${baseUrl}/api/outlook/analyze?top=${top}&sync=cache`);
  const response = await fetch(`${baseUrl}/api/outlook/analyze?top=${top}&sync=cache`);
  const payload = await response.json();
  if (!response.ok) {
    console.error('Analyze failed:', payload.message || response.status);
    process.exit(1);
  }

  console.log('connected:', payload.connected);
  console.log('messages:', payload.messages?.length || 0);
  console.log('threadGrouping:', payload.threadGrouping);
  console.log('threadGroups:', payload.threadGroups?.length || 0);

  const multi = (payload.threadGroups || []).filter((group) => group.count > 1).slice(0, 8);
  console.log('\n=== Sample multi-message threads ===');
  multi.forEach((group) => {
    console.log(`- ${group.label} (${group.count}통, replied=${group.userReplied}, ai=${group.aiGrouped})`);
  });

  const gsOk = printGsVdiReport(payload.messages || [], payload.threadGroups || []);

  const cached = await loadCacheMessages();
  const ruled = unifyGroupKeysBySubject(applyRuleBasedGroupKeys(cached));
  const offlineGs = summarizeThreadGroups(
    ruled.filter((message) => /gs건설\s*vdi\s*구동\s*가능\s*최대\s*vm/i.test(message.subject || ''))
  );
  console.log('\n=== Offline full-cache GS thread ===');
  console.log(JSON.stringify(offlineGs[0] || {}, null, 2));

  if (gsOk || (offlineGs[0]?.count >= 2 && offlineGs[0]?.userReplied)) {
    console.log('\nPASS: GS VDI thread grouping verified.');
    process.exit(0);
  }
  console.error('\nFAIL: GS VDI thread grouping incomplete.');
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
