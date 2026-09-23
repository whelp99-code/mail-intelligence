import { DRIVE_LINK_WARNING, parseDriveLink } from './application/drive-links.js';

const statuses = {
  needs_approval: '승인 대기', needs_clarification: '정보 확인 필요', approved: '승인됨',
  sending: '발송 결과 확인 중 · 재발송하지 않음', sent: '발송 확인', failed: '발송 실패', cancelled: '취소됨',
};

const errors = {
  MAIL_SEND_DISABLED: '발송이 꺼져 있습니다. 운영자가 발송 플래그를 켜야 승인할 수 있습니다.',
  MAIL_SEND_SCOPE_REQUIRED: 'Microsoft Mail.Send 권한 재동의가 필요합니다. 발송하지 않았습니다.',
  AUTHENTICATED_OPERATOR_REQUIRED: '인증된 운영자 세션이 필요합니다.',
  CSRF_REQUIRED: '보안 세션을 새로 고친 뒤 다시 검토해 주세요.',
  INVALID_RECIPIENT: '수신자·참조에는 직접 확인한 이메일 주소를 입력해 주세요.',
  DRAFT_NOT_APPROVABLE: '이 초안은 승인할 수 없는 상태입니다. 내용을 확인해 새 초안을 작성하세요.',
  ATTACHMENTS_DISABLED: '첨부 기능이 비활성화되어 있습니다.',
  SCANNER_UNAVAILABLE: '첨부 검사기를 사용할 수 없습니다.',
  ATTACHMENT_TOO_LARGE: '첨부 파일이 허용 크기를 초과했습니다.',
  ATTACHMENT_QUOTA_EXCEEDED: '첨부 저장 용량을 초과했습니다.',
  UNSUPPORTED_FILE: '지원하지 않는 파일입니다.',
  REQUEST_CONFLICT: '동일한 요청 ID에 다른 파일이 있습니다.',
  ASSET_CHANGED: '첨부 파일이 변경되어 다시 업로드해야 합니다.',
  DRAFT_IMMUTABLE: '저장된 초안의 파일은 바꿀 수 없습니다. 새 초안을 작성하세요.',
  INVALID_DRIVE_LINK: '허용된 Google Drive 링크가 아니거나 접근 경고를 확인하지 않았습니다.',
  DRIVE_ACCESS_DENIED: '선택한 Google Drive 파일에 접근할 수 없습니다.',
  DRIVE_SOURCE_CHANGED: 'Drive 원본이 변경되어 다시 가져와야 합니다.',
  DRIVE_RECHECK_UNAVAILABLE: 'Drive 연결을 사용할 수 없습니다.',
  EXPORT_UNSUPPORTED: '지원하지 않는 Drive 변환 형식입니다.',
};

