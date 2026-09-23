상태: 조사 단계 / 결정 아님 / 새 첨부 기능 실행·측정 미실시

# 데이터·API·보안 계약

기존 초안 상태 머신과 v1 digest를 보존한다. 아래 새 이름은 구현 지시용 계약이며 현재 존재하는 API가 아니다.

## 저장소

Migration 006: `mail_attachment_assets`와 `mail_draft_attachments` 생성. 007: `mail_drive_connections` 생성. 실제 저장소에 번호가 이미 사용 중이면 다음 빈 번호를 선택하고 이 계획의 대응표를 수정한다. 기존 migration 수정 금지.

`mail_attachment_assets`: id UUID PK, mailbox_id, source(ui|grok-bot), request_id, display_name, mime_type, byte_length, sha256, ciphertext, nonce, auth_tag, key_version, state(staged|ready|rejected|expired), scan_engine, scan_version, scanned_at, origin(local|drive), drive_connection_id nullable, drive_file_id nullable, drive_resource_key encrypted nullable, drive_version nullable, drive_modified_time nullable, export_mime nullable, created_at, expires_at. UNIQUE(mailbox_id,source,request_id). bytes+quota 예약+상태 변경은 트랜잭션으로 반영한다. 스트림 수신과 검사 중에는 DB 트랜잭션을 열어두지 않는다.

`mail_draft_attachments`: draft_id, ordinal, asset_id, frozen_name, frozen_mime, frozen_size, frozen_sha256; PK(draft_id,ordinal), UNIQUE(draft_id,asset_id), 기존 초안 FK. 초안에 digest_version(default1)과 links_json(default[]) 추가. 암호화는 AES-256-GCM, 자산 ID·메일함·정책 버전을 AAD로 결합한다. 키는 DB 밖의 운영 비밀 저장소에서 공급하고 기존 OAuth 암호화 형식을 변경하지 않는다.

`mail_drive_connections`: id, mailbox_id, provider_subject, encrypted_refresh_token, scopes, created_at, revoked_at. ID 토큰을 사용할 경우 issuer/audience/signature/expiry/nonce 검증을 구현한다. Google 계정 식별을 위해 최소 OIDC identity scopes를 drive.file에 더해 명시한다. 이메일 문자열만으로 계정을 결합하지 않는다. access token·파일 bytes·resource key는 로그에서 제거한다.

## API 표

스키마 정합 보정: asset `source`는 기존 초안 enum과 동일한 `ui|grok-bot`을 사용한다(기존 초안과 동일한 enum). 사람→ui, 전용 bearer→grok-bot을 서버에서 결정하며 입력 source는 받지 않는다. 자산과 초안의 source는 정확히 같아야 한다. 자산에 `encryption_aad_version`, `encryption_policy_version`, `scan_policy_version` 필드를 추가한다. 암호화 시점의 앞 두 필드는 불변으로 저장해 과거 키/AAD 복호화와 복원을 보장한다. 검사 정책 버전은 엔진 `scan_version`과 분리한다. 현재 검사 정책과 다르면 동일 bytes를 재검사하고 PASS 이후 scan_policy_version만 갱신한다. 파일명·bytes·hash·암호화 AAD는 변경하지 않는다.

