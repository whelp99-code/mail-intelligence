# Mail Intelligence 전체 점검 및 AIOSv2 통합 리스크

점검일: 2026-06-15
대상: `/Users/jmpark/Documents/Playground/apps/mail-intelligence`
통합 대상: `/Users/jmpark/Documents/Playground/AIOSv2_integration`

## 요약

현재 앱은 standalone Node HTTP 서버와 vanilla JS UI로 동작하며, Microsoft Graph 메일 수집/읽음 처리/메일 발송/OAuth/AI 분석/로컬 캐시를 한 서버 파일에 포함한다.

AIOSv2에는 이미 `packages/domain/mail`, `packages/application/mail`, `apps/api/src/routers/mail.router.ts`, `apps/web/src/app/mail/page.tsx`, `apps/web/src/app/api/proxy/outlook/*`가 존재한다. 따라서 standalone 앱을 그대로 복사 통합하면 DDD 계층, 승인 게이트, evidence 기록, Prisma 저장 계약과 충돌한다.

## 주요 리스크

| 등급 | 항목 | 내용 | 조치 |
| --- | --- | --- | --- |
| P0 | 민감정보 노출 | untracked JSON에 access/refresh token, client secret, Gemini key, OAuth verifier, 실제 메일 본문이 포함됨 | git add 금지, ignore 보강, 토큰/키 로테이션 |
| P0 | 승인 게이트 누락 | `/api/outlook/send`, `/api/outlook/read`, `/api/outlook/config DELETE`가 AIOSv2 approval flow 없이 즉시 실행됨 | v2 `ensureApprovedAction` + standalone `MAIL_REQUIRE_APPROVAL` / `X-AIOS-Approval-Id` |

## Destructive API (Sprint 1)

| Method | Standalone path | v2 gated route | ApprovalActionType |
| --- | --- | --- | --- |
| POST | `/api/outlook/send` | `/api/mail/send` | `send` |
| POST | `/api/outlook/read` | `/api/mail/read` | `data-mutation` |
| DELETE | `/api/outlook/config` | `/api/mail/config` | `config-change` |

로컬 단독 실행: `MAIL_REQUIRE_APPROVAL=false` (기본). 통합 환경: v2 proxy가 승인 후 `X-AIOS-Approval-Id` 헤더로 forward.

## Portal bridge (Sprint 2)

| Endpoint | v1 contract |
| --- | --- |
| `GET /api/portal/sync-overview` | `MailSyncResult` |
| `GET /api/portal/thread-insights` | `mailInsightThreadInputSchema[]` |
| `POST /api/portal/push-candidates` | `TaskCandidate[]` |
| `GET /api/portal/thread/:key` | thread detail |

구현: [`src/portalBridge.mjs`](src/portalBridge.mjs)
| P1 | 런타임 오류 후보 | `src/services/graph-client.ts`가 `node:http`에서 `fetch`를 import함. Node 20에서 해당 export 없음 | global `fetch` 또는 `undici` 사용 |
| P1 | DDD 계층 불일치 | Graph API, config, cache, AI prompt, workflow call이 `server.mjs`에 혼재 | domain/application/infrastructure/apps 분리 |
| P1 | 데이터 계약 불일치 | standalone 메시지는 `from: string`, AIOSv2 domain은 `from: MailAddress`와 `receivedAt` datetime 사용 | mapper/adapter 필요 |
| P1 | 검증 사각지대 | 신규 `src/services/*.ts`가 package script, lint, typecheck 대상에서 빠짐 | TS package 또는 AIOSv2 package로 이관 후 typecheck |
| P2 | HTML 검증 실패 | `src/index.html`에서 camelCase id/class 규칙 위반 40건 | 규칙 완화 또는 id kebab-case 마이그레이션 |
| P2 | 검증 hang | ESLint/Stylelint가 장시간 종료되지 않음 | config/버전/대상 파일 분리 점검 |

## 민감 파일 상태

값은 보고서에 기록하지 않는다.

| 파일 | 상태 | 포함 범주 |
| --- | --- | --- |
| `.outlook-accounts.json` | NOT ignored | token, key, email, mail body |
| `.oauth-states.json` | NOT ignored | OAuth state/code verifier |
| `.attachment-archive.json` | NOT ignored | attachment archive cache |
| `.attachment-archive-meta.json` | NOT ignored | attachment archive metadata |
| `data/accounts.json` | ignored | token, key, email, mail body |
| `data/runtime-config.json` | ignored | token, secret, API key |
| `data/oauth-states.json` | ignored | OAuth state/code verifier |
| `data/mail-cache.json` | NOT ignored | runtime cache |
| `.env 2.example` | NOT ignored | duplicate example/config artifact |
| `.outlook-config.json 2.example` | NOT ignored | duplicate example/config artifact |

## AIOSv2 통합 시 권장 분해

| standalone 기능 | AIOSv2 위치 | 비고 |
| --- | --- | --- |
| 메일 메시지 타입/분류 상태 | `packages/domain/mail` | `urgent/active/waiting/done/hold`, feedback value object 추가 |
| 메일 수집/분석 use case | `packages/application/mail` | `syncInbox`, `analyzeInbox`, `saveFeedback`, `draftReply` 분리 |
| Microsoft Graph/OAuth | `packages/infrastructure/src/mail` 또는 `packages/infrastructure/mail` | 토큰 저장소, refresh, Graph adapter |
| 로컬 JSON 캐시 | 임시 adapter 또는 Prisma repository | 운영 통합은 `packages/db/prisma/schema.prisma` 확장 |
| 메일 발송 | application use case + approval middleware | 승인 전에는 draft만 생성 |
| UI | `apps/web/src/app/mail` | 현재 proxy page를 실제 분석/승인 UI로 확장 |
| evidence | `docs/evidence` 또는 collaboration evidence writer | 실행 결과/실패/승인 이력 기록 |

## 실행 검증

| 명령 | 결과 |
| --- | --- |
| `npm run check` | 통과 |
| `npm audit --audit-level=high` | 통과, high 이상 취약점 없음 |
| `npm run validate:html` | 실패, `id-class-value` 40건 |
| `npm run validate:css` | 90초 이상 무출력, 중단 |
| `npm run lint` | 30초 이상 무출력, 중단 |
| `git diff --check` | 통과 |
| `pnpm --filter @aios/domain/mail typecheck` | 통과 |
| `pnpm --filter @aios/application/mail typecheck` | 통과 |

## 통합 순서 제안

1. `mail-intelligence` repo에서 민감 runtime 파일을 ignore/격리하고 노출된 토큰과 API key를 로테이션한다.
2. AIOSv2 `packages/domain/mail`에 standalone 분석 결과와 feedback 상태를 수용할 타입을 추가한다.
3. `packages/infrastructure`에 Microsoft Graph adapter를 추가하되, `sendMail`과 `markRead`는 직접 호출하지 않고 application use case 뒤에 둔다.
4. `packages/application/mail`에 `syncInbox`, `analyzeInbox`, `saveClassificationFeedback`, `requestSendApproval`, `sendApprovedMail` use case를 추가한다.
5. `apps/web/src/app/mail`은 `/api/proxy/outlook/*` 의존을 줄이고 AIOSv2 API/tRPC 또는 app route로 전환한다.
6. 발송/삭제/외부 공유/운영 DB 변경은 AIOSv2 approval queue와 evidence writer를 경유한다.
7. 통합 검증은 `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter @aios/web build`, `git diff --check`, changed-file Prettier 순서로 수행한다.

