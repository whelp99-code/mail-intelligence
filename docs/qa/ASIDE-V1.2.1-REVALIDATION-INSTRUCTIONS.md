# Aside 재검증 지시서 — Mail Intelligence v1.2.1 QA 차단 결함 해소 확인

## 0. 역할과 최종 목표

너는 개발자가 아니라 독립 검증자다.

```text
Independent QA
Adversarial Tester
Production Readiness Reviewer
UX Tester
```

기존 개발 보고서의 PASS를 신뢰하지 않는다. 직접 재현한 증거만 인정한다.

이 재검증은 이전 독립 QA에서 발견한 F-01~F-04가 실제 Ubuntu 운영 환경에서 해결됐는지 확인한다.

최종 산출물:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-rerun-report.md
```

최종 판정은 다음 중 하나다.

```text
GO
CONDITIONAL GO
NO-GO
```

## 1. 대상

```text
projectId       mail-intelligence
workername      mailintelligence
path            /home/jm/orca/projects/mail-intelligence
branch          main
Ubuntu host     jm-acloud
Backend         127.0.0.1:3010
Tailnet         http://100.87.81.57:3010
Version         1.2.1
```

## 2. Source of Truth

먼저 다음 문서를 읽는다.

```text
AGENTS.md
README.md
docs/planning/V1.2.0-PRECISION-CLASSIFICATION-PLAN.md
docs/planning/V1.2.1-OAUTH-LLM-PROVIDERS.md
docs/releases/v1.2.1-QA-BLOCKER-REMEDIATION-REPORT.md
이전 독립 QA 보고서
```

이전 QA의 릴리스 차단 항목:

```text
F-01 Grok 상태 오판·오류 UX
F-02 Forwarded message 과거 본문 분리 실패
F-03 Evidence exact match 100% 미달
F-04 지능형 탐색 Garbage·정밀도 미확정
```

## 3. 절대 안전선

재검증 중에도 READ ONLY를 유지한다.

반드시 확인:

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
```

Microsoft Graph 권한:

```text
허용: User.Read, Mail.Read, openid, profile, offline_access
금지: Mail.Send, Mail.ReadWrite
```

금지 행동:

```text
메일 발송·답장·전달
읽음 상태 변경
이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
```

안전선이 깨져 있으면 즉시 `CRITICAL FAIL / NO-GO`로 판정한다.

## 4. 변경 전 기준선

다음을 기록한다.

```bash
git status --short
git branch --show-current
git log -5 --oneline
git rev-list --left-right --count HEAD...origin/main
```

기존 작업 트리를 변경하거나 정리하지 않는다.

서비스:

```bash
systemctl --user is-enabled mail-intelligence.service
systemctl --user is-active mail-intelligence.service
systemctl --user is-enabled mail-intelligence-tailnet.service
systemctl --user is-active mail-intelligence-tailnet.service
systemctl --user show mail-intelligence.service -p MainPID -p NRestarts
systemctl --user show mail-intelligence-tailnet.service -p MainPID -p NRestarts
ss -ltnp | grep ':3010'
```

예상:

```text
127.0.0.1:3010         backend
100.87.81.57:3010      Tailnet proxy
0.0.0.0:3010           없어야 함
```

DB 기준선:

```bash
npm run memory:status
npm run memory:integrity
npm run verify:qa:operational
```

예상 수정 후 기준:

```text
messages                  359 전후
schemaVersion              4
quick_check                ok
foreign_key_errors         0
classification version     precision-classification-v1.2.1-qa-fix1
Evidence exact rate        100%
Placeholder evidence       0
Forwarded regressions      0
Promotional false actions  0
```

## 5. 자동 게이트 독립 재실행

다음을 직접 실행한다.

```bash
npm run verify:v1.2.1
npm run verify:oauth
npm run verify:qa:operational
npm run verify:live:local
npm run verify:tailnet
npm audit --audit-level=high
git diff --check
```

PASS 기준:

```text
node:test                  174 이상, 실패 0
Precision fixtures         20/20
Precision assertions       77/77
OAuth tests                7/7
ESLint/HTMLHint/Stylelint  PASS
Safety                     PASS
Dependency vulnerabilities 0
```

## 6. F-02 Forwarded message 독립 재검증

### 6.1 합성 회귀

다음 사례를 새 독립 테스트 또는 REPL로 직접 검증한다.

#### Case A — 단순 전달 참고

```text
Subject: Fwd: 제출 요청

아래 내용 참고 바랍니다.

---------- Forwarded message ----------
From: old@example.com
Date: 2026-08-01
Subject: 제출 요청
오늘까지 제출 바랍니다.
```

기대:

```text
Work State       REFERENCE 또는 REVIEW_REQUIRED
Next Actor       NONE 또는 UNKNOWN
Due Date         없음
과거 요청        현재 업무로 승격되지 않음
```

