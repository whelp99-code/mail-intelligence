# Mail Intelligence

Mail Intelligence는 **Outlook 전체 메일을 지속적으로 분석해 프로젝트·업무·사람·회사·결정·일정·자료별로 연결**하고, 그 결과를 누적하여 시간이 지날수록 더 정확한 업무 지식을 제공하는 메일 기반 업무 인텔리전스 시스템입니다.

```text
전체 메일 수집
→ 스레드·사람·첨부 메타데이터 정규화
→ 프로젝트·업무 신호 추출
→ 근거와 신뢰도 기록
→ 사용자 보정
→ Persistent Mail Memory에 누적
→ 관련 과거 정보 재평가
→ 더 정확한 검색·판단·추천
→ 승인된 행동만 실행
```

## 현재 버전

**Version: 1.2.2 — Operational Classification Stabilization**

v1.2.2는 v1.2.1의 **authoritative SQLite**, 정밀 분류, 지능형 탐색, 공식 CLI OAuth Provider와 읽기 전용 안전 기준을 유지하면서, 의미 사건·상태 머신과 `DO_NOW / WAITING / REVIEW / ARCHIVE` 운영 Lane을 추가한 버전입니다. 확실한 업무는 빠르게 배치하고, 불확실하거나 충돌하는 메일은 Silent Action Miss 방지 Gate를 통해 자동 보관하지 않습니다.

MailMaestro 메일에서 확인된 Improve, Thread Summary, Rapid Reply, Auto Label, Meeting Intent, AI Personality, Email/Attachment Summary는 발송·캘린더·CRM 쓰기 없이 로컬 요약·초안·검토 기능으로만 반영합니다. 공개 API, Gmail 지원, 가격 숫자는 근거가 없으므로 제품 기능으로 주장하지 않습니다.

기존 핵심 원칙인 **세분화가 아니라 정밀화**는 그대로 유지합니다.

```text
Rules
OpenAI · ChatGPT OAuth — official Codex CLI
xAI · Grok OAuth — official Grok CLI
```

Mail Intelligence는 OAuth Access Token이나 Refresh Token을 읽거나 복사해 자체 DB에 저장하지 않습니다. 각 공식 CLI가 사용자 전용 credential cache를 소유하고 갱신하며, Mail Intelligence는 로그인 상태와 분석 결과만 제한된 subprocess 계약으로 사용합니다.

메일 데이터가 외부 LLM으로 전송되려면 다음 두 조건이 모두 필요합니다.

```text
운영자의 MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=1 승인
+ UI의 명시적 메일 데이터 정책 동의
```

분석은 빈 임시 디렉터리, 도구 비활성, 읽기 전용 sandbox, 무승인 모드, 시간·출력 크기 제한, JSON Schema 및 원문 근거 검증으로 수행됩니다. Provider 실패는 숨기지 않으며 다른 Provider로 조용히 폴백하지 않고 Rules 판단으로만 내려갑니다.

