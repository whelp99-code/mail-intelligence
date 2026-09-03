# ChatGPT Work 전달 지시서 — Mail Intelligence v1.2.1

- 프로젝트 ID: `mail-intelligence`
- 프로젝트 경로: `/home/jm/orca/projects/mail-intelligence`
- 기준 브랜치: `main`
- 현재 제품 버전: `1.2.1`
- 구현 릴리스 Commit: `7946344`
- Worker name: `mailintelligence`
- 운영 서버: Ubuntu `jm-acloud`
- 내부 서비스: `127.0.0.1:3010`
- Tailnet 전용 접속: `http://<tailscale-ip>:3010`
- 작성 목적: ChatGPT Work가 기존 방향을 바꾸지 않고 운영, 검증, 실사용 파일럿과 다음 개발을 이어받기 위한 실행 지시서

---

## 1. 가장 먼저 실행할 지시

ChatGPT Work는 추측이나 이전 채팅 요약만으로 작업하지 말고, 반드시 Ubuntu 저장소를 직접 읽은 뒤 시작한다.

```text
1. Chatgpt2codex-Ubuntu를 사용한다.
2. projectId=mail-intelligence, preset=full-write, workerName=mailintelligence로 프로젝트를 선택한다.
3. AGENTS.md, README.md, package.json, docs/planning/V1.2.0-PRECISION-CLASSIFICATION-PLAN.md, docs/planning/V1.2.1-OAUTH-LLM-PROVIDERS.md를 읽는다.
4. git status, git log -1, git remote -v, systemd 서비스 상태를 확인한다.
5. 변경 전 npm run verify:v1.2.1을 실행한다.
6. 실패가 있으면 신규 기능을 추가하지 말고 먼저 기준선을 복구한다.
7. 작업 후 동일 검증, 실서비스 검증, git diff --check를 다시 통과시킨다.
```

저장소가 제품과 운영 계약의 Source of Truth다. 문서와 코드가 충돌하면 임의로 결정하지 말고 코드, 테스트, 릴리스 문서를 함께 대조해 가장 최근 검증된 계약을 확정한다.

---

## 2. 제품 정의

Mail Intelligence는 Outlook 대체 메일 앱, 단순 요약기, 자동 답장 봇이 아니다.

> 전체 업무 메일을 지속적으로 수집·정규화하고, 현재 업무 상태·다음 행동 주체·프로젝트·기한·근거를 정밀하게 판단하여 SQLite에 누적하며, 사용자 보정을 우선 적용해 이후 검색과 판단을 개선하는 읽기 전용 업무 인텔리전스 시스템이다.

고정 루프:

```text
INGEST -> NORMALIZE -> LINK -> EXTRACT -> RECONCILE -> STORE
       -> PRESENT -> CORRECT/APPROVE -> LEARN -> RE-EVALUATE
```

이 방향은 바꾸지 않는다. 새 기능은 이 루프에 추가되어야 하며 별도의 자동화 제품이나 범용 CRM으로 변질시키지 않는다.

---

## 3. v1.2.0의 고정 분류 계약

메일마다 다음 핵심값만 정식 판단으로 유지한다.

```text
현재 업무 상태 1개
다음 행동 주체 1개
주 프로젝트 최대 1개 또는 미분류
우선순위와 기한
원문 근거
필드별 신뢰도와 검토 사유
```

### 현재 업무 상태

```text
action_required
waiting
decision_required
completed
reference
review_required
```

### 다음 행동 주체

```text
me
internal_team
external_party
shared
none
unknown
```

### 핵심 원칙

- 분류 개수를 계속 늘리지 않는다.
- 애매하면 `review_required`, `unknown`, `unassigned`로 보류한다.
- 프로젝트는 사용자가 명시적으로 등록한 것만 확정한다.
- 회사명, 제품명, 제목의 괄호만으로 프로젝트를 자동 생성하지 않는다.
- 과거 인용문과 서명은 현재 상태 판단에서 분리한다.
- 사용자 보정은 자동 판단보다 높은 권한을 가진다.
- 동일한 분류는 중복 이벤트를 생성하지 않는다.

