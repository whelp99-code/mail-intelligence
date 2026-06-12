# Mail Intelligence

Outlook 메일을 요약하고 다음 액션까지 정리하는 AI 기반 이메일 트라이아지 시스템.

## 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Mail Intelligence                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Browser   │◄──►│   Server    │◄──►│  MS Graph   │◄──►│  Outlook    │  │
│  │  (Frontend) │    │  (server.mjs)│    │     API     │    │  (Outlook)  │  │
│  └─────────────┘    └──────┬──────┘    └─────────────┘    └─────────────┘  │
│                            │                                               │
│                            ▼                                               │
│                    ┌───────────────┐                                       │
│                    │  AI Provider  │                                       │
│                    │  (하이브리드)  │                                       │
│                    └───────┬───────┘                                       │
│                            │                                               │
│            ┌───────────────┼───────────────┐                               │
│            ▼               ▼               ▼                               │
│    ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                   │
│    │  F-AIOS-v3    │ │  LM Studio    │ │    Gemini     │                   │
│    │  (localhost:  │ │  (localhost:  │ │  (Google API) │                   │
│    │     3200)     │ │     1234)     │ │               │                   │
│    └───────────────┘ └───────────────┘ └───────────────┘                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 기술 스택

| 구분 | 기술 | 설명 |
|------|------|------|
| **서버** | Node.js (ESM) | vanilla HTTP 서버 (`createServer`) |
| **프론트엔드** | Vanilla JS | CSS Grid 레이아웃, 모듈 JS |
| **데이터 저장** | JSON 파일 | 데이터베이스 없음 |
| **AI 통합** | 하이브리드 | F-AIOS-v3 → LM Studio → Gemini |
| **인증** | OAuth 2.0 | Microsoft Graph API (PKCE) |

## 파일 구조

```
mail-intelligence/
├── server.mjs              # 메인 서버 (1275줄)
├── package.json            # 프로젝트 설정
├── .outlook-config.json    # OAuth 설정 (clientId, clientSecret)
├── .mail-cache.json        # 이메일 캐시
├── src/
│   ├── index.html          # 메인 HTML (169줄)
│   ├── app.js              # 프론트엔드 로직 (732줄)
│   ├── analyzer.js         # 이메일 분석 엔진 (312줄)
│   └── styles.css          # 스타일링 (688줄)
└── data/
    ├── runtime-config.json # 런타임 설정
    ├── mail-cache.json     # 이메일 캐시
    ├── accounts.json       # 계정 설정
    ├── attachment-archive.json    # 첨부파일 아카이브
    ├── attachment-archive-meta.json # 첨부파일 메타데이터
    └── oauth-states.json   # OAuth 상태
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/outlook/status` | 연결 상태 확인 |
| `GET` | `/api/outlook/config` | 설정 조회 |
| `POST` | `/api/outlook/config` | 설정 저장 |
| `DELETE` | `/api/outlook/config` | 설정 초기화 |
| `GET` | `/api/outlook/oauth/start` | OAuth 로그인 시작 |
| `GET` | `/api/outlook/messages` | 메일 목록 조회 |
| `GET` | `/api/outlook/analyze` | 메일 분석 (AI 적용) |
| `POST` | `/api/outlook/send` | 메일 발송 |
| `POST` | `/api/outlook/read` | 읽음 표시 |
| `POST` | `/api/outlook/feedback` | 분류 피드백 저장 |

## 데이터 흐름

### 1. 메일 동기화

```
사용자가 "Outlook 가져오기" 클릭
    ↓
프론트엔드: fetch('/api/outlook/analyze?top=25')
    ↓
서버: fetchOutlookMessages(top)
    ↓
[캐시 확인] → .mail-cache.json에서 기존 메일 로드
    ↓
[동기화 모드 결정]
  - 첫 동기화: since 없음 (전체 메일)
  - 이후: since = 마지막 수신일 (증분 동기화)
    ↓
Microsoft Graph API 호출
    ↓
메일 병합 (mergeMessages)
    ↓
캐시 저장 (.mail-cache.json)
```

### 2. 메일 분석

```
분석 요청 수신
    ↓
[규칙 기반 분석] analyzeMessages()
  - STATUS_RULES 패턴 매칭
  - 태그 추출 (담당자, 일정, 액션)
  - 요약 생성
    ↓
[AI 향상] enrichWithAI()
  - 프롬프트 생성 (buildAnalysisPrompt)
  - AI 프로바이더 선택
    ↓
┌─────────────────────────────────────┐
│  F-AIOS-v3 (기본)                   │
│    ↓ 실패 시                        │
│  LM Studio (폴백)                   │
│    ↓ 실패 시                        │
│  규칙 기반만 적용                   │
└─────────────────────────────────────┘
    ↓
[피드백 적용] applyFeedbackToResult()
  - 사용자 보정 반영
  - 학습된 패턴 적용
    ↓
결과 반환
```

### 3. 사용자 피드백

```
사용자가 분류 보정 클릭
    ↓
POST /api/outlook/feedback
    ↓
saveClassificationFeedback()
  - 메시지 ID, 사용자 상태, 이유 저장
    ↓
다음 분석 시 feedbackExamples로 활용
    ↓
유사 패턴 자동 학습
```

## 핵심 함수 목록

### 서버 (server.mjs)

