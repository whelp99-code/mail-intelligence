# 윤비서 / Grok Bot Mail Intelligence 운영 계약

이 문서는 jm-acloud에서 SSH/`curl`로 Mail Intelligence를 읽을 때 쓰는 **기계용 서비스 토큰** 계약이다. 사람 UI 세션(Access Key 쿠키)과 섞지 않는다.

기본 전제:

- 서비스는 `127.0.0.1:3010`만 듣는다. Tailnet 18788을 공개하지 않는다.
- `MAIL_INTELLIGENCE_ALLOW_SEND` 기본값은 `0`이다.
- Grok 토큰은 **검색·읽기·첨부 조회/다운로드·발송 초안 생성**만 한다.
- 승인·실제 Outlook 발송은 사람 세션만 할 수 있다.
- Graph 영수증이 확인되기 전에는 "보냈습니다"라고 말하지 않는다.

## 토큰

파일 권한은 `0600`으로 둔다. 토큰 값을 채팅·커밋·로그에 넣지 않는다.

```text
MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN_FILE
MAIL_INTELLIGENCE_GROK_SERVICE_TOKEN_FILE   # 선택. 없으면 draft 토큰이 읽기+초안 생성
```

헤더 (둘 중 하나):

```text
Authorization: Bearer <token>
X-Mail-Intelligence-Service-Token: <token>
```

사람 UI Access Key를 Bearer로 쓰지 않는다. Access Key는 Basic + `mi_session` 쿠키 전용이다.

## 허용 API

로컬 기준 URL: `http://127.0.0.1:3010`

| 용도 | 방법 | 경로 |
|---|---|---|
| 키워드 검색 | GET | `/api/mail/search?q=...&limit=25` |
| 지능형 검색 | GET | `/api/intelligence/search?q=...&limit=25` |
| 메일 본문 | GET | `/api/mail/messages/{messageId}` |
| 메일 요약 | GET | `/api/intelligence/message-summary?messageId=...` |
| 스레드 요약 | GET | `/api/intelligence/thread-summary?messageId=...` |
| Lane 목록 | GET | `/api/mail/lanes?lane=do_now\|waiting\|review&limit=25` |
| Lane 집계 | GET | `/api/intelligence/operational-summary` |
| 첨부 메타데이터 | GET | `/api/mail/attachments?messageId=...` |
| 첨부 다운로드 | GET | `/api/mail/attachments/{attachmentId}/content?messageId=...` |
| 초안 생성 | POST | `/api/mail/send-drafts` |
| 초안 상태 | GET | `/api/mail/send-drafts/{id}` |

첨부 다운로드는 허용 형식(PDF/Office/이미지/텍스트, 10MB 이하)만 된다. `?save=1`이면 `data/operator-downloads/`에 저장하고 상대 경로만 반환한다.

## 금지

Grok 토큰으로 아래를 호출하면 `HUMAN_APPROVAL_REQUIRED` 또는 세션 거부가 나야 한다.

- `POST /api/mail/send-drafts/{id}/approve`
- `POST /api/mail/send-drafts/{id}/cancel`
- `POST /api/outlook/send`
- 읽음/이동/삭제/동기화/설정 변경/백업

`MAIL_INTELLIGENCE_GROK_SERVICE_TOKEN`만 있으면 초안 생성도 `DRAFT_SCOPE_REQUIRED`로 거부된다.

## jm-acloud curl 예

```bash
TOKEN="$(sudo -u jm tr -d '\n' < /home/jm/orca/projects/mail-intelligence/data/.mail-intelligence-grok-draft-token)"
BASE=http://127.0.0.1:3010

curl -sS "$BASE/api/mail/search?q=%EC%84%A0%EC%A7%84&limit=10" \
  -H "Authorization: Bearer $TOKEN"

curl -sS "$BASE/api/mail/lanes?lane=do_now&limit=10" \
  -H "Authorization: Bearer $TOKEN"

curl -sS "$BASE/api/mail/messages/AAMkA..." \
  -H "Authorization: Bearer $TOKEN"

curl -sS "$BASE/api/mail/attachments?messageId=AAMkA..." \
  -H "Authorization: Bearer $TOKEN"

curl -sS -o /tmp/quote.pdf \
  "$BASE/api/mail/attachments/ATT123/content?messageId=AAMkA..." \
  -H "Authorization: Bearer $TOKEN"

curl -sS -X POST "$BASE/api/mail/send-drafts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":["person@example.com"],"subject":"초안","body":"사람 승인 후 발송","notes":"윤비서 초안","attachmentRefs":[{"messageId":"AAMkA...","attachmentId":"ATT123"}]}'
```

초안 응답의 `status`는 `needs_approval`이어야 한다. `source`는 `grok-bot`이다.

사람 승인(윤비서가 하지 않음):

```bash
# UI Access Key로 세션을 만든 뒤, ALLOW_SEND=1 인 운영에서만
curl -sS -X POST "$BASE/api/mail/send-drafts/123/approve" \
  -H "Cookie: mi_session=..." \
  -H "X-Mail-Intelligence-Request: 1" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## "보냈습니다" 판정

다음이 **모두** 참일 때만 발송 완료로 말한다.

1. `GET /api/mail/send-drafts/{id}` 의 `status`가 `sent`
2. `receipt.adapter`가 `microsoft-graph`
3. `receipt.httpStatus`가 `202` 또는 성공
4. `receipt.submittedAt`이 비어 있지 않음

`needs_approval`, `failed`, `cancelled`, 네트워크 오류, `EXTERNAL_ACTION_DISABLED`는 미발송이다. `ALLOW_SEND=0`이면 사람 승인도 차단되며 이것이 기본 운영이다.

## 첨부 후속

이번 슬라이스는 메타데이터 + 허용 바이트 다운로드 + 초안의 `attachmentRefs`/`notes`다. Graph 첨부 재사용이 승인 시점에 해결되면 같이 보내고, 실패하면 초안은 `failed`로 남는다. OneDrive/Drive 파이프라인은 `docs/planning/attachments-drive-v1/README.md` 후속이다.
