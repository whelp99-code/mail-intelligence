상태: 조사 단계 / 결정 아님 / 새 첨부 기능 실행·측정 미실시

# 조사 근거·기준선·외부 문서

## CONFIRMED — 2026-09-09 이번 계획 작성 중 확인

MI 로컬 조사본: `/Users/jmpark/Documents/Codex/2026-09-04/files-pasted-by-the-user-chatgpt2codex/mail-send-implementation`, HEAD `4bd87f1`, branch main. 기존 미추적 `.agent-handoff/`, `docs/planning/MAIL-SEND-DEPLOYMENT-20260909.md`는 본 계획의 변경 대상이 아니다.

Cursor 운영 정본: `/home/jm/orca/projects/mail-intelligence`. Gateway 정본: `/home/jm/orca/projects/jmai-os-pack/integrations/grok-bot-action-hub`. 이번 Gateway 조사본은 MI 로컬 조사본의 형제 `grok-gateway-source/integrations/grok-bot-action-hub`, HEAD `2e2627f`, 변경 없음. 원격 운영 상태는 이번 계획 작성에서 재조회하지 않았으므로 현재 배포 SHA로 단정하지 않는다.

| 읽은 파일·심볼 | 확인 내용 | 계획 영향 |
|---|---|---|
| `server.mjs` `MAX_JSON_BODY_BYTES`, `readJsonBody` | JSON 256 KiB 제한 | 전역 한도 확대 대신 별도 binary upload route |
| `src/application/mail-send-drafts.js` `create/approve/claim/recordOutcome` | input whitelist, immutable payload digest, DB claim, attachment 없음 | v1 digest 보존, v2 추가, 파일 검증은 claim 전 수행 |
| `src/application/mail-send-api.js` `createMailSendApi` | bearer bot 분리, session+CSRF+Origin, approve/cancel bot403 | 새 자산 API도 동일 권한 경계; 쿠키 혼합으로 우회 불가 |
| `src/adapters/microsoft-graph-send.js` `sendOnce/reconcile` | 본문 JSON sendMail, 202 후 고유 header로 Sent Items 대조 | fileAttachment bytes, 발송 첨부 hash 대조 추가 |
| `src/send-review.js` `initializeSendReview` | to/cc/subject/body/form, 명시 확인 checkbox | 파일 목록과 변환·링크·원본 버전 검토 추가 |
| `src/storage/backup-restore.js` | SQLite backup/restore, SHA·FK 검증 | BLOB까지 단일 DB snapshot에 포함하고 키 복구 별도 확인 |
| `migrations/005_mail_send_drafts.sql` | schema5, immutable draft·events | 신규 migration006/007 계획, 기존 migration 수정 금지 |
| `scripts/recover-attachment-metadata.mjs` | 수신 메일 첨부 메타데이터용 별도 도구 존재 | 발송 자산과 혼용·재사용 금지 |
| Gateway `server/gateway.py` | 본문64 KiB, draft/get만, MI 별도 토큰 | binary route 분리, JSON 크기 유지 |
| Gateway `grok-skill/scripts/action_hub.py` | mail-draft/text/message-id/status | 반복 `--attach-file`, `--drive-file-id`, `--drive-link` 추가 계획 |
| `package.json` | Node>=22, npm scripts 존재 | TypeScript/프레임워크 교체 없이 Node+기존 UI 유지 |

## 실제 실행한 기준선

MI 조사본에서 `node --test test/mail-send-drafts.test.js test/mail-send-api.test.js test/mail-send-http.test.js test/microsoft-graph-send.test.js` → exit0, 26 tests/pass26/fail0/skip0. 임시 서버·합성 fixture 검사이며 이번에 실메일 발송하지 않았다.

Gateway 조사본에서 `python3 -m unittest discover -s tests -v` → exit0, 16 tests PASS. 로그 `/tmp/mail-attachment-plan-gateway-baseline.log`. 기존 SQLite ResourceWarning이 있을 수 있으며 새 파일 기능 결과가 아니다.

`npm run verify:v1.2.2`, `npm run lint`, `npm run validate:html`, `npm run validate:css`, `npm run verify:backup:isolated`는 package.json에 존재함을 확인했다. 이번 계획 작성은 좁은 발송 경계만 실행했다. 전체 릴리스 게이트를 이번에 재실행했다고 주장하지 않는다. Cursor는 구현 착수 전 전체 기준선을 실행하고 실패 시 원인을 기록한다.

## DOCUMENTED — 공식 자료 확인, 새 연동 미실행

1. [Microsoft sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0): JSON 호출에 fileAttachment를 포함할 수 있고 Mail.Send를 사용한다. 202 응답만으로 완료를 확정하지 않는다.
2. [Microsoft large attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments): 큰 파일 upload session은 별도 경로이고 메일에는 Mail.ReadWrite가 필요하다. 이것을 소형 첨부에 자동 추가하지 않는다.
3. [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth): drive.file은 사용자가 선택한 파일 접근을 제공하지만 파일 쓰기 능력도 포함한다. drive.readonly는 전체 파일 읽기 범위다. 이름만 보고 둘 다 최소 읽기 권한이라고 표현하지 않는다.
4. [Google download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads): binary는 files.get alt=media, Workspace 문서는 files.export, canDownload 사전 확인, export에는 10 MB 제한이 있다. 제품의 2 MiB 한도는 더 작다.

위 문서는 API 근거이며 성능·운영 성공 증거가 아니다. Cursor는 구현일에 동일 공식 문서의 계약과 오류·scope를 재확인한다. 코드 예제를 고객 파일로 실행하지 않는다.

## UNKNOWN — 필요한 시점에 확인

- Google Cloud 프로젝트·OAuth client·Picker API 설정·HTTPS/localhost 등록 origin·사용자 동의 상태.
- 연결할 Drive 계정, Shared Drive·DLP 정책, export 포맷 지원 여부, 수신자 접근 권한.
- 운영 악성코드 검사기 설치·엔진/정의 최신성, 첨부 보존기간 정책, DB 실용 크기·성능.
- Cursor 측 현재 저장소·dirty diff·추가 migration 번호·테스트 수. 4bd87f1보다 새 코드면 차이를 분석한다.

## 알려진 조정 지점

| 가정 | 확인 방법 | 허용 조정 |
|---|---|---|
| 마지막 migration005 | `ls migrations`, schema_migrations 읽기 | 다음 빈 순번 사용, 테스트의 정확한 version 기대값 갱신 |
| factory 주입 방식 유지 | `createMailSendApi` 읽기 | 기존 의존 주입에 새 resolver 추가; 세션·CSRF 의미 변경 금지 |
| JSON 256 KiB | `MAX_JSON_BODY_BYTES` 읽기 | binary 전용 수신만 도입; global limit 변화 금지 |
| Graph read size2 MiB | adapter의 request reader 확인 | 첨부 전용 bounded bytes reader; 모든 Graph 응답 한도 확대 금지 |
| Gateway stdlib HTTP | gateway.py·CLI 읽기 | route allowlist 확장; 범용 proxy로 교체 금지 |
| 기존 AGENTS baseline은 구형 서술 포함 | package·HEAD·tests 확인 | 오래된 버전 서술을 현재 측정값으로 오인하지 않는다 |

위 지점에서 실제 코드가 계획과 다르면 질문하지 말고 실제 코드에 맞춰 조정하고, 조정 내용을 결과 보고에 포함하라. 보안 권한·제품 범위·크기 한도를 바꾸는 조정은 자율 허용 범위가 아니다.
