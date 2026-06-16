/**
 * Microsoft Graph delta query helpers for inbox incremental sync.
 */

export function deltaFolderPath(mailboxBase, mailFolder) {
  if (mailFolder === 'sentitems') {
    return `${mailboxBase}/mailFolders/sentitems/messages/delta`;
  }
  return `${mailboxBase}/mailFolders/inbox/messages/delta`;
}

export function parseDeltaResponse(payload) {
  return {
    messages: payload.value || [],
    nextLink: payload['@odata.nextLink'] || '',
    deltaLink: payload['@odata.deltaLink'] || ''
  };
}

export async function fetchGraphDeltaPage({ accessToken, url, normalizeMessage, mailFolder }) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph delta failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const parsed = parseDeltaResponse(payload);
  return {
    ...parsed,
    messages: parsed.messages.map((item) => {
      if (item?.['@removed']) {
        return {
          id: item.id,
          removed: true,
          removalReason: item['@removed']?.reason || ''
        };
      }
      return normalizeMessage(item, mailFolder);
    })
  };
}

export async function runDeltaSync({
  accessToken,
  mailboxBase,
  mailFolder,
  deltaLink,
  normalizeMessage,
  maxPages = 10
}) {
  const select =
    '$select=id,changeKey,conversationId,internetMessageId,lastModifiedDateTime,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,importance,isRead,hasAttachments,bodyPreview,body,webLink';

  let url =
    deltaLink ||
    `https://graph.microsoft.com/v1.0${deltaFolderPath(mailboxBase, mailFolder)}?${select}`;

  const collected = [];
  let pages = 0;
  let latestDeltaLink = deltaLink || '';

  while (url && pages < maxPages) {
    const page = await fetchGraphDeltaPage({ accessToken, url, normalizeMessage, mailFolder });
    collected.push(...page.messages);
    latestDeltaLink = page.deltaLink || latestDeltaLink;
    url = page.nextLink;
    pages += 1;
    if (page.deltaLink) break;
  }

  return { messages: collected, deltaLink: latestDeltaLink, pages };
}