| 기능 | v1.2.2 상태 |
|---|---|
| Outlook 폴더 탐색 | 지원 |
| Graph 페이지네이션 | 지원 |
| 폴더별 Delta 동기화 | 지원 |
| 중단 후 `nextLink` 재개 | 지원 |
| 이동·삭제 tombstone 반영 | 지원 |
| 스레드·사람·수신자 정규화 | 지원 |
| 첨부파일 메타데이터 저장 | 지원, 파일 본문은 미수집 |
| SQLite 영속 저장 | authoritative |
| FTS5 전체 메일 검색 | 지원 |
| 사용자 분류 보정 | SQLite에 영속 저장 |
| AI 분석 캐시 | OAuth Provider·모델·Prompt 버전별 영속 저장 |
| 정밀 업무 상태 | 6개 상호배타 상태 지원 |
| 운영 업무 Lane | `DO_NOW`, `WAITING`, `REVIEW`, `ARCHIVE` |
| Silent Action Miss 방지 | 위험·충돌·낮은 신뢰도 메일의 자동 Archive 차단 |
| 다음 행동 주체 | 내 차례·내부 팀·외부·공동·없음·불명 |
| 프로젝트 연결 | 사용자가 등록한 프로젝트만 확정 연결 |
| 프로젝트 후보 | 후보로만 보관, 자동 생성 없음 |
| 지능형 탐색 | 자연어 업무 질의 + 구조화 필터 + FTS 근거 검색 |
| 정밀 분류 보정 | 자동 판단보다 우선하며 변경 이력 보존 |
| Thread·메일 요약 | currentContent 기반 한 줄·상세 요약 |
| 회신·Improve 초안 | 복사 전용, 자동 발송 없음 |
| Meeting Intent | 후보 시간·확인 초안, Calendar 쓰기 없음 |
| AI Personality | 로컬 bounded 설정, 초안에만 적용 |
| Attachment Summary | PDF/DOCX/TXT의 승인된 추출 텍스트 또는 metadata-only |
| Garbage 방지 | 낮은 신뢰도 보류·중복 프로젝트 차단·변경 시에만 이벤트 기록 |
| OpenAI OAuth | 공식 Codex CLI의 ChatGPT OAuth credential cache 사용 |
| xAI OAuth | 공식 Grok CLI의 OAuth credential cache 사용; CLI 설치·로그인은 별도 필요 |
| OAuth 토큰 자체 저장 | 하지 않음 |
| Provider 간 자동 폴백 | 하지 않음; Rules만 안전 폴백 |
| 작업 이력·Dead Letter | 지원 |
| 검증 백업·오프라인 복원 | 지원 |
| 메일 발송·원본 변경 | 비활성화 |
| CRM·Calendar·Data Plane 쓰기 | 비활성화 |


## v1.2.0 정밀 분류 원칙

v1.2.0은 분류 항목을 늘리는 대신 다음 여섯 가지를 정확하게 판단합니다.

```text
현재 업무 상태 1개
다음 행동 주체 1개
주 프로젝트 후보 최대 1개 또는 UNASSIGNED
기한과 우선순위
원문 근거
필드별 신뢰도와 검토 사유
```

현재 업무 상태:

```text
ACTION_REQUIRED
WAITING
DECISION_REQUIRED
COMPLETED
REFERENCE
REVIEW_REQUIRED
```

다음 행동 주체:

```text
ME
INTERNAL_TEAM
EXTERNAL_PARTY
SHARED
NONE
UNKNOWN
```

금액·견적·계약·첨부·일정·승인·장애·보안은 여러 개가 동시에 존재할 수 있는 보조 신호입니다. 보조 신호만으로 프로젝트나 업무를 자동 생성하지 않습니다. 모호한 요청, 충돌하는 기한, 비슷한 프로젝트 후보는 억지로 확정하지 않고 `REVIEW_REQUIRED` 또는 `UNASSIGNED`로 보류합니다.

지능형 탐색 API:

```text
GET /api/intelligence/search?q=검색어&limit=25
GET /api/intelligence/smart-views
```

자연어 질의는 상태·다음 행동 주체·기한·프로젝트 조건으로 구조화한 뒤 SQLite FTS와 결합합니다. 저장된 스마트 뷰는 오늘의 행동, 외부 회신 대기, 검토 필요 등을 제공합니다.

```text
오늘 내가 처리할 견적
고객 회신 대기
기한이 지난 보안 장애
프로젝트: 선진엔지니어링 HCI 구축
```

사용자 보정 API:

```text
POST /api/intelligence/correct
```

모든 보정은 세션·Origin·CSRF 보호를 통과해야 하며 Outlook 원본을 변경하지 않습니다.

## 고정 운영 원칙

1. 기본은 읽기 전용입니다.
2. 메일을 조회하거나 분석하는 것만으로 Outlook 원본 상태를 변경하지 않습니다.
3. Outlook이 메일 원본이며, SQLite는 Mail Intelligence의 정규화·분석·업무 기억 원본입니다.
4. AI는 관찰과 제안만 하며 외부 행동 권한을 갖지 않습니다.
5. 중요한 판단에는 원문 근거, 신뢰도, 분석 방식과 실패 상태가 따라야 합니다.
6. 사용자 보정은 AI 추론보다 높은 권한을 갖습니다.
7. 레거시 JSON은 한 번만 이관하고 원본 파일을 자동 삭제하지 않습니다.
8. 외부 행동은 향후 `Proposal → Approval → Execution → Receipt`를 통과해야 합니다.