| 경로·메서드 | 입력 / 출력 | 권한 |
|---|---|---|
| POST /api/mail/attachment-assets | raw application/octet-stream; X-Upload-Request-Id(UUID), X-File-Name(base64url UTF-8), X-File-Type; 201 {id,name,mime,size,sha256,state}; 동일 요청200 | 사람 세션+CSRF+Origin 또는 전용 Grok bearer; mailbox는 서버 결정 |
| GET /api/mail/attachment-assets/:id/content | 200 binary, Content-Disposition attachment, nosniff, no-store | 사람만, 현재 메일함 소유권 검사 |
| POST /api/mail/attachment-assets/:id/discard | 미연결 자산만 논리 만료, 200 | 소유한 사람/동일 source bot, CSRF 적용 |
| POST /api/mail/send-drafts | 기존 필드 + attachment_ids[] + drive_links[] | 기존 권한 유지; 자신의 메일함·source 자산만 |
| GET /api/mail/send-drafts/:id | 기존 응답 + 공개 manifest·검사 상태·digest_version | 기존 접근 경계 유지, 비밀 메타데이터 제외 |
| POST /api/mail/drive/connect | {return_path:allowlisted}; {authorization_url} | 사람 세션+CSRF+Origin |
| GET /auth/google-drive/callback | code,state; 고정된 앱 화면으로 redirect | 일회성 state·세션·PKCE·만료 검증 |
| POST /api/mail/drive/picker-token | 연결 ID; 짧은 수명의 access token | 사람만, CSRF, no-store, 토큰 로그 금지 |
| POST /api/mail/drive/import | {request_id,connection_id,file_id,resource_key?,export_mime?}; 자산 결과 | 사람 또는 bot 자신의 메일함·연결; Google 파일 권한 추가 검사 |
| POST /api/mail/drive/disconnect | connection_id; 200 | 사람만; 토큰 삭제·연결 폐기, 기존 자산은 미발송 상태 유지 |

POST 상태 변경은 기존 bearer 우선 분류를 유지한다. bot+cookie 결합으로 사람 권한 승격 금지. 404로 타 메일함 ID 존재를 숨긴다. Drive connect/callback/picker-token/disconnect/selection API는 bot에 403이며 import만 명시적으로 허용한다. GET 리스트 전체 탐색 API를 bot에 추가하지 않는다.

007에 `mail_drive_file_grants(connection_id,mailbox_id,file_id,resource_key_encrypted,selected_at,revoked_at)`를 추가한다. PK(connection_id,file_id). 사람 전용 `POST /api/mail/drive/selection`은 CSRF/Origin 검증 후 Picker에서 선택한 file_id의 provider 접근을 확인하고 허용 기록을 저장한다. 연결·선택 기록을 다른 메일함에 재사용하지 않는다. import는 사람/bot 모두 미철회 선택 기록과 provider 접근을 함께 요구한다. 단순히 drive.file 토큰으로 접근 가능하다는 이유로 임의 ID를 허용하지 않는다. disconnect 시 grant도 철회한다. 선택 변경은 기존 파일을 자동 치환하지 않는다.

## 입력·자원 제한

JSON 한도 256KiB 유지. 별도 binary 스트림에서 Content-Length와 누적 bytes를 모두 검증한다. 2MiB+1 즉시 중단; aborted 요청의 예약 용량 반환. 파일명 NFC 정규화, 최대180 UTF-8 bytes, 경로·제어문자·CRLF 금지. MIME 헤더는 신뢰하지 않고 signature 검사와 확장자 allowlist를 함께 적용한다. ZIP 컨테이너 Office/HWPX는 엔트리 수1000, 총 비압축20MiB, 압축비100:1 이하, traversal·암호화·매크로·중첩 archive를 거절하고 파일시스템에 추출하지 않는다. HWP는 CFB 형식 검사와 암호화/스크립트 위험 판별기가 없으면 unsupported로 막는다. TXT/CSV는 UTF-8·NUL 없음. 최종 로컬 malware scanner PASS가 있어야 ready. 지원 선언보다 fail-closed를 우선한다.

동시 요청2·quota를 프로세스 메모리만으로 계산하지 않는다. SQLite 예약 레코드 또는 동등한 트랜잭션 제어를 추가한다. 검사 완료 후 원본과 hash를 다시 비교한다. scanner timeout/미설치는503이며 본문 전용 경로에 영향을 주지 않는다.

## Digest와 발송

첨부와 링크가 모두 비어 있으면 기존 v1 canonical JSON을 그대로 사용한다. 비어 있지 않으면 version2 canonical JSON: `{version:2,to,cc,subject,body_text,message_id,attachments:[{ordinal,id,name,mime,size,sha256,origin,drive_version,export_mime}],links:[{url,label,access_acknowledged}]}`. 키 순서는 여기 명시한 순서, 없는 nullable 값은 null, 배열 순서는 화면 순서. 서버가 모든 필드를 자산에서 구성하며 클라이언트 hash를 신뢰하지 않는다. 링크는 이스케이프한 텍스트 본문에 결정적으로 추가하며 최종 전송 본문 자체도 digest 대상이다.