| 함수 | 설명 |
|------|------|
| `loadPersistedConfig()` | 설정 파일 로드 |
| `savePersistedConfig()` | 설정 파일 저장 |
| `loadMailCache()` | 메일 캐시 로드 |
| `saveMailCache()` | 메일 캐시 저장 |
| `getGraphAccessToken()` | Graph API 토큰 획득 |
| `fetchGraphMessages()` | Graph API에서 메일 가져오기 |
| `fetchOutlookMessages()` | 메일 동기화 (캐시 + Graph) |
| `sendOutlookMail()` | 메일 발송 |
| `markOutlookMessageRead()` | 읽음 표시 |
| `saveClassificationFeedback()` | 피드백 저장 |
| `analyzeMessages()` | 규칙 기반 분석 |
| `enrichWithAI()` | AI 향상 (하이브리드) |
| `applyFeedbackToResult()` | 피드백 적용 |
| `normalizeGraphMessage()` | Graph 메시지 정규화 |
| `mergeMessages()` | 메일 병합 |
| `demoMessages()` | 데모 메일 생성 |

### 프론트엔드 (app.js)

| 함수 | 설명 |
|------|------|
| `loadStatus()` | 설정 상태 로드 |
| `saveConfig()` | 설정 저장 |
| `loadOutlookMessages()` | 메일 가져오기 |
| `render()` | 전체 렌더링 |
| `renderFilteredView()` | 필터링된 뷰 렌더링 |
| `renderActionPanel()` | 액션 패널 렌더링 |
| `selectMessage()` | 메시지 선택 |
| `saveFeedback()` | 피드백 저장 |
| `sendComposedMail()` | 메일 발송 |
| `messageCard()` | 메시지 카드 생성 |
| `actionCard()` | 액션 카드 생성 |
| `feedbackPanel()` | 피드백 패널 생성 |
| `mailComposer()` | 메일 편집기 생성 |

### 분석기 (analyzer.js)

| 함수 | 설명 |
|------|------|
| `analyzeMail()` | 단일 메일 분석 |
| `analyzeMessages()` | 다중 메일 분석 |
| `splitCandidates()` | 후보 줄 분리 |
| `inferLane()` | 상태 추론 |
| `inferOwner()` | 담당자 추론 |
| `inferDates()` | 일정 추론 |
| `summaryBullets()` | 요약 생성 |
| `actionScenariosForMessage()` | 액션 시나리오 생성 |

## 설정 옵션

### 런타임 설정 (runtimeConfig)

```javascript
{
  accessToken: '',           // Graph API 토큰
  tenantId: '',              // Azure AD 테넌트 ID
  clientId: '',              // Azure AD 앱 ID
  clientSecret: '',          // Azure AD 시크릿
  mailboxUser: '',           // 메일박스 사용자
  loginTenant: 'common',     // 로그인 테넌트
  geminiApiKey: '',          // Gemini API 키
  geminiModel: 'gemini-2.5-flash', // Gemini 모델
  refreshToken: '',          // 리프레시 토큰
  expiresAt: 0,              // 토큰 만료 시간
  
  // AI 프로바이더 설정
  aiProvider: 'f-aios-v3',   // 'f-aios-v3' | 'gemini' | 'lmstudio'
  faiosServerUrl: 'http://localhost:3200', // F-AIOS-v3 서버
  lmstudioModel: 'qwen/qwen3.5-9b'       // LM Studio 모델
}
```

### 분석 상태 분류

| 상태 | 의미 | 패턴 |
|------|------|------|
| `urgent` | 긴급 | 긴급, 오늘 중, 마감, 장애, critical, urgent, asap |
| `active` | 진행중 | 진행, 준비, 검토, 작성, 공유, follow-up |
| `waiting` | 대기 | 대기, 회신 대기, 승인 대기, 확인 부탁 |
| `done` | 완료 | 완료, 종료, 처리했습니다, 발송했습니다 |
| `reference` | 참고 | 위 조건에 해당하지 않는 경우 |

## 주요 기능

### 1. 3칼럼 레이아웃
- **메일 목록**: 그룹별 분류, 읽지않음 표시, 검색
- **메일 상세**: 요약, 본문, 피드백 패널
- **액션 패널**: 다음 액션, 일정, 알림 후보

### 2. 드래그 리사이저
- 칼럼 너비 마우스로 조절
- 더블클릭으로 초기화

### 3. AI 하이브리드 시스템
- F-AIOS-v3 (기본) → LM Studio (폴백) → 규칙 기반
- 비용 제로, 무제한, 로컬 처리

### 4. 사용자 피드백 학습
- 분류 보정 저장
- 유사 패턴 자동 적용
- 다음 분석 기준 개선

## 실행 방법

```bash
# 설치
cd mail-intelligence
npm install

# 실행 (포트 10200)
PORT=10200 npm run dev

# 브라우저에서 열기
open http://localhost:10200
```

## 환경 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `PORT` | 서버 포트 | `10200` |
| `OUTLOOK_GRAPH_ACCESS_TOKEN` | Graph API 토큰 | - |
| `MICROSOFT_TENANT_ID` | Azure AD 테넌트 ID | - |
| `MICROSOFT_CLIENT_ID` | Azure AD 앱 ID | - |
| `MICROSOFT_CLIENT_SECRET` | Azure AD 시크릿 | - |
| `OUTLOOK_MAILBOX_USER` | 메일박스 사용자 | - |
| `GEMINI_API_KEY` | Gemini API 키 | - |

## 참고사항

1. **첫 동기화**: `since` 없이 전체 메일 가져옴
2. **이후 동기화**: `lastReceivedAt` 이후 새 메일만 증분 동기화
3. **OAuth 흐름**: PKCE 사용, Azure AD 앱은 confidential client 타입
4. **캐시**: `.mail-cache.json`에 메일과 분석 결과 저장
5. **피드백**: 사용자 보정은 다음 분석 시 학습 기반으로 활용