## 읽기 전용 안전 경계

### Microsoft Graph 권한

대화형 OAuth는 다음 읽기 권한만 요청합니다.

```text
openid profile offline_access User.Read Mail.Read
```

`Mail.Send`와 `Mail.ReadWrite`는 요청하지 않습니다. 환경변수로 쓰기 기능을 요청해도 v1.2.2 안전 정책이 기본적으로 차단합니다.

### 로컬 전용 서버

기본 주소:

```text
http://127.0.0.1:3010
```

허용되는 Listen Host는 `127.0.0.1`, `localhost`, `::1`뿐입니다. 상태 변경 API는 로컬 세션, Origin, CSRF 또는 보호 헤더 검사를 통과해야 합니다.

### Tailnet 전용 포트

운영 서버에서는 Node 애플리케이션의 loopback 바인딩을 유지하면서 별도 사용자 systemd 프록시가 현재 Tailscale IPv4의 `3010/tcp`만 연다.

```text
Tailscale peer
→ Tailscale IPv4:3010
→ source allowlist 100.64.0.0/10
→ 127.0.0.1:3010
```

활성화와 검증:

```bash
npm run tailnet:activate
npm run verify:tailnet
```

현재 주소 확인:

```bash
printf 'http://%s:3010\n' "$(tailscale ip -4 | head -n1)"
```

이 경로는 Tailnet 내부 전용이며 Tailscale Funnel, 공인 IP NAT, `0.0.0.0` 바인딩을 사용하지 않습니다. 최초 Microsoft OAuth 연결은 기존 SSH 터널과 `http://127.0.0.1:3010/auth/callback`을 사용합니다.

### Secret 처리

다음 값은 응답·로그·Git에 노출하지 않습니다.

- Outlook Access Token
- OAuth Refresh Token
- Microsoft Client Secret

접근키 기반 운영에서는 AES-256-GCM 암호화 파일을 사용할 수 있습니다. 공개 설정과 메일 DB는 별도로 관리합니다.

## 설치와 실행

요구사항:

- Ubuntu
- Node.js 22 이상
- npm
- 선택 사항: Microsoft Entra App Registration
- 선택 사항: OpenAI Codex CLI 또는 xAI Grok CLI

```bash
cd /home/jm/orca/projects/mail-intelligence
npm ci
npm run verify:v1.2.2
npm start
```

다른 포트:

```bash
PORT=3011 npm start
```

## Persistent Mail Memory

기본 저장 경로:

```text
data/
├── mail-intelligence.sqlite
├── .outlook-config.json
├── .outlook-secrets.enc.json     선택 사항
├── .mail-intelligence.key        선택 사항
└── backups/
```

권한:

```text
data/                         0700
SQLite·설정·Secret 파일       0600
backups/                      0700
```

SQLite에는 다음 정보가 저장됩니다.

```text
Mailbox / MailFolder / Message / Thread
Person / Recipient / Attachment metadata
Sync run / page checkpoint / Delta cursor / tombstone
User feedback / feedback event
AI analysis / evidence / observation
Operator job / Dead Letter / Outbox foundation
Backup manifest / audit event
```

벡터 검색은 아직 authoritative fact store가 아닙니다. 현재 검색 기준은 구조화 SQLite와 FTS5입니다.

## 동기화

동기화 흐름:

```text
루트 폴더 페이지 수집
→ 하위 폴더 재귀 탐색
→ 폴더별 Graph Delta 호출
→ 페이지 단위 SQLite transaction
→ nextLink 저장
→ 마지막 페이지에서 deltaLink 확정
→ 삭제·이동 tombstone 반영
```

서버가 중단되면 마지막으로 저장된 `nextLink`에서 재개합니다. Delta cursor가 만료되어 Graph가 410을 반환하면 해당 폴더 커서를 초기화하고 안전한 초기 동기화를 다시 수행합니다.

일시적인 Graph 오류는 제한적으로 재시도합니다. 반복 실패와 폴더별 부분 실패는 `operator_jobs`와 `dead_letter_events`에 기록됩니다.

## 레거시 JSON 이관

과거 `.mail-cache.json`이 있으면 시작 시 digest를 기준으로 SQLite에 한 번만 이관합니다.