#### Case B — 현재 직접 요청이 있음

```text
아래 고객 요청대로 오늘까지 제안서를 제출해 주세요.

-------- Forwarded Message --------
From: customer@example.com
Sent: Friday
To: user@example.com
Subject: old
오늘까지 제출 바랍니다.
```

기대:

```text
ACTION_REQUIRED
ME
Due today
Evidence는 현재 첫 문장
```

#### 추가 필수 형식

```text
Begin forwarded message:
Original Message
전달된 메시지 시작
보낸 메시지 시작
Outlook From/Sent/To/Subject 헤더 묶음
모바일 Outlook 한글 헤더
HTML blockquote
2중·3중 전달
단독 From:이 본문에 있는 정상 문장
```

단독 `From:` 한 번만으로 본문을 잘라서는 안 된다.

### 6.2 운영 DB 전달 메일

운영 DB의 다음 표본을 독립 검토한다.

```text
Fwd:/Fw:/전달: 제목
Forwarded message marker
Original Message marker
헤더 묶음
```

최소 30건 또는 전체 중 적은 쪽을 검토한다.

각 메일에 대해:

```text
현재 직접 요청 존재 여부
시스템 Work State
Next Actor
Due Date
Evidence 위치
```

PASS 기준:

```text
과거 전달 요청만으로 false action 0건
과거 전달 날짜만으로 current due 0건
현재 직접 요청이 있을 때만 action 생성
```

## 7. F-03 Evidence 100% 독립 재검증

전체 활성 분류를 직접 다시 계산한다.

각 Evidence에서 확인:

```text
sourceField
sourceMessageId
startOffset
endOffset
exactText
sourceHash
normalizationVersion=exact-source-span-v1
```

검증식:

```text
canonicalSource.slice(startOffset, endOffset) === exactText
sha256(canonicalSource) === sourceHash
```

현재 본문 canonical source는 전달·인용 과거 본문을 제거한 currentContent다.

반드시 검사:

```text
전체 Evidence
빈 제목 메일
HTML 링크
번호 목록
한글 Unicode
영문
사용자 보정 Evidence
```

PASS 기준:

```text
Exact span          100%
Hash match          100%
Invalid offsets     0
Placeholder         0
(제목 없음) Evidence 0
원문 없는 Evidence  0
```

UI가 빈 제목을 `(제목 없음)`으로 표시하는 것은 허용하지만 DB subject와 Evidence에는 저장하면 안 된다.

## 8. F-01 Provider 상태·오류 UX 재검증

### 8.1 상태 모델

Provider 카드가 다음을 별도로 보여야 한다.

```text
CLI 설치 여부
OAuth 로그인 여부
최근 합성 모델 호출
최근 실메일 분석
운영 가능 상태
```

금지:

```text
OAuth 로그인됨 = 실제 모델 호출 가능
```

### 8.2 OpenAI Luna 실제 합성 테스트

UI의 `선택 Provider 테스트` 또는 API를 사용한다.

```text
Provider    OpenAI · ChatGPT OAuth
Preset      Luna
입력        고정 합성 문장
실메일      사용 금지
```

PASS 기준:

```text
HTTP 200
status=passed
실제 모델 응답
Evidence 검증 PASS
latencyMs 기록
상태 API에 lastSyntheticTest=passed 지속
페이지 새로고침 후 상태 유지
raw JSONL 노출 0
stack trace 노출 0
```

### 8.3 Grok 실제 호출

현재 계정 잔액 상태를 그대로 테스트한다.

잔액이 여전히 소진된 경우 기대:

```text
CLI 설치됨
OAuth 로그인됨
실제 모델 호출 불가
operationalStatus=unavailable
safeErrorCode=BILLING_BALANCE_EXHAUSTED
사용자 조치: 결제·잔액 확인
HTTP 424 또는 안전한 실패 상태
```

금지 노출:

```text
Payment Required 원문
usage balance exhausted 원문
Internal error
CLI stderr
raw JSON
stack trace
Token
```

잔액이 충전되어 실제 호출이 성공하면 `passed/available`로 표시되어야 한다.

OpenAI와 Grok 사이의 자동 Provider 폴백은 없어야 한다.

## 9. F-04 지능형 탐색 재검증

### 9.1 재현 질의

실제 DB에서 다음을 실행한다.

```text
견적
계약
보안 관련
이번 주 마감
오늘 내가 할 일
참고 메일
고객 회신 대기
검토 필요
```

각 질의 Top 10을 수동 검토한다.

특히 이전 실패 사례:

```text
광고 웨비나가 ACTION_REQUIRED/ME/HIGH
세금계산서가 보안 CRITICAL
광고·자동 알림이 이번 주 마감
과거 행사일이 Reference due
```

