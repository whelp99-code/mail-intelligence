// Read-only list of attachments stored for a received message.
// Metadata comes from GET /api/intelligence/attachments; file content stays in Outlook.

const TYPE_LABELS = [
  [/^application\/pdf$/i, 'PDF'],
  [/spreadsheet|ms-excel|\/csv$/i, '스프레드시트'],
  [/wordprocessing|msword|rtf/i, '문서'],
  [/presentation|ms-powerpoint/i, '프레젠테이션'],
  [/zip|x-7z|x-rar|x-tar|gzip/i, '압축 파일'],
  [/^image\//i, '이미지'],
  [/^text\//i, '텍스트'],
  [/message\/rfc822/i, '메일'],
];

export function attachmentTypeLabel(item = {}) {
  const graphType = String(item.attachmentType || '');
  if (/itemAttachment/i.test(graphType)) return '첨부된 메일·항목';
  if (/referenceAttachment/i.test(graphType)) return '링크 첨부';
  const contentType = String(item.contentType || '').trim();
  if (!contentType) return '형식 미상';
  const match = TYPE_LABELS.find(([pattern]) => pattern.test(contentType));
  return match ? match[1] : contentType;
}

export function formatReceivedAttachmentSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function receivedAttachmentView(payload = {}) {
  const items = (Array.isArray(payload.attachments) ? payload.attachments : []).filter(Boolean);
  const files = items.filter((item) => !item.isInline);
  const inlineCount = items.length - files.length;
  return {
    total: items.length,
    inlineCount,
    files: files.map((item) => ({
      name: String(item.name || '').trim() || '이름 없는 첨부 파일',
      meta: [attachmentTypeLabel(item), formatReceivedAttachmentSize(item.size)].filter(Boolean).join(' · '),
    })),
  };
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderReceivedAttachments(container, state = {}, doc = globalThis.document) {
  if (!container || !doc) return;
  const heading = element(doc, 'h4', '', '첨부 파일');
  if (state.status === 'loading') {
    container.hidden = false;
    container.replaceChildren(heading, element(doc, 'p', 'attachment-live', '첨부 파일 목록을 불러오는 중입니다.'));
    return;
  }
  if (state.status === 'error') {
    container.hidden = false;
    const reason = String(state.message || '').trim();
    container.replaceChildren(
      heading,
      element(doc, 'p', 'attachment-row-error', `첨부 파일 목록을 불러오지 못했습니다.${reason ? ` (${reason})` : ''}`),
    );
    return;
  }
  const view = receivedAttachmentView(state.payload || {});
  if (!view.total) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  heading.textContent = view.files.length ? `첨부 파일 ${view.files.length}개` : '첨부 파일';
  const nodes = [heading];
  if (view.files.length) {
    const list = element(doc, 'ul', 'attachment-list received-attachment-list');
    list.setAttribute('aria-label', '받은 첨부 파일 목록');
    for (const file of view.files) {
      const row = element(doc, 'li', 'attachment-row');
      const main = element(doc, 'div', 'attachment-row-main');
      main.append(element(doc, 'div', 'attachment-row-name', file.name), element(doc, 'div', 'attachment-row-meta', file.meta));
      row.append(main);
      list.append(row);
    }
    nodes.push(list);
  }
  const notes = [];
  if (view.inlineCount) {
    notes.push(view.files.length
      ? `본문에 삽입된 이미지 ${view.inlineCount}개는 목록에서 제외했습니다.`
      : `별도 첨부 파일은 없고, 본문에 삽입된 이미지 ${view.inlineCount}개가 있습니다.`);
  }
  if (view.files.length) notes.push('파일 열기와 내려받기는 Outlook에서 합니다.');
  if (notes.length) nodes.push(element(doc, 'p', 'attachment-live', notes.join(' ')));
  container.replaceChildren(...nodes);
}