- 메일·보정·분석 캐시를 이관합니다.
- 같은 원본은 다시 이관하지 않습니다.
- 원본 JSON은 자동 삭제하지 않습니다.
- 잘못된 JSON은 서버 시작을 중단하고 원본을 보존합니다.

수동 이관:

```bash
node scripts/mail-memory-admin.mjs import-legacy /absolute/path/.mail-cache.json
```

## 지능형 탐색

화면의 `지능형 탐색`은 자연어 업무 표현을 구조화된 필터로 해석한 뒤 SQLite FTS5 원문 근거 검색과 결합합니다.

예:

```text
오늘 내가 처리할 견적
고객 회신 대기
결정 필요
프로젝트:"선진 HCI 구축" 정책표 승인
```

해석 가능한 조건:

```text
현재 업무 상태
다음 행동 주체
우선순위
기한 범위
확정 프로젝트·별칭
승인·견적/계약·첨부·장애/보안 등의 보조 신호
```

API:

```text
GET /api/intelligence/search?q=검색어&limit=25
GET /api/intelligence/smart-views
```

결과에는 분류값뿐 아니라 `matchedBecause`가 포함되어 왜 검색되었는지 설명합니다. 검색과 유사도는 프로젝트나 업무를 자동 생성하거나 확정하지 않습니다.

## 백업과 복원

### 상태와 무결성

```bash
npm run memory:status
npm run memory:integrity
```

### 검증 백업

```bash
npm run memory:backup
```

또는:

```bash
node scripts/mail-memory-admin.mjs backup /absolute/path/backup.sqlite
```

백업 절차는 `VACUUM INTO`, SQLite quick check, foreign-key check, SHA-256, schema version, record counts를 검증하고 `backup_manifests`에 기록합니다.

### 복원

복원은 실행 중인 HTTP API에서 제공하지 않습니다. 서버를 먼저 정지한 뒤 오프라인 CLI로만 수행합니다.

```bash
node scripts/mail-memory-admin.mjs restore /absolute/path/backup.sqlite --confirm-stopped
```

복원 전 기존 DB는 `restore-rollbacks/`에 원자적으로 보존됩니다. Source, temporary copy, final live DB가 모두 무결성 검사를 통과해야 복원이 완료됩니다.

상세 절차는 `docs/runbooks/PERSISTENT-MAIL-MEMORY.md`를 따릅니다.

## Outlook 연결

### 권장 방식: Delegated OAuth

1. Microsoft Entra에서 App Registration을 만듭니다.
2. Redirect URI를 등록합니다.

```text
http://127.0.0.1:3010/auth/callback
```

3. Delegated permission에 `User.Read`, `Mail.Read`만 허용합니다.
4. UI에서 Client ID와 Tenant를 설정합니다.
5. `Outlook으로 로그인`을 눌러 읽기 권한만 승인합니다.

실제 Microsoft OAuth 연결과 실제 회사 Outlook 메일함 검증은 별도의 통제된 read-only pilot에서 수행해야 합니다. 자동 테스트는 실제 운영 메일을 사용하지 않습니다.

## AI 분석

지원 Provider:

```text
rules                 기본값, 외부 모델 호출 없음
openai-codex-oauth    공식 Codex CLI + ChatGPT OAuth
xai-grok-oauth        공식 Grok CLI + xAI OAuth
```

OAuth 로그인:

```bash
codex login --device-auth
grok login --device-auth
npm run oauth:status
```

운영 서비스에서 OAuth LLM 게이트를 명시적으로 여는 명령:

```bash
npm run oauth:enable -- openai-codex-oauth
# 또는
npm run oauth:enable -- xai-grok-oauth
```

이 명령은 해당 CLI가 설치되고 OAuth 인증된 경우에만 `MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=1`을 설정합니다. UI의 Provider 선택과 메일 데이터 정책 동의는 여전히 별도로 필요합니다. 메일 발송·읽음 변경·Data Plane 쓰기 권한은 열리지 않습니다.

AI 응답은 JSON Schema, Message ID, 상태, 신뢰도, 액션 수, 원문 근거를 검증한 뒤에만 저장됩니다. Codex는 빈 임시 디렉터리·read-only sandbox·도구 이벤트 거부로, Grok은 빈 임시 디렉터리·모든 작업 도구 금지·단일 turn으로 실행됩니다. 메일 원문에 없는 근거와 허용되지 않은 도구 실행 액션은 거부됩니다.