Canonical 구현:

```text
src/application/precision-intelligence.js
src/domain/precision-classifier.js
src/domain/intelligent-search.js
src/storage/sqlite-store.js
migrations/004_precision_classification.sql
```

이와 별도로 두 번째 분류 엔진, 두 번째 분류 테이블, 유사한 중복 API를 만들지 않는다.

---

## 4. Canonical API

### 읽기 API

```text
GET /api/health
GET /api/session
GET /api/outlook/status
GET /api/storage/status
GET /api/outlook/sync/status
GET /api/outlook/messages?top=25
GET /api/outlook/analyze?top=25
GET /api/mail/search?q=...
GET /api/intelligence/summary
GET /api/intelligence/smart-views
GET /api/intelligence/projects
GET /api/intelligence/classification?messageId=...
GET /api/intelligence/search?q=...&limit=25
```

### 내부 SQLite만 변경하는 보호 API

```text
POST /api/outlook/config
DELETE /api/outlook/config
POST /api/outlook/feedback
POST /api/outlook/sync
POST /api/storage/backup
POST /api/intelligence/classify
POST /api/intelligence/projects
POST /api/intelligence/correct
```

상태 변경 API는 세션, Origin, CSRF, `X-Mail-Intelligence-Request` 검사를 유지한다.

### 계속 차단해야 하는 외부 행동

```text
POST /api/outlook/send
POST /api/outlook/read
POST /api/hooks/data-plane
POST /api/fixtures/ingest-mail
```

이 경로는 명시적 새 버전 계획과 사용자 승인 없이 활성화하지 않는다.

---

## 5. 절대 변경 금지 안전선

```text
Microsoft Graph delegated scope:
openid profile offline_access User.Read Mail.Read
```

다음 권한과 행동은 금지한다.

```text
Mail.Send
Mail.ReadWrite
메일 자동 발송·답장·전달
읽음 상태 변경
메일 이동·삭제
플래그·카테고리 변경
CRM·Calendar·Data Plane 쓰기
0.0.0.0 애플리케이션 바인딩
공인 인터넷 공개
Secret, Access Key, OAuth Token 출력·커밋
```

운영 환경변수는 다음 값을 유지한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

외부 AI를 사용하려면 별도 데이터 정책 동의와 사용자의 명시적 승인이 있어야 한다.

---

## 6. 데이터와 보존 계약

Authoritative storage:

```text
data/mail-intelligence.sqlite
```

현재 Schema:

```text
v4
```

권한:

```text
data/                  0700
SQLite·환경·접근키      0600
backups/               0700
```

복원은 웹 API로 만들지 않는다. 서비스를 중지한 뒤 운영자 CLI로만 수행한다.

```bash
npm run memory:status
npm run memory:integrity
npm run memory:backup
node scripts/mail-memory-admin.mjs restore <backup.sqlite> --confirm-stopped
```

Runtime 데이터, 접근키, OAuth 비밀, SQLite, 백업은 Git에 포함하지 않는다.

---

## 7. 운영 서비스

### 메인 서비스

```text
서비스: mail-intelligence.service
바인딩: 127.0.0.1:3010
역할: 실제 애플리케이션
```

### Tailnet 포트 서비스

```text
서비스: mail-intelligence-tailnet.service
바인딩: 현재 Tailscale IPv4의 3010 포트
대상: 127.0.0.1:3010
허용 원본: 100.64.0.0/10
역할: Tailnet 구성원만 접근 가능한 TCP 프록시
```

Node 애플리케이션은 계속 loopback에만 바인딩한다. Tailnet 프록시가 정확한 Tailscale IP 하나에만 바인딩하고, 접속 원본도 Tailscale CGNAT 범위로 제한한다.

활성화:

```bash
cd /home/jm/orca/projects/mail-intelligence
npm run tailnet:activate
npm run verify:tailnet
```

