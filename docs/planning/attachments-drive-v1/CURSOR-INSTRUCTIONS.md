상태: 조사 단계 / 결정 아님 / 새 첨부 기능 실행·측정 미실시

# Cursor 전달용 지시서

개정: 2026-09-10. 실행 기준 호스트는 `jm-cloud`, 원본 소스는 `/home/jm/orca/projects/mail-intelligence`다. 이 디렉터리의 계획서를 사용한다. Mac 작업 사본을 개발 기준으로 선택하지 않는다.

## 서버에서 시작할 첫 작업

TASK: PR001 SUB001-A — 서버 원본에서 격리 개발 환경을 만들고 소형 첨부 자산 저장·업로드를 구현하라.

SCOPE: 먼저 원본 폴더의 AGENTS.md, git HEAD/status, git worktree list, 서비스 실행 경로를 읽기 전용으로 확인하라. 원본은 운영 서비스가 사용하는 가능성이 있으므로 그 자리에서 코드·DB를 수정하거나 서비스를 재시작하지 마라. 기존 운영 인계 문서를 삭제하지 마라.

현재 원본 HEAD에서 새 `codex/mail-attachments-drive-v1` 브랜치의 격리 worktree를 생성하라. 권장 경로는 `/home/jm/orca/projects/mail-intelligence-attachments-dev`다. 브랜치나 경로가 이미 있으면 HEAD·dirty 상태·소유 작업을 확인하고 덮어쓰지 마라. 다른 작업이면 사용하지 않은 suffix로 새 경로를 선택하여 보고하라. 계획서는 미커밋 파일이므로 worktree에 자동 포함되지 않는다. 원본의 `docs/planning/attachments-drive-v1/`만 새 worktree의 같은 상대 경로에 복사하고 SHA-256으로 비교하라. 운영 `.env`, DB, 토큰, 실제 첨부파일은 복사하지 마라.

개발 서버는 loopback의 사용하지 않는 포트와 격리된 테스트 저장소를 사용하라. 운영 포트3010·운영 DB·서비스 설정은 수정하지 마라. 개발 환경 MAIL_SEND/MAIL_ATTACHMENTS/MAIL_DRIVE flag는 OFF로 시작하며 합성 테스트에서만 주입 설정으로 활성화하라.

이름 충돌 시 경로뿐 아니라 브랜치에도 같은 미사용 suffix를 붙인다. 예: `codex/mail-attachments-drive-v1-02`와 `/home/jm/orca/projects/mail-intelligence-attachments-dev-02`. 기존 브랜치를 강제로 이동하거나 다른 worktree에서 분리하지 않는다.

DELIVERABLE: 실제 원본 HEAD, 격리 작업 경로·브랜치, 변경 파일과 diff, 검증 출력·exit, 실제 코드에 맞춰 조정한 지점을 보고하라. VERIFY: PR001 카드의 신규 테스트를 먼저 생성한 뒤 카드의 node test 명령과 lint를 실행하여 exit0·실패0을 확인하라. 기존 회귀 실패를 신규 기능 완료로 덮지 마라.

아래 본문과 이 디렉터리 전체를 Cursor에 제공한다. 문서만 첨부하지 않고 소스 저장소를 함께 열어야 한다. 이 문서를 작성한 Codex는 구현·배포를 실행하지 않았다.

## 복사할 작업 요청

Mail Intelligence의 PC 파일 첨부, Drive 공유 링크, Google Drive 선택 파일 첨부, Google 문서 변환, Grok 초안 연계를 개발하라. 이 계획의 F1~F7만 대상으로 하고 F8 대용량은 제외하라. 먼저 로컬 합성 구현과 검증을 완료하라. 운영 OAuth/설치/배포/실메일/삭제/commit/push는 별도 요청 없으면 수행하지 마라.

현재 작업 저장소의 AGENTS.md를 먼저 읽고 실제 HEAD와 dirty 파일을 확인하라. 기준 SHA MI 4bd87f1, Gateway 2e2627f는 조사 당시 기준이므로 최신으로 강제 reset하지 마라. 충돌하지 않는 사용자 변경은 보존하라. 한 작업에서는 한 저장소만 수정하라.

