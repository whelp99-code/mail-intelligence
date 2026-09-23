상태: 조사 단계 / 결정 아님 / 새 첨부 기능 실행·측정 미실시

# F8 대용량 첨부 — 기본 범위 밖

[문서] Microsoft Graph upload session은 3~150MB 첨부 경로이며 Mail.ReadWrite가 필요하다. 이는 현행 Mail.Send 기반 소형 발송과 다른 권한·상태 관리다. [공식 근거](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)

실행 전 소유자가 실제 필요한 크기, Mail.ReadWrite 확대, 서버 용량, 보존기간을 승인해야 한다. 제안 제품 상한은 25MiB이며 provider 상한을 제품 보장으로 표시하지 않는다. 2MiB 초과~3MB 미만 구간은 별도 direct-attachment 경로의 크기 정책을 검증해야 하므로 초기에는 거절한다.

기능 요구: 사람 승인 후 Outlook draft 생성 → immutable bytes로 upload session → 모든 bytes 업로드 확인 → 원자적 단일 send claim → send POST1회 → 첨부 hash 대사. 외부 draft 생성/업로드 상태와 실제 send claim은 별도 persistence를 갖는다. crash 후 외부 draft/session 조회로 상태를 복구하며 send 불확실을 업로드 재개와 혼동하지 않는다. 기존 소형 sendOnce 경로는 유지한다.

upload URL은 사전 인증 비밀 URL이므로 암호화·로그 제거, Microsoft 허용 host·HTTPS 검사, 임의 redirect 금지, 불필요한 Authorization header 추가 금지. 유효기간·진행 range를 저장한다. 세션 만료는 새 승인 정책을 정의한 뒤 처리하며 자동 재발송 금지. 버려진 Outlook 초안 삭제는 외부 mutation으로 별도 승인한다.

후속 카드 생성 조건: 권한 승인 증거와 실제 요구 크기가 확보되면 CREATE 별도 large-upload adapter/state migration/test 카드, MODIFY attachment transport selector만 지정하는 계획을 추가한다. 현재 Cursor 실행 범위에는 포함하지 않는다. 인수 기준은 중간 chunk 실패/재개, 만료, crash-before-send, response-lost-after-send, quota, 보낸/받은 hash 일치다. 미승인 시 본문·소형·링크 기능을 유지한다.