상태 확인:

```bash
npm run tailnet:status
ss -ltnp | grep 3010
curl -fsS http://$(tailscale ip -4 | head -n1):3010/api/health
```

접속 주소는 실행 시 확인한다.

```bash
printf 'http://%s:3010\n' "$(tailscale ip -4 | head -n1)"
```

이 포트는 Tailnet 전용이다. 공인 IP NAT, Tailscale Funnel, `0.0.0.0`, 인터넷 공개 방화벽 규칙을 추가하지 않는다.

중지·롤백:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemctl --user disable --now mail-intelligence-tailnet.service
```

### OAuth 주의

Microsoft Entra는 비-localhost HTTP Redirect URI를 일반적으로 운영 Redirect URI로 사용하지 않도록 구성한다. 최초 Outlook OAuth 연결은 기존 SSH 터널과 아래 loopback Redirect URI를 사용한다.

```text
http://127.0.0.1:3010/auth/callback
```

OAuth 설정이 완료된 뒤 일상 조회와 정밀 탐색은 Tailnet 주소에서 사용할 수 있다.

---

## 8. 설치·재배포 절차

```bash
cd /home/jm/orca/projects/mail-intelligence
bash scripts/deploy-user-service.sh
bash scripts/activate-tailnet-proxy.sh
```

배포 후 반드시 실행한다.

```bash
npm run verify:v1.2.1
MAIL_INTELLIGENCE_BASE_URL=http://127.0.0.1:3010 node scripts/verify-live-deployment.mjs
node scripts/verify-live-restart.mjs
npm run verify:tailnet
git diff --check
```

서비스 로그에 Access Key, Authorization, Cookie, OAuth Token, Client Secret, Gemini Key가 출력되지 않는지 확인한다.

---

## 9. Git 작업 규칙

작업 시작:

```bash
git status --short
git log -1 --oneline
git fetch origin
git rev-list --left-right --count origin/main...HEAD
```

커밋 전:

```bash
npm run verify:v1.2.1
git diff --check
git status --short
```

Runtime 파일과 비밀이 staged 되지 않았는지 확인한다.

```bash
git diff --cached --name-only
git diff --cached | grep -Ei 'access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization:'
```

검증 실패 상태에서 커밋하거나 푸시하지 않는다. 사용자 요청 없이 force push, history rewrite, reset --hard, clean -fd를 실행하지 않는다.

---

## 10. ChatGPT Work가 우선 수행할 다음 업무

### 1순위 — 실제 Outlook read-only 파일럿

필요 조건:

```text
Microsoft Entra Client ID
정확한 Redirect URI
사용자 delegated OAuth 승인
실제 Outlook 메일함
```

파일럿에서 측정할 것:

```text
전체 폴더 탐색 성공률
초기 Delta 수집량과 시간
두 번째 Delta 중복률
신규·이동·삭제 tombstone 정합성
현재 상태 정확도
다음 행동 주체 정확도
프로젝트 연결 정확도
중요 업무 누락률
참고 메일 오분류율
review_required 비율
사용자 보정 재시작 유지
```

실제 메일을 변경하는 테스트는 하지 않는다.

### 2순위 — 평가 데이터셋 축적

사용자 보정 사례를 익명화·정규화해 평가 fixture 후보로 축적한다. 자동으로 정답 데이터에 편입하지 말고 사용자가 승인한 사례만 평가셋으로 승격한다.

### 3순위 — 지속 학습 설계

다음 버전에서 사용자 보정과 결과 관찰을 학습 신호로 사용하되, 모델이 자동으로 업무·프로젝트를 생성하거나 외부 행동을 실행하지 않도록 한다.

---

## 11. 금지되는 잘못된 개선 방식

```text
상태 enum을 계속 추가
회사명마다 프로젝트 생성
제품명마다 업무 생성
메일 한 통에서 여러 현재 상태 생성
AI가 원문 근거 없이 기한·담당자 확정
유사 프로젝트 중 하나를 임의 선택
사용자 보정을 다음 재분석에서 덮어쓰기
SQLite와 별도 JSON을 동시에 authoritative storage로 사용
기존 precision 엔진과 유사한 두 번째 엔진 추가
실제 Outlook을 변경하는 E2E 테스트
```

새로운 분류가 필요해 보여도 먼저 기존 `상태 + 행동 주체 + 우선순위 + 신호 + 프로젝트 + 기한` 조합으로 표현할 수 있는지 검토한다.

---

## 12. 완료 기준

작업 완료를 선언하려면 모두 충족해야 한다.

```text
[ ] 계획·요구사항과 구현 추적 가능
[ ] npm run verify:v1.2.1 PASS
[ ] 전체 node:test PASS
[ ] precision evaluation PASS
[ ] ESLint·HTMLHint·Stylelint PASS
[ ] Health·Safety·npm audit PASS
[ ] SQLite quick_check·foreign_key_check PASS
[ ] 메인 서비스 active
[ ] Tailnet 프록시 active
[ ] 127.0.0.1:3010과 Tailscale-IP:3010 리스너 확인
[ ] Tailnet 미인증 접속 401
[ ] Tailnet 인증 접속 200
[ ] 정밀 요약·스마트 뷰 API 200
[ ] 메일 발송 API 403
[ ] 재시작 후 DB·보정·프로젝트·백업 유지
[ ] 비밀·Runtime 파일 미커밋
[ ] commit 및 origin/main push 성공
```

실제 OAuth 자격정보가 없으면 `실제 Outlook 파일럿 NOT RUN`으로 명확히 기록한다. 엔지니어링 검증 성공을 실제 메일 정확도 검증 성공으로 과장하지 않는다.

---

## 13. 최종 보고 형식

ChatGPT Work는 작업 종료 시 다음 순서로 보고한다.

```text
1. 수행 범위
2. 변경 파일과 핵심 구현
3. 자동 테스트 결과
4. 실서비스 검증 결과
5. 안전 경계 확인
6. Commit SHA와 Push 상태
7. 현재 접속 주소
8. NOT RUN 또는 남은 실제 파일럿 항목
9. 다음 한 단계
```

보고에는 Access Key, Cookie, Token, Client Secret, API Key를 절대 포함하지 않는다.

---

## 14. v1.2.1 OAuth LLM Provider 추가 계약

현재 지원 Provider는 다음 세 개뿐이다.

```text
rules
openai-codex-oauth
xai-grok-oauth
```

`f-aios-v3`, `lmstudio`, `gemini`를 다시 UI·설정·실행 경로에 넣지 않는다.

인증 원칙:

```text
Codex CLI owns ChatGPT OAuth credentials
Grok CLI owns xAI OAuth credentials
Mail Intelligence stores no LLM OAuth token
```

확인 명령:

```bash
npm run oauth:status
npm run oauth:instructions
```

운영 게이트는 공식 CLI가 OAuth 인증된 경우에만 다음으로 활성화한다.

```bash
npm run oauth:enable -- openai-codex-oauth
npm run oauth:enable -- xai-grok-oauth
```

외부 AI 게이트가 켜져도 UI에서 해당 Provider를 선택하고 메일 데이터 외부 전송 정책에 동의하기 전에는 메일 본문을 전송하지 않는다.

분석 실행은 반드시 빈 임시 디렉터리, 읽기 전용 또는 도구 비활성, 사용자·프로젝트 지침 무시, 무승인, 제한된 출력·시간, JSON Schema, 원문 Evidence 검증을 유지한다. 실패 시 다른 OAuth Provider가 아니라 Rules로만 내려간다.

ChatGPT Work는 OAuth credential 파일을 직접 열거나 복사하거나 출력하지 않는다. 브라우저 Cookie·ChatGPT 웹 세션·Grok 웹 세션을 재사용하는 코드도 만들지 않는다.