계획 디렉터리의 00→01→02→03→04→05→06과 현재 prs 카드를 순서대로 읽어라. 기존 `docs/planning/00-PROJECT-DEFINITION.md`, `01-REQUIREMENTS.md`, `02-DATA-AND-ARCHITECTURE.md`, `03-DEVELOPMENT-PLAN.md`, `04-TEST-AND-RELEASE-GATES.md`도 읽어 기존 안전 계약을 유지하라. 파일이 없거나 구조가 다르면 실제 경로와 차이를 보고하고 기존 계획을 덮어쓰지 마라.

첫 작업은 PR001의 SUB001-A다. 새 테스트를 먼저 만들고 기존 migration/crypto/HTTP 등록 구조에 맞춰 자산 저장·업로드를 구현하라. 이어 B/C/D를 순서대로 진행하고 카드의 VERIFY를 실행하라. 다음 PR002~006은 선행 카드 통과 후 진행하라. Gateway PR005는 별도 작업으로 그 저장소를 열고 MI API 계약을 소비하게 하라.

2MiB/최대5개 등 기본값은 개발 제안이므로 구현 상수·설정·테스트에서 명시하되 운영 활성화 전에 소유자 확인을 받아라. 파일 원문은 AI provider에 전송하지 마라. 테스트는 합성 파일·mock provider·격리 DB를 사용하라. scanner 미구성은 첨부 차단으로 처리하고 가짜 PASS를 운영에 사용하지 마라.

첨부와 링크를 승인 digest에 결합하고, 저장된 초안의 파일을 바꾸면 새 초안·승인을 요구하라. Graph202를 발송 완료로 표현하지 말고 보낸 첨부 bytes를 대사하라. 불확실 발송 재시도 금지. Google drive.file 범위를 전체 Drive 권한으로 확대하지 말고 공유 권한을 변경하지 마라.

카드마다 변경 파일, 요구사항 ID, 실행 명령·exit·테스트 수, UI 검증, 남은 게이트를 보고하라. 실패가 있으면 해당 경계에서 수정·재검증하고 테스트를 삭제하거나 skip으로 완료 처리하지 마라. 예산을 넘는 카드는 명시적 SUB로 분리하라. 질문이 필요한 경우 소스에서 해결할 수 없는 사용자 결정/권한만 질문하라.

최종 보고는 F1~F7별 CODE/SYNTHETIC/UI/DEPLOY/SEND/RECEIVE 상태를 분리하고 실행하지 않은 단계는 NOT_RUN으로 남겨라. 운영 승인 대기만 남으면 안전한 로컬 작업을 완료한 상태와 승인 요청을 보고하라.

## 작업 경로

Mac MI: `/Users/jmpark/Documents/Codex/2026-09-04/files-pasted-by-the-user-chatgpt2codex/mail-send-implementation`

Ubuntu MI 원본: `/home/jm/orca/projects/mail-intelligence`. 계획서는 이 원본의 `docs/planning/attachments-drive-v1/`에 배치하는 전달본이다. 시작 시 존재와 최신 HEAD를 직접 확인한다.

Mac Gateway: `/Users/jmpark/Documents/Codex/2026-09-04/files-pasted-by-the-user-chatgpt2codex/grok-gateway-source/integrations/grok-bot-action-hub`

Ubuntu Gateway 원본: `/home/jm/orca/projects/jmai-os-pack/integrations/grok-bot-action-hub`. PR005에서는 해당 경로의 실제 git 루트를 확인한 후 별도의 격리 worktree를 만들고 이 하위 프로젝트만 변경한다. MI 작업을 Gateway 작업과 한 diff에 섞지 않는다.

이번 동기화 범위는 계획 디렉터리와 배포용 ZIP뿐이다. 소스·토큰·DB·첨부 원문은 포함하지 않는다. 문서 배치가 구현·배포 승인 또는 구현 완료를 뜻하지 않는다.