OAuth 운영 API:

```text
GET  /api/ai/oauth/status
GET  /api/ai/oauth/instructions?provider=...
POST /api/ai/oauth/test
```

`/api/ai/oauth/test`는 실제 메일이 아닌 고정 합성 문장만 사용합니다.

## 주요 API

### 읽기·운영 상태

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/api/health` | 공개 최소 Health와 SQLite 준비 상태 |
| `GET` | `/api/session` | 로컬 세션·CSRF 발급 |
| `GET` | `/api/storage/status` | DB 무결성·건수·작업·경고·백업 상태 |
| `GET` | `/api/outlook/sync/status` | 폴더별 Delta·재개 상태 |
| `GET` | `/api/outlook/messages?top=25` | Delta 동기화 후 최근 저장 메일 |
| `GET` | `/api/outlook/analyze?top=25` | 저장 메일 분석 |
| `GET` | `/api/intelligence/summary` | 정밀 상태·행동 주체·우선순위·프로젝트 연결 요약 |
| `GET` | `/api/intelligence/smart-views` | 오늘의 행동·외부 대기·검토 필요 등 저장된 업무 뷰 |
| `GET` | `/api/intelligence/projects` | 사용자가 등록한 확정 프로젝트 목록 |
| `GET` | `/api/intelligence/classification?messageId=...` | 현재 정밀 분류·보정·변경 이력 |
| `GET` | `/api/intelligence/search?q=...` | 구조화 필터와 SQLite FTS를 결합한 지능형 탐색 |

### 허용된 로컬 관리 작업

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/outlook/config` | 설정 저장 |
| `DELETE` | `/api/outlook/config` | 설정 초기화 |
| `POST` | `/api/outlook/feedback` | 사용자 보정 저장 |
| `POST` | `/api/outlook/sync` | 읽기 전용 Delta 동기화 |
| `POST` | `/api/storage/backup` | 검증된 로컬 SQLite 백업 |
| `POST` | `/api/intelligence/classify` | 저장 메일 정밀 분류 또는 재평가 |
| `POST` | `/api/intelligence/projects` | 확정 프로젝트를 명시적으로 등록 |
| `POST` | `/api/intelligence/correct` | 상태·행동 주체·우선순위·프로젝트·기한 보정 |

### 차단된 외부 행동

| Method | Path | 결과 |
|---|---|---|
| `POST` | `/api/outlook/send` | `403 EXTERNAL_ACTION_DISABLED` |
| `POST` | `/api/outlook/read` | `403 EXTERNAL_ACTION_DISABLED` |
| `POST` | `/api/hooks/data-plane` | `403 EXTERNAL_ACTION_DISABLED` |
| `POST` | `/api/fixtures/ingest-mail` | `403 EXTERNAL_ACTION_DISABLED` |

복원 API는 존재하지 않습니다.

## 검증

전체 엔지니어링 게이트:

```bash
npm run verify:v1.2.2
```

포함 항목:

```text
문법 검사
전체 node:test
ESLint
HTMLHint
Stylelint
격리 서버 Health
읽기 전용 안전 계약
저장소 위생 검사
전체 npm dependency audit
20개 골든 fixture·77개 필드 assertion 정밀 분류 평가
```

주요 테스트 범위:

- Migration v1→v2→v3→v4
- 레거시 JSON 1회 이관과 원본 보존
- 전체 폴더 탐색과 페이지네이션
- Delta nextLink·deltaLink
- 중단 후 재개
- 커서 만료 복구
- 삭제 tombstone
- idempotent upsert
- 한글 FTS5
- 사용자 보정·AI 캐시 재시작 영속성
- 최소 충분 분류: 상태 1개·행동 주체 1개·프로젝트 최대 1개
- 애매한 표현의 `REVIEW_REQUIRED` 보류
- 프로젝트 명시 등록·별칭 중복 차단·자동 생성 금지
- 정밀 분류 fingerprint idempotency와 변경 이벤트
- 사용자 정밀 보정의 재분류·재시작 우선권
- 한국어 자연어 질의와 구조화 조건·FTS 결합 탐색
- 검색 결과 일치 이유와 삭제 메일 제외
- 20개 골든 fixture·77개 필드 assertion 기반 정밀 분류 평가
- 작업 이력·재시도·Dead Letter
- 검증 백업·원자적 복원·rollback
- Prompt injection·원문 근거 검증
- 세션·Host·Origin·CSRF·Secret 경계
- 외부 변경 기능 차단

