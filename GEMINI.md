<!-- github-development-management:v1:start -->
## GitHub 기반 개발 작업 관리 (사용자 지정 기본 흐름)
개발·수정·개선·고도화 요청을 받으면 `~/ops/github-development-management/WORKFLOW.md`를 읽고 자동 적용한다. 이 섹션은 같은 작업을 Linear/별도 보드에 중복 관리하라는 기존 안내보다 우선한다. 모델·권한·전문 검증 지침은 바꾸지 않는다.
- 실제 remote/registry로 대상 확인 → 기존 Issue/PR 검색·재사용(없을 때만 생성) → 목표·범위·인수 조건 기록 → 통합 Project 연결 → 구현·검증 → 근거 기록 → GitHub 재조회.
- 해당 작업의 Issue/Project 등록·상태·검증 댓글 갱신은 사용자 상시 승인 범위다. commit/push/PR/merge/deploy/삭제/권한 변경은 별도 기존 승인 범위를 따른다. 원격이 미확정이면 임의 저장소에 쓰지 않는다.
- 시작/종료 보고에 Issue URL을 남긴다. 등록 실패는 로컬 pending으로 보존하고 미등록이라고 밝힌다. 단순 질문·번역·읽기 전용 조사에는 생성하지 않는다.
- 상태 Backlog → In Progress → Verify → Done. 실제 인수 근거 없이 Done 처리하지 않는다. 코드 존재·테스트·배포·실사용을 구분한다. HANDOFF draft/사람 ready 규칙을 유지한다.
- 상세 원본: `~/ops/github-development-management/WORKFLOW.md`; 연결표: `~/ops/github-development-management/registry.json`; 도구: `python3 ~/ops/github-development-management/manage.py`.
<!-- github-development-management:v1:end -->