PASS 기준:

```text
promotional 광고 false action 0
보안 질의 세금계산서 오탐 0
Reference/Completed에 과거 due 노출 0
전달 과거 기한으로 due 검색 노출 0
```

### 9.2 독립 Human Ground Truth

개발 Fixture를 사용하지 않는다.

실제 Outlook 메일에서 최소 50건을 계층 표집한다.

필수 유형:

```text
고객 요청
내부 요청
외부 대기
완료
참고
광고·뉴스레터·웨비나
자동 알림
전달·인용
견적·계약
승인·일정
장애·보안
한글·영문 혼합
```

시스템 결과를 보기 전에 Ground Truth를 기록한다.

각 건:

```text
Expected Work State
Expected Next Actor
Expected Priority
Expected Due
Expected Reference 여부
Expected Review 여부
Evidence 위치
```

측정:

```text
Work State accuracy
Next Actor accuracy
Reference precision
False-action rate
Important miss rate
Evidence exact rate
```

목표:

```text
Work State accuracy       >=95%
Next Actor accuracy       >=95%
Reference false action    <=2%
Important miss rate       <=3%
Evidence exact            100%
```

### 9.3 검색 Top-5 평가

최소 10개 실제 질의에 대해 Top-5를 평가한다.

```text
Relevant
Partially Relevant
Wrong
```

Top-5 hit rate 목표:

```text
>=90%
```

## 10. Delta·백업·재시작

실제 Outlook 읽기 전용 Delta를 두 번 실행한다.

1차와 2차 사이 실제 변경이 없다면:

```text
두 번째 fetched/upserted/deleted 0 또는 실제 변경분만 반영
message 중복 0
folder 중복 0
```

검증 백업:

```bash
npm run memory:backup
npm run memory:integrity
```

운영 DB를 직접 restore하지 않는다. 백업 복사본을 임시 위치에서 열어 checksum/schema/record count/quick_check/foreign key를 확인한다.

서비스 재시작:

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
```

확인:

```text
messages 유지
classification 유지
provider test 상태 유지
correction 유지
Delta cursor 유지
backup history 유지
```

## 11. 사용자 보정 지속성

운영 데이터를 훼손하지 않도록 테스트용 또는 승인된 메일 한 건을 선택한다.

```text
자동 상태
→ 사용자 보정
→ 새로고침
→ 재분류
→ Delta
→ 서비스 restart
```

사용자 보정이 유지돼야 한다. 테스트 종료 후 원래 값으로 복구하되 감사 이벤트는 남긴다.

## 12. 30분 안정성 관찰

최소 30분 관찰한다.

```text
systemd NRestarts
Unhandled exception
CPU/RSS 추세
SQLite WAL 크기
operator_jobs 증가
Dead Letter 증가
Graph 429/5xx
OAuth 실패 반복
```

PASS 기준:

```text
unexpected restart 0
fatal/unhandled 0
무한 retry 0
WAL 비정상 증가 없음
Dead Letter 설명 가능
```

## 13. 최종 판정 규칙

### GO

모두 충족:

```text
F-01~F-04 PASS
Evidence 100%
Forwarded false action 0
Provider 상태·오류 UX PASS
50건 Ground Truth 목표 충족
Top-5 >=90%
Delta/backup/restart PASS
30분 관찰 PASS
안전선 유지
```

### CONDITIONAL GO

코드 결함은 해결됐지만 외부 공급자 결제 등 제품 외부 제약만 남고, 해당 Provider가 정확히 unavailable로 격리돼 Rules/OpenAI 운영에 영향을 주지 않는 경우에만 허용한다.

### NO-GO

다음 중 하나:

```text
Evidence <100%
Forwarded false action 재현
광고 false action 지속
OAuth 상태와 실제 호출 상태 혼동
raw 오류·비밀 노출
50건 정확도 기준 미달
중복·데이터 손실
안전선 위반
```

## 14. 보고서 형식

```text
1. 최종 판정
2. 이전 F-01~F-04별 재현·결과
3. 자동 게이트
4. 운영 DB Evidence 전수검사
5. Forwarded 운영 표본
6. Provider 실제 호출·오류 UX
7. 50건 Ground Truth 지표
8. 검색 Top-5 지표
9. Delta·백업·재시작
10. 30분 안정성
11. 안전선
12. 남은 문제와 우선순위
13. 수정 파일 여부
```

보고서에 메일 전문, Token, Access Key, Cookie, Client Secret, OAuth Credential을 포함하지 않는다.

소스 코드를 수정하지 않는다. 재검증 중 새 결함을 찾으면 재현 증거와 최소 수정 제안만 작성하고 `NO-GO`로 보고한다.
