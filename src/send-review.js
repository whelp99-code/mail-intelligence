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
};

export function initializeSendReview(apiFetch) {
  const panel = document.querySelector('#sendDraftReview');
  if (!panel) return;
  const list = panel.querySelector('#sendDraftList');
  const detail = panel.querySelector('#sendDraftDetail');
  const status = panel.querySelector('#sendDraftStatus');
  const form = panel.querySelector('#sendDraftForm');
  let selected = null;
  let sendEnabled = false;
  let busy = false;
  let requestId = null;
  let refreshVersion = 0;

  function node(tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  async function request(path = '', body) {
    const response = await apiFetch('/api/mail/send-drafts' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(errors[result.code] || `요청을 완료하지 못했습니다 (${result.code || response.status}). 발송 상태를 다시 확인하세요.`);
    return result;
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
      label.append(confirmed, document.createTextNode('수신자·제목·본문을 읽었으며, 이 초안 한 건의 실제 발송을 승인합니다.'));
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
    event.preventDefault(); if (busy) return;
    busy = true; panel.querySelector('#saveSendDraft').disabled = true;
    requestId ||= crypto.randomUUID();
    const addresses = (id) => panel.querySelector(id).value.split(',').map((value) => value.trim()).filter(Boolean);
    try {
      const result = await request('', { request_id: requestId, to: addresses('#sendDraftTo'), cc: addresses('#sendDraftCc'),
        subject: panel.querySelector('#sendDraftSubject').value, body_text: panel.querySelector('#sendDraftBody').value });
      selected = result.draft.draft_id; requestId = null; form.reset();
      panel.querySelector('.send-compose').open = false;
      await refresh(); show(result.draft);
      status.textContent = '검토용 초안을 저장했습니다. 아직 발송하지 않았습니다.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; panel.querySelector('#saveSendDraft').disabled = false; if (selected) await select(selected); }
  });
  panel.querySelector('#refreshSendDrafts').addEventListener('click', refresh);
  refresh();
}
