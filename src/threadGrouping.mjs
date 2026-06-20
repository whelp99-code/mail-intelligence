import {
  groupMessagesByThread,
  normalizedSubjectKey,
  subjectSimilarity,
  threadLabel,
  userRepliedInThread
} from './threadIdentity.mjs';

export function buildThreadGroupingPrompt(messages) {
  return `Return ONLY valid JSON. No markdown.

You cluster business email messages into conversation threads.
Group messages when they discuss the same customer issue, ticket, quote, license, or follow-up — even if subjects differ slightly or senders change.
Separate threads when the business topic, customer project, or ticket clearly differs.

Signals to use (priority):
1. Same ticket id like Ticket#20260604860001
2. Same normalized topic (VDI max VM, license renewal, quote request)
3. Reply chains: RE/FW, quoted context, references to prior mail
4. inbox + sentitems about the same subject line
5. Do NOT merge unrelated GS건설 mails only because the company name matches

For each thread assign a short stable groupKey (kebab-case English or romanized topic, e.g. "gs-vdi-max-vm-inquiry").

Required JSON:
{
  "threads": [
    {
      "groupKey": "short-key",
      "messageIds": ["id1", "id2"],
      "title": "Korean one-line thread title",
      "rationale": "short Korean reason",
      "userAlreadyReplied": false
    }
  ]
}

Messages:
${JSON.stringify(
    messages.map((message) => ({
      id: message.id,
      folder: message.mailFolder || 'inbox',
      from: message.fromName || message.from,
      to: message.to || [],
      receivedAt: message.receivedAt,
      subject: message.subject,
      body: String(message.body || message.bodyPreview || '').slice(0, 500)
    })),
    null,
    2
  )}`;
}

export function parseThreadGroupingResponse(raw) {
  const text = String(raw || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    parsed = JSON.parse(match[0]);
  }
  return Array.isArray(parsed?.threads) ? parsed.threads : [];
}

export function assignmentsFromThreads(threads) {
  const map = new Map();
  for (const thread of threads) {
    const groupKey = String(thread?.groupKey || '').trim();
    if (!groupKey) continue;
    for (const id of thread?.messageIds || []) {
      if (id) map.set(String(id), groupKey);
    }
  }
  return map;
}

export function applyAssignments(messages, assignments) {
  return messages.map((message) => {
    const assigned = assignments.get(message.id);
    if (!assigned) return message;
    return { ...message, aiGroupKey: assigned, aiGroupSource: 'ai' };
  });
}

/** Rule-based group keys for messages still missing aiGroupKey. */
export function applyRuleBasedGroupKeys(messages, options = {}) {
  const pending = messages.filter((message) => !message.aiGroupKey);
  if (!pending.length) return messages;

  const ruleGroups = groupMessagesByThread(pending, options);
  const next = [...messages];
  for (const [rawKey, items] of ruleGroups.entries()) {
    const groupKey = rawKey.replace(/^(conv|subj|msg):/, 'rule-').slice(0, 80);
    for (const item of items) {
      const index = next.findIndex((message) => message.id === item.id);
      if (index >= 0 && !next[index].aiGroupKey) {
        next[index] = { ...next[index], aiGroupKey: groupKey, aiGroupSource: 'rules' };
      }
    }
  }
  return next;
}

export function unifyGroupKeysBySubject(messages) {
  const buckets = new Map();
  for (const message of messages) {
    const subjectKey = normalizedSubjectKey(message.subject);
    if (subjectKey.length < 6) continue;
    if (!buckets.has(subjectKey)) buckets.set(subjectKey, []);
    buckets.get(subjectKey).push(message);
  }

  const next = messages.map((message) => ({ ...message }));
  for (const items of buckets.values()) {
    if (items.length < 2) continue;
    const keys = [...new Set(items.map((item) => item.aiGroupKey).filter(Boolean))];
    const subjectKey = normalizedSubjectKey(items[0].subject);
    const canonical =
      keys.find((key) => key.includes(subjectKey.slice(0, 24))) ||
      keys.find((key) => key.startsWith('rule-')) ||
      keys[0] ||
      `rule-${subjectKey.slice(0, 72)}`;

    for (const item of items) {
      const index = next.findIndex((message) => message.id === item.id);
      if (index >= 0) {
        next[index] = {
          ...next[index],
          aiGroupKey: canonical,
          aiGroupSource: next[index].aiGroupSource || 'rules'
        };
      }
    }
  }
  return next;
}

export function summarizeThreadGroups(messages, options = {}) {
  const groups = groupMessagesByThread(messages, options);
  return [...groups.entries()].map(([key, items]) => ({
    key,
    count: items.length,
    label: threadLabel(items),
    messageIds: items.map((item) => item.id),
    participants: [...new Set(items.map((item) => item.fromName || item.from).filter(Boolean))],
    userReplied: userRepliedInThread(items, options.mailboxUser || ''),
    sources: [...new Set(items.map((item) => item.aiGroupSource || (item.aiGroupKey ? 'ai' : 'rules')).filter(Boolean))],
    aiGrouped: items.some((item) => item.aiGroupSource === 'ai')
  }));
}

export function messagesNeedingAiGrouping(messages, cachedById = new Map()) {
  return messages.filter((message) => {
    const cached = cachedById.get(message.id);
    if (
      cached?.aiGroupSource === 'ai' &&
      cached?.aiGroupKey &&
      cached?.changeKey === message.changeKey
    ) {
      return false;
    }
    if (process.env.MAIL_AI_THREAD_FORCE === '1') return true;
    return !cached?.aiGroupKey || cached?.aiGroupSource !== 'ai';
  });
}

export function subjectClusterCandidates(messages) {
  const pairs = [];
  for (let i = 0; i < messages.length; i += 1) {
    for (let j = i + 1; j < messages.length; j += 1) {
      const a = messages[i];
      const b = messages[j];
      const sim = subjectSimilarity(a.subject, b.subject);
      if (sim >= 0.55) pairs.push({ a, b, sim });
    }
  }
  return pairs.sort((x, y) => y.sim - x.sim);
}

export function stableRuleGroupKey(message) {
  const subjectKey = normalizedSubjectKey(message?.subject);
  return subjectKey ? `rule-${subjectKey.slice(0, 72)}` : `rule-msg-${message?.id || 'unknown'}`;
}