export function encodeBrowserFileName(name) {
  const bytes = new TextEncoder().encode(String(name));
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function formatAttachmentBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} bytes`;
  return `${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`;
}

export function composeSaveBlocked(items) {
  return items.some((item) => item.state !== 'ready');
}

export function initializeSendReview(apiFetch) {
  const panel = document.querySelector('#sendDraftReview');
  if (!panel) return;
  const list = panel.querySelector('#sendDraftList');
  const detail = panel.querySelector('#sendDraftDetail');
  const status = panel.querySelector('#sendDraftStatus');
  const form = panel.querySelector('#sendDraftForm');
  const composeList = panel.querySelector('#composeAttachmentList');
  const live = panel.querySelector('#attachmentLive');
  const fileInput = panel.querySelector('#attachmentFileInput');
  const saveButton = panel.querySelector('#saveSendDraft');
  const driveComposer = panel.querySelector('#driveLinkComposer');
  const driveUrl = panel.querySelector('#driveLinkUrl');
  const driveLabel = panel.querySelector('#driveLinkLabel');
  const driveAck = panel.querySelector('#driveLinkAck');
  const driveFileComposer = panel.querySelector('#driveFileComposer');
  const driveConnectionStatus = panel.querySelector('#driveConnectionStatus');
  const driveFileId = panel.querySelector('#driveFileId');
  const driveExportMime = panel.querySelector('#driveExportMime');
  let driveConnectionId = '';
  let pickerToken = '';
  let selected = null;
  let sendEnabled = false;
  let busy = false;
  let requestId = null;
  let refreshVersion = 0;
  const pending = [];
  const pendingLinks = [];

  function node(tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function readError(result, fallback) {
    const code = result?.error?.code || result?.code;
    const requestTrace = result?.error?.request_id ? ` · 요청 ${result.error.request_id}` : '';
    return (errors[code] || result?.error?.message || fallback) + requestTrace;
  }
  async function request(path = '', body, options = {}) {
    const response = await apiFetch(options.url || ('/api/mail/send-drafts' + path), body === undefined ? { ...options } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, body: JSON.stringify(body),
    });
    if (options.raw) return response;
    const result = await response.json();
    if (!response.ok) throw new Error(readError(result, `요청을 완료하지 못했습니다 (${result.code || response.status}). 발송 상태를 다시 확인하세요.`));
    return result;
  }
  function syncCompose() {
    if (!composeList) return;
    composeList.replaceChildren();
    for (const item of pending) {
      const row = node('li', '', 'attachment-row');
      const main = node('div', '', 'attachment-row-main');
      main.append(node('div', item.name, 'attachment-row-name'));
      main.append(node('div', `${formatAttachmentBytes(item.size)} · 출처: ${item.origin === 'drive' ? 'Google Drive 사본' : 'PC 파일'} · 검사: ${item.state}`, 'attachment-row-meta'));
      if (item.error) main.append(node('div', item.error, 'attachment-row-error'));
      const remove = node('button', '제거');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        syncCompose();
      });
      row.append(main, remove);
      composeList.append(row);
    }
    for (const item of pendingLinks) {
      const row = node('li', '', 'drive-link-row');
      const main = node('div', '', 'attachment-row-main');
      main.append(node('div', item.label, 'attachment-row-name'));
      main.append(node('div', item.url, 'attachment-row-meta'));
      main.append(node('div', DRIVE_LINK_WARNING, 'attachment-row-meta'));
      const remove = node('button', '제거');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        const index = pendingLinks.indexOf(item);
        if (index >= 0) pendingLinks.splice(index, 1);
        requestId = null;
        syncCompose();
      });
      row.append(main, remove);
      composeList.append(row);
    }
    const blocked = composeSaveBlocked(pending);
    if (saveButton) saveButton.disabled = busy || blocked;
    if (live) {
      const parts = [];
      if (pending.length) {
        parts.push(blocked ? '파일 검사가 끝나기 전에는 초안을 저장할 수 없습니다.' : `준비된 첨부 ${pending.length}개`);
      }
      if (pendingLinks.length) parts.push(`Drive 링크 ${pendingLinks.length}개`);
      live.textContent = parts.join(' · ') || '첨부를 선택하지 않았습니다.';
    }
  }
  async function uploadFile(file) {
    const item = { name: file.name, size: file.size, state: 'uploading', id: '', error: '', origin: 'local' };
    pending.push(item);
    syncCompose();
    try {
      const response = await apiFetch('/api/mail/attachment-assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Request-Id': crypto.randomUUID(),
          'X-File-Name': encodeBrowserFileName(file.name),
          'X-File-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(readError(result, '파일 업로드에 실패했습니다.'));
      item.state = result.state || 'ready';
      item.id = result.id;
      item.size = result.size;
      item.name = result.name;
    } catch (error) {
      item.state = 'failed';
      item.error = error.message;
    }
    syncCompose();
  }
  function showAttachments(target, attachments, links = [], { downloadable = false } = {}) {
    if (!attachments?.length && !links?.length) {
      target.append(node('p', '첨부 파일 없음 · 링크 없음'));
      return;
    }
    const rows = node('ul', '', 'attachment-list');
    for (const item of attachments) {
      const row = node('li', '', 'attachment-row');
      const main = node('div', '', 'attachment-row-main');
      main.append(node('div', item.name, 'attachment-row-name'));
      main.append(node('div', `${formatAttachmentBytes(item.size)} · 출처: ${item.origin || 'local'} · 검사: ${item.state || 'ready'}`, 'attachment-row-meta'));
      row.append(main);
      if (downloadable) {
        const download = node('button', '다운로드하여 검토');
        download.type = 'button';
        download.addEventListener('click', () => downloadAsset(item));
        row.append(download);
      }
      rows.append(row);
    }
    for (const item of links) {
      const row = node('li', '', 'drive-link-row');
      const main = node('div', '', 'attachment-row-main');
      main.append(node('div', item.label, 'attachment-row-name'));
      main.append(node('div', item.url, 'attachment-row-meta'));
      main.append(node('div', DRIVE_LINK_WARNING, 'attachment-row-meta'));
      row.append(main);
      rows.append(row);
    }
    target.append(rows);
  }
  async function downloadAsset(item) {
    status.textContent = `${item.name} 다운로드를 준비하는 중입니다.`;
    const response = await apiFetch(`/api/mail/attachment-assets/${item.id}/content`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(readError(result, '첨부 파일을 받을 수 없습니다.'));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = node('a', item.name);
    anchor.href = url;
    anchor.setAttribute('download', item.name);
    anchor.rel = 'noopener noreferrer';
    panel.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    status.textContent = '첨부 파일을 다운로드했습니다. 브라우저에서 실행하지 말고 검토하세요.';
  }
  function show(draft) {
    detail.replaceChildren();
    detail.append(node('p', `${statuses[draft.status] || draft.status} · 출처: ${draft.source}`, 'send-draft-meta'));
    detail.append(node('h3', draft.subject || '제목 확인 필요'));
    detail.append(node('p', `수신자: ${draft.to.join(', ') || '확인 필요'}`));
    detail.append(node('p', `참조: ${draft.cc.join(', ') || '없음'}`));
    if (draft.original_message) {
      const original = node('p', `원본: ${draft.original_message.subject} `);
      try {
        const link = new URL(draft.original_message.webLink);
        if (link.protocol === 'https:') {
          const anchor = node('a', '원본 메일 열기');
          anchor.href = link.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
          original.append(anchor);
        }
      } catch { /* Missing source URL must not produce an unsafe link. */ }
      detail.append(original);
    }
    detail.append(node('pre', draft.body_text || '본문 확인 필요', 'send-draft-body'));
    showAttachments(detail, draft.attachments, draft.links, { downloadable: true });
    detail.append(node('p', `초안 ID: ${draft.draft_id}`, 'send-draft-meta'));
    if (draft.status === 'sent') detail.append(node('p', `발송 확인 시각: ${draft.sent_at} · Graph message id: ${draft.graph_message_id}`, 'send-draft-receipt'));
    if (draft.failure_reason) detail.append(node('p', `결과: ${draft.failure_reason}`, 'send-draft-warning'));
    if (draft.status === 'needs_clarification') detail.append(node('p', '수신자·제목·본문을 확인해 새 초안을 작성하세요. 이 초안은 발송할 수 없습니다.', 'send-draft-warning'));
    if (!sendEnabled) detail.append(node('p', '발송 기본 OFF · 검토와 취소만 가능합니다.', 'send-draft-warning'));
    const controls = node('div', '', 'send-review-controls');
    if (draft.status === 'needs_approval' || draft.status === 'approved') {
      const label = node('label', '');
      const confirmed = document.createElement('input');
      confirmed.type = 'checkbox'; confirmed.id = 'confirmSendDraft'; confirmed.disabled = !sendEnabled || busy;
      label.append(confirmed, document.createTextNode('수신인, 본문, 첨부파일/링크를 확인했습니다. 이 초안 한 건의 실제 발송을 승인합니다.'));
      detail.append(label);
      const approve = node('button', '검토한 초안 승인 후 발송');
      approve.id = 'approveSendDraft'; approve.type = 'button'; approve.disabled = true;
      confirmed.addEventListener('change', () => { approve.disabled = !confirmed.checked || !sendEnabled || busy; });
      approve.addEventListener('click', () => act(draft, 'approve', { payload_digest: draft.payload_digest, confirm: true }));
      controls.append(approve);
    }
    if (['needs_approval', 'needs_clarification', 'approved'].includes(draft.status)) {
      const cancel = node('button', '초안 취소'); cancel.type = 'button'; cancel.id = 'cancelSendDraft'; cancel.disabled = busy;
      cancel.addEventListener('click', () => act(draft, 'cancel', {})); controls.append(cancel);
    }
    detail.append(controls);
  }
  async function act(draft, action, payload) {
    if (busy) return;
    busy = true; show(draft);
    status.textContent = action === 'approve' ? '승인 요청 처리 중입니다. 중복 요청하지 마세요.' : '초안을 취소하는 중입니다.';
    try {
      const result = await request(`/${draft.draft_id}/${action}`, payload);
      selected = result.draft.draft_id;
      await refresh();
      status.textContent = statuses[result.draft.status] || result.draft.status;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      try { if (selected === draft.draft_id) show((await request('/' + selected)).draft); } catch { /* Keep the last review and visible error. */ }
    }
  }
  async function select(id) {
    if (busy) return;
    selected = id;
    detail.replaceChildren(node('p', '초안을 불러오는 중입니다.'));
    try {
      const result = await request('/' + id);
      if (selected !== id) return;
      sendEnabled = result.send_enabled;
      show(result.draft);
    } catch (error) { status.textContent = error.message; }
  }
  async function refresh() {
    const version = ++refreshVersion;
    try {
      const result = await request();
      if (version !== refreshVersion) return;
      sendEnabled = result.send_enabled;
      list.replaceChildren();
      for (const draft of result.drafts) {
        const button = node('button', `${statuses[draft.status] || draft.status} · ${draft.subject || '제목 없음'}`);
        button.type = 'button'; button.addEventListener('click', () => select(draft.draft_id)); list.append(button);
      }
      if (!result.drafts.length) list.append(node('p', '검토할 발송 초안이 없습니다.'));
      status.textContent = `${result.drafts.length}건 · ${sendEnabled ? '사람 승인 후에만 발송 가능' : '발송 OFF · 초안 저장 및 검토 가능'}`;
      if (selected && !busy) await select(selected);
    } catch (error) { status.textContent = error.message; }
  }
  form.addEventListener('input', () => { requestId = null; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || composeSaveBlocked(pending)) return;
    busy = true; if (saveButton) saveButton.disabled = true;
    requestId ||= crypto.randomUUID();
    const addresses = (id) => panel.querySelector(id).value.split(',').map((value) => value.trim()).filter(Boolean);
    try {
      const result = await request('', {
        request_id: requestId,
        to: addresses('#sendDraftTo'),
        cc: addresses('#sendDraftCc'),
        subject: panel.querySelector('#sendDraftSubject').value,
        body_text: panel.querySelector('#sendDraftBody').value,
        attachment_ids: pending.map((item) => item.id),
        drive_links: pendingLinks.map((item) => ({
          url: item.url,
          label: item.label,
          access_acknowledged: true,
        })),
      });
      selected = result.draft.draft_id; requestId = null; form.reset();
      pending.splice(0, pending.length);
      pendingLinks.splice(0, pendingLinks.length);
      if (driveComposer) driveComposer.hidden = true;
      syncCompose();
      panel.querySelector('.send-compose').open = false;
      await refresh(); show(result.draft);
      status.textContent = '검토용 초안을 저장했습니다. 아직 발송하지 않았습니다. 저장된 초안의 파일은 바꿀 수 없습니다.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; syncCompose(); if (selected) await select(selected); }
  });
  async function refreshDriveStatus() {
    try {
      const result = await request('', undefined, { url: '/api/mail/drive/status' });
      driveConnectionId = result.connections?.[0]?.id || '';
      pickerToken = '';
      if (driveConnectionId) {
        try {
          const token = await request('', { connection_id: driveConnectionId }, { url: '/api/mail/drive/picker-token' });
          pickerToken = token.access_token || '';
        } catch {
          pickerToken = '';
        }
      }
      if (driveConnectionStatus) {
        driveConnectionStatus.textContent = driveConnectionId
          ? `Google Drive가 이 메일함에 연결되었습니다.${pickerToken ? ' 선택 토큰은 메모리에만 있습니다.' : ''}`
          : 'Google Drive가 연결되어 있지 않습니다.';
      }
    } catch {
      driveConnectionId = '';
      if (driveConnectionStatus) driveConnectionStatus.textContent = 'Drive 연결을 사용할 수 없습니다.';
    }
  }
  async function importDriveFile() {
    if (!driveConnectionId || !driveFileId?.value) {
      if (live) live.textContent = 'Drive 연결 후 선택한 파일 ID가 필요합니다.';
      return;
    }
    if (pending.length >= 5) {
      if (live) live.textContent = '첨부는 최대 5개입니다.';
      return;
    }
    const item = {
      name: driveFileId.value,
      size: 0,
      state: 'uploading',
      id: '',
      error: '',
      origin: 'drive',
    };
    pending.push(item);
    syncCompose();
    try {
      await request('', {
        connection_id: driveConnectionId,
        file_id: driveFileId.value.trim(),
      }, { url: '/api/mail/drive/selection' });
      const imported = await request('', {
        request_id: crypto.randomUUID(),
        connection_id: driveConnectionId,
        file_id: driveFileId.value.trim(),
        export_mime: driveExportMime?.value || 'application/pdf',
      }, { url: '/api/mail/drive/import' });
      item.state = imported.state || 'ready';
      item.id = imported.id;
      item.name = imported.name;
      item.size = imported.size;
      requestId = null;
      if (driveFileComposer) driveFileComposer.hidden = true;
    } catch (error) {
      item.state = 'failed';
      item.error = error.message;
    }
    syncCompose();
  }
  panel.querySelector('#attachLocalFiles')?.addEventListener('click', () => fileInput?.click());
  panel.querySelector('#attachDriveFiles')?.addEventListener('click', async () => {
    if (!driveFileComposer) return;
    driveFileComposer.hidden = !driveFileComposer.hidden;
    if (!driveFileComposer.hidden) await refreshDriveStatus();
  });
  panel.querySelector('#connectGoogleDrive')?.addEventListener('click', async () => {
    try {
      const result = await request('', { return_path: '/#sendDraftReview' }, { url: '/api/mail/drive/connect' });
      pickerToken = '';
      if (result.authorization_url) window.location.assign(result.authorization_url);
    } catch (error) {
      if (live) live.textContent = error.message;
    }
  });
  panel.querySelector('#confirmDriveImport')?.addEventListener('click', () => importDriveFile());
  panel.querySelector('#attachDriveLink')?.addEventListener('click', () => {
    if (!driveComposer) return;
    driveComposer.hidden = !driveComposer.hidden;
  });
  panel.querySelector('#confirmDriveLink')?.addEventListener('click', () => {
    if (!driveAck?.checked) {
      if (live) live.textContent = '링크를 추가하려면 접근 권한 미확인 경고를 먼저 확인하세요.';
      return;
    }
    try {
      const parsed = parseDriveLink(driveUrl?.value || '');
      pendingLinks.push({
        url: parsed.url,
        label: (driveLabel?.value || '').trim() || parsed.file_id,
        access_acknowledged: true,
      });
      requestId = null;
      if (driveUrl) driveUrl.value = '';
      if (driveLabel) driveLabel.value = '';
      if (driveAck) driveAck.checked = false;
      if (driveComposer) driveComposer.hidden = true;
      syncCompose();
    } catch {
      if (live) live.textContent = errors.INVALID_DRIVE_LINK;
    }
  });
  fileInput?.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (pending.length + files.length > 5) {
      if (live) live.textContent = '첨부는 최대 5개입니다.';
      return;
    }
    for (const file of files) await uploadFile(file);
  });
  panel.querySelector('#refreshSendDrafts').addEventListener('click', refresh);
  syncCompose();
  refresh();
}