## 구조

```text
mail-intelligence/
├── server.mjs
├── migrations/
├── src/
│   ├── adapters/
│   ├── application/
│   ├── domain/
│   ├── storage/
│   ├── security/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── scripts/
│   ├── mail-memory-admin.mjs
│   ├── verify-health.mjs
│   └── verify-safety-contract.mjs
├── test/
├── docs/planning/
├── docs/releases/
├── docs/runbooks/
├── AGENTS.md
└── package.json
```

## 로드맵

| Version | 목표 |
|---|---|
| `1.0.1` | 안전성과 분석 정합성 복구 — 완료 |
| `1.1.0` | SQLite 기반 전체 메일 Persistent Memory — 완료 |
| `1.2.0` | 최소 충분 정밀 분류·명시적 프로젝트 연결·지능형 탐색 |
| `1.2.1` | 공식 Codex/Grok CLI OAuth Provider·credential isolation·합성 연결 테스트 |
| `1.2.2` | 의미 사건·운영 Lane·Archive Guard·메일 보조 도구 — 현재 |
| `1.3.0` | 실제 사용자 보정·결과 데이터 기반 지속 학습과 영향 범위 재평가 |
| `1.4.0` | 오늘의 업무함·프로젝트 인텔리전스·근거 기반 질의응답 |
| `1.5.0` | 외부 시스템 읽기 연결·운영 준비 |
| `2.0.0` | 승인·실행·영수증 기반 외부 행동 |

## 현재 운영 판정

v1.2.2는 엔지니어링 검증 대상이며, 최종 Production GO는 신규 독립 Blind·검색 relevance·Correction 지속성·31회 안정성 검증과 별도입니다. 정밀 분류는 프로젝트·업무를 자동 생성하지 않으며, 실제 보정 데이터가 충분히 축적되기 전에는 “지속 학습 완료”로 표현하지 않습니다.

다음 항목은 실제 증거가 확보되기 전까지 완료로 간주하지 않습니다.

- 실제 Microsoft OAuth 연결
- 실제 회사 Outlook의 전체 폴더·대용량 페이지 수집
- 실환경 Delta 변경·삭제·이동
- Microsoft throttling과 토큰 만료
- 실제 xAI Grok CLI 설치·OAuth 로그인
- 실제 Codex/Grok OAuth 메일 분석 품질·비용·지연 평가
- 장시간 운영·용량 추세·백업 보존 정책
- 실제 사용자 평가 데이터셋

이 파일럿 전에도 메일 발송이나 다른 업무 시스템 쓰기 기능은 활성화하지 않습니다.

## v1.2.2 사건·운영 Lane 기반 분류

현재 운영 분류기는 `precision-classification-v1.2.2-fix9`이며, `mail-event-frame-v3`에서 현재 본문의 Support lifecycle, 자동 알림 종류, 서비스 위험, 발신/수신 방향, 요청·완료·대기 사건을 먼저 추출합니다. Canonical 상태를 결정한 뒤 `operational-classification-v1.2.2`가 `DO_NOW`, `WAITING`, `REVIEW`, `ARCHIVE`로 투영하고, 위험 신호가 있는 메일의 자동 Archive를 차단합니다.

조건부 문의 Footer, 법적 Disclaimer, 마케팅 수신거부, tracking asset은 상태·Priority Evidence에서 제외한다. 외부 행동과 외부 AI는 운영 안전선에서 기본 비활성화 상태를 유지한다.

검증:

```bash
npm run verify:v1.2.2
npm run verify:qa:known-acceptance
npm run verify:qa:operational
npm run verify:qa:search
```

최종 Production GO는 `docs/qa/ASIDE-V1.2.2-FINAL-INDEPENDENT-RELEASE-QA-INSTRUCTIONS.md`에 따라 Aside가 신규 Blind를 독립 라벨링·동결·채점한 뒤 결정합니다.
