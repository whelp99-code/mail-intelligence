# Mail Intelligence

Outlook 메일을 AI로 분석하여 요약, 다음 액션, 일정을 정리하는 워크 OS.

## 아키텍처

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   프론트엔드     │    │    서버           │    │   외부 API      │
│  (src/app.js)   │───▶│  (server.mjs)    │───▶│  Microsoft Graph│
│  index.html     │    │  port: 3010      │    │  /me/messages   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  AI 분석     │
                       │  1) 규칙 기반 │  (analyzer.js)
                       │  2) F-AIOS-v3│  (localhost:3201)
                       │  3) LM Studio│  (localhost:1234)
                       │  4) Gemini   │  (API Key 필요)
                       └──────────────┘
```

## 파일 구조

```
mail-intelligence/
├── server.mjs              # Node.js HTTP 서버 (메인)
├── package.json            # 의존성 없음, type:module
├── .outlook-config.json    # Azure AD 설정 (clientId, clientSecret, tenantId)
├── .mail-cache.json        # 메일 캐시 + 분석 결과 + 사용자 피드백
│
├── src/
│   ├── index.html          # 메인 HTML (설정, 메일목록, 상세, 액션)
│   ├── app.js              # 프론트엔드 로직 (DOM 조작, API 호출)
│   ├── analyzer.js         # 규칙 기반 메일 분석 엔진
│   └── styles.css          # 스타일 (dark sidebar, 3칼럼 레이아웃)
│
└── data/
    ├── accounts.json       # Outlook 계정 정보 (다중 계정 지원)
    ├── runtime-config.json # 런타임 설정 (토큰, 설정값)
    ├── oauth-states.json   # OAuth 상태 관리
    └── *.json              # 기타 데이터
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/outlook/config` | 설정 상태 조회 |
| `POST` | `/api/outlook/config` | 설정 저장 |
| `DELETE` | `/api/outlook/config` | 설정 초기화 |
| `GET` | `/api/outlook/status` | 연결 상태 확인 |
| `GET` | `/api/outlook/messages?top=25` | 메일 목록 조회 |
| `GET` | `/api/outlook/analyze?top=25` | 메일 분석 (AI 포함) |
| `POST` | `/api/outlook/send` | 메일 발송 |
| `POST` | `/api/outlook/read` | 읽음 상태 업데이트 |
| `POST` | `/api/outlook/feedback` | 분류 보정 피드백 저장 |
| `GET` | `/api/outlook/oauth/start` | OAuth 로그인 시작 |
| `GET` | `/auth/callback` | OAuth 콜백 |

## 데이터 흐름

### 1. 메일 동기화 (fetchOutlookMessages)
```
1. 캐시에서 기존 메일 로드
2. shouldFetchOnlyNew 판단:
   - 캐시 >= 요청수 → since(마지막 수신일) 이후만
   - 캐시 < 요청수 → 전체
3. Microsoft Graph API 호출
4. mergeMessages: 새 메일 추가, 변경 메일 업데이트
5. 캐시 저장 (.mail-cache.json)
```

### 2. 메일 분석 (analyzeMessages + enrichWithAI)
```
1. 규칙 기반 분석 (analyzer.js):
   - STATUS_RULES 패턴 매칭 (urgent/active/waiting/done)
   - OWNER_PATTERN, DATE_PATTERN, ACTION_PATTERN 추출
   - actionScenariosForMessage: 3가지 시나리오 생성

2. AI 강화 (enrichWithAI):
   - 캐시된 분석 결과 먼저 확인
   - 프로바이더 선택: f-aios-v3 → lmstudio → gemini
   - 프롬프트: 피드백 예시 + 메일 내용 → JSON 응답
   - normalizeActionScenarios: 3가지 시나리오 보정
   - 분석 결과 캐시 저장
```

### 3. 사용자 피드백 (saveClassificationFeedback)
```
1. 사용자가 메일 분류 보정 (urgent/active/waiting/done)
2. feedback 객체에 저장 (messageId → userStatus, reasonCode, note)
3. 유사 메일 판단 시 feedbackHint 제공
4. 다음 분석 시 피드백 예시로 활용
```

## 런타임 설정 (runtimeConfig)

```javascript
{
  accessToken: '',          // Microsoft Graph 액세스 토큰
  tenantId: '',             // Azure AD Tenant ID
  clientId: '',             // Azure AD Application Client ID
  clientSecret: '',         // Azure AD Client Secret
  mailboxUser: '',          // 메일박스 사용자 (비어있으면 /me)
  loginTenant: 'common',    // common | organizations | consumers
  geminiApiKey: '',         // Google AI Studio API Key
  geminiModel: 'gemini-2.5-flash',
  refreshToken: '',         // OAuth Refresh Token
  expiresAt: 0,             // 토큰 만료 시간
  aiProvider: 'f-aios-v3',  // f-aios-v3 | gemini | lmstudio
  faiosServerUrl: 'http://localhost:3201',
  lmstudioModel: 'qwen/qwen3.5-9b'
}
```

## UI 구성

### 3칼럼 레이아웃 (mail-shell)
```
┌─────────────┬─────────────┬─────────────┐
│  메일 목록   │   상세 패널   │   액션 패널   │
│  (messages) │ (detail)    │  (actions)  │
│             │             │  (calendar) │
│             │             │ (reminders) │
└─────────────┴─────────────┴─────────────┘
```

### 설정 패널 (config-panel)
- Login Tenant: common/organizations/consumers
- Access Token, Tenant ID, Client ID, Client Secret
- Mailbox User
- Google AI Studio API Key, Gemini Model
- AI 프로바이더: F-AIOS-v3 / LM Studio / Gemini
- F-AIOS-v3 서버 URL, LM Studio 모델

## 동기화 로직

### 초기 동기화
- 캐시가 비어있거나 요청 수보다 적을 때
- `since` 파라미터 없이 전체 메일 가져오기

### 増量 동기화
- 캐시가 요청 수 이상일 때
- `since`: 마지막 수신일 이후만 가져오기
- mergeMessages: 새 메일 추가, 변경 메일 업데이트

## 주요 함수

### 서버 (server.mjs)
- `fetchGraphMessages()`: Microsoft Graph API에서 메일 가져오기
- `fetchOutlookMessages()`: 캐시 + 동기화 로직
- `mergeMessages()`: 메일 병합 (새 메일/변경 메일)
- `enrichWithAI()`: AI 분석 강화 (프로바이더 선택)
- `saveClassificationFeedback()`: 사용자 피드백 저장
- `applyFeedbackToResult()`: 피드백 적용

### 프론트엔드 (app.js)
- `loadStatus()`: 설정 상태 로드
- `saveConfig()`: 설정 저장
- `loadOutlookMessages()`: 메일 가져오기 + 분석
- `selectMessage()`: 메일 선택 + 상세 표시
- `saveFeedback()`: 분류 보정 저장
- `sendComposedMail()`: 메일 발송

### 분석기 (analyzer.js)
- `analyzeMessages()`: 규칙 기반 분석
- `actionScenariosForMessage()`: 3가지 액션 시나리오 생성
- `summaryBullets()`: 메일 요약 생성

## 실행

```bash
cd /Users/jmpark/Playground/apps/mail-intelligence
PORT=3010 node server.mjs
```

접속: http://localhost:3010