승인 시: 권한·flag·CSRF → 원본/자산 ready 재검사 → 복호화·hash·스캐너 정책 버전 검증 → 최종 payload 직렬화 크기 확인(3.5MiB 이하) → 동일 digest 확인 → 기존 원자적 claim → **이미 검증한 동일 버퍼**로 sendOnce. 네트워크 검증 중 DB lock 유지 금지. claim 직전 상태를 다시 검사한다. POST send 재시도 금지. claim 이후 예외는 기존 불확실 상태 정책을 유지한다.

Graph `fileAttachment`의 name/contentType/contentBytes만 구성하며 inline 제외. 영수증은 기존 draft marker/body/recipient 대사에 더해 파일 개수·이름·크기·실제 bytes SHA-256 일치를 요구한다. 각 첨부 별도 bounded read(직렬화 한도3.5MiB), Graph pagination 전체 확인; 큰 응답을 기존 2MiB reader로 잘라서 성공 처리하지 않는다. attachment 목록에서 id를 받고 해당 bytes를 읽는다. 누락·추가·불일치·조회 실패는 sent 아님; 읽기 대사만 재실행 가능하다.

## Drive 전용 계약

Google Picker + drive.file, 제품 관리 OAuth client 사용. Codex/Aside 연결 토큰을 복사하지 않는다. redirect URI는 실제 운영 URL에 정확히 등록하고 기존 Outlook callback을 변경하지 않는다. state는 10분·일회성·세션/메일함 바인딩, PKCE S256. Picker access token은 짧은 수명으로 메모리에만 두고 localStorage 금지. CSP 허용 도메인 변경은 Picker에 필요한 공식 호스트만 검증 후 추가한다.

file_id/resource_key는 API 고정 origin으로만 전달한다. metadata에서 trashed, capabilities.canDownload, mimeType, size, version, modifiedTime을 검증하고 다운로드/내보내기 전후 같은 버전인지 확인한다. Drive 원본을 바꾸거나 permissions.create를 호출하지 않는다. Docs→PDF/DOCX, Sheets→PDF/XLSX, Slides→PDF/PPTX만 허용한다. 2MiB 초과 출력은 거절한다. Drive import request_id 재사용 시 connection/file/version/export 조합이 다르면409. 같은 요청은 처음 확정된 사본을 반환한다.

링크는 https://drive.google.com/file/d/{id}/view 및 https://docs.google.com/{document|spreadsheets|presentation}/d/{id}/...만 허용한다. userinfo·다른 port·임의 redirect URL 거절. 허용 resourcekey만 보존, 추적 query 제거. 서버는 링크 미리보기 fetch를 하지 않는다. 접근 경고를 확인해야 초안 저장 가능하며 공개 권한을 추정하지 않는다.

## 오류 코드

401 AUTH_REQUIRED; 403 FORBIDDEN/DRIVE_ACCESS_DENIED; 404 ASSET_NOT_FOUND; 409 REQUEST_CONFLICT/ASSET_CHANGED/DRIVE_SOURCE_CHANGED/DRAFT_IMMUTABLE; 413 ATTACHMENT_TOO_LARGE; 422 UNSUPPORTED_FILE/INVALID_DRIVE_LINK/EXPORT_UNSUPPORTED; 429 IMPORT_CONCURRENCY_LIMIT; 502 DRIVE_DOWNLOAD_FAILED; 503 ATTACHMENTS_DISABLED/SCANNER_UNAVAILABLE/DRIVE_RECHECK_UNAVAILABLE; 507 ATTACHMENT_QUOTA_EXCEEDED. 응답은 `{error:{code,message,request_id}}`; provider 원문이나 비밀값을 포함하지 않는다.
