상태: 조사 단계 / 결정 아님 / 새 첨부 기능 실행·측정 미실시

# 순차 개발과 파일 소유권

의존성: PR001 → PR002 → PR003 → PR004 → PR005 → PR006. PR005만 Gateway 저장소다. 번호는 개발 묶음이며 PR 생성/push 권한을 뜻하지 않는다. 각 카드에 있는 파일만 수정한다. 현재 파일명이 다르면 읽기 검색으로 실제 파일을 확인하고 변경 매핑을 보고한 후 동일 책임 범위에서 적용한다. 다른 기능 리팩터링 금지.

각 카드 완료 후 diff, 테스트 명령/exit/count, 검증하지 않은 항목을 보고한다. 새 테스트 파일은 카드에서 생성한 뒤 실행한다. 기본 SUB 예산은 수정12개/신규8개/논리 변경500줄/마이그레이션1개 이내다. 초과하면 남은 범위를 하위 카드로 분리하고 계약은 바꾸지 않는다. 예상 시간은 개발자·도구 환경에 따라 달라 이 문서에서 보장하지 않는다.

| 카드 | 기능·요구사항 | 단계·중단 조건 |
|---|---|---|
| [PR001](prs/PR-001.md) | F1/F2, R01~08 | 자산→digest→발송→UI 순서. text-only 회귀 실패 시 다음 단계 금지 |
| [PR002](prs/PR-002.md) | F7, R02~04/R16~17 | 검사→quota→보존→복원. scanner 없는 실제 첨부 금지 |
| [PR003](prs/PR-003.md) | F3, R09 | parser→본문 고정→경고 UI. 권한 변경 API 추가 금지 |
| [PR004](prs/PR-004.md) | F4/F5, R10~14 | OAuth→adapter→사본→Picker. live OAuth 별도 승인 |
| [PR005](prs/PR-005.md) | F6, R15 | MI 계약 고정 후 CLI 소비자. MI/Gateway 동시 수정 금지 |
| [PR006](prs/PR-006.md) | F7, R17~18 | 합성통합→브라우저→운영인계. 실메일은 별도 승인 |

공통 금지: 기존 migration 변경, 기존 v1 canonical 직렬화 변경, JSON 한도 일괄 확대, send POST retry 추가, 자동 권한 부여, 외부 AI 파일 전송, source/generated/vendor 대량 정리, 운영 DB 테스트, 실제 메일 fixture 커밋.

환경 키 제안: `MAIL_ATTACHMENTS_ENABLED=false`, `MAIL_DRIVE_ENABLED=false`, `MAIL_ATTACHMENT_KEY`(secret), `MAIL_ATTACHMENT_SCANNER_COMMAND`(운영 관리자가 고정한 실행 파일), `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`(secret), `GOOGLE_DRIVE_REDIRECT_URI`. shell 문자열 실행 금지; scanner는 shell:false 및 고정 argv로 실행한다. 키 누락은 해당 기능만 fail-closed. 기존 MAIL_SEND flag와 별개이며 승인 시 둘 다 확인한다.
