# Aside 독립 재재검증 지시서 — Mail Intelligence v1.2.1 qa-fix2

## 0. 역할

너는 개발자가 아니라 독립 검증자다.

```text
Independent QA
Adversarial Tester
Production Readiness Reviewer
UX Tester
```

개발자의 PASS, 자동 테스트 수, 운영 스모크 결과를 최종 품질 증거로 그대로 인정하지 않는다. 직접 재현한 결과만 최종 판정에 사용한다.

소스 코드를 수정하지 않는다. 새 결함을 찾으면 재현 증거, 영향, 심각도, 최소 수정 제안만 기록한다.

최종 산출물:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-round-2-report.md
```

최종 판정:

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
version         1.2.1
classifier      precision-classification-v1.2.1-qa-fix2
search          intelligent-search-v1.2.1-qa-fix2
Backend         http://127.0.0.1:3010
Tailnet         http://100.87.81.57:3010
```

## 2. 반드시 읽을 문서

```text
AGENTS.md
README.md
이전 1차 독립 QA 보고서
이전 재검증 독립 QA 보고서
docs/releases/v1.2.1-QA-BLOCKER-REMEDIATION-REPORT.md
docs/releases/v1.2.1-QA-RERUN-2-REMEDIATION-REPORT.md
```

이전 재검증 NO-GO 기준선:

```text
Work State accuracy       31/50 = 62.0%
Next Actor accuracy       29/50 = 58.0%
Reference false-action    12/50 = 24.0%
Important miss            1/13 = 7.7%
Top-5 query success       8/10 = 80%
계약완료                   0건
한국어 Outlook reply      boundary 미인식
```

## 3. 절대 안전선

실행 프로세스에서 직접 확인한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
```

Graph delegated permissions:

```text
허용: User.Read, Mail.Read, openid, profile, offline_access
금지: Mail.Send, Mail.ReadWrite
```

금지:

```text
메일 발송·답장·전달
읽음 상태 변경
이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
```

안전선 위반은 즉시 `CRITICAL FAIL / NO-GO`다.

## 4. 저장소·서비스 기준선

```bash
git status --short
git branch --show-current
git log -5 --oneline
git rev-list --left-right --count HEAD...origin/main
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
127.0.0.1:3010       backend
100.87.81.57:3010    Tailnet proxy
0.0.0.0:3010         없음
```

DB:

```bash
npm run memory:status
npm run memory:integrity
npm run verify:qa:operational
npm run verify:qa:search
```

개발 측 운영 기준:

```text
messages                         359
classifications                  359
review required                  67
schema                           4
quick_check                      ok
foreign key errors               0
exact evidence                   1,271/1,271
Korean reply boundary failures   0
outgoing action violations       0
outgoing actor violations        0
lifecycle action violations      0
automatic invoice actions        0
```

값이 달라질 수는 있지만 원인 없는 데이터 손실·중복·무결성 실패는 NO-GO다.

## 5. 자동 게이트

직접 실행한다.

```bash
npm run verify:v1.2.1
npm run verify:oauth
npm run verify:qa:operational
npm run verify:qa:search
npm run verify:live:local
npm run verify:tailnet
npm audit --audit-level=high
git diff --check
```

최소 기대:

```text
node:test                  194 이상, 실패 0
Precision fixtures         20/20
Precision assertions       77/77
OAuth tests                7/7
Lint/HTML/CSS              PASS
Safety                     PASS
Vulnerabilities            0
```

자동 게이트는 독립 50건·Top-5 평가를 대체하지 않는다.

## 6. F-02 한국어 Outlook 회신 경계

### 6.1 합성 형식

다음을 각각 검사한다.

```text
2026년 8월 27일 목요일 오후 4:21 홍길동 <old@example.com>님이 작성:
2026년 ... 님이 작성:
홍길동님이 작성:
모바일 Outlook 변형
Re: + 님이 작성:
[RE]Re: + 님이 작성:
2중·3중 인용
```

Case A:

```text
현재 요청입니다. 수정 자료를 보내주세요.

2026년 ... 과거담당자님이 작성:
요청하신 자료중에 전달 가능한 자료를 전달 드립니다.
```

기대:

```text
ACTION_REQUIRED / ME
Evidence = 현재 요청 문장
과거 전달 문장 Evidence 금지
```

Case B:

```text
아래 내용 참고 바랍니다.

2026년 ... 과거담당자님이 작성:
오늘까지 제출 바랍니다.
```

기대:

```text
REFERENCE 또는 REVIEW_REQUIRED
과거 문장으로 ACTION 금지
과거 날짜로 Due 금지
```

### 6.2 이전 운영 재현 메일

이전 보고서의 식별자:

```text
SHA-256 축약: 9d640d38890d
```

동일 메일을 다시 확인한다.

필수:

```text
boundary != none
Evidence가 currentContent 안에 있음
Evidence가 과거 문장 `요청하신 자료중에 ...`를 가리키지 않음
```

### 6.3 운영 표본

`님이 작성:`, `On ... wrote:`, `From/Sent/To/Subject`, Forwarded marker 후보 최소 30건 또는 전체 중 적은 쪽을 확인한다.

PASS:

```text
history-only false action     0
history-only current due      0
history Evidence              0
current direct request miss   0
```

## 7. 보낸 편지함 Work State·Next Actor

이전 50건 Ground Truth에서 보낸 발주·견적 요청이 `ACTION_REQUIRED / ME`로 남은 것이 주요 실패였다.

### 7.1 운영 전체 검사

보낸 편지함 전체를 집계한다.

PASS:

```text
ACTION_REQUIRED / ME          0
DECISION_REQUIRED / ME        0
WAITING인데 actor != external 0
```

### 7.2 수동 표본

보낸 편지함 최소 20건을 다음 유형으로 표집한다.

```text
견적 요청
발주 요청
자료 요청
수정 요청
승인 요청
견적·발주 전달
자료 전달 후 확인 요청
장문 사양 전달
단순 참고 전달
```

기대:

```text
상대방 행동이 남은 요청       WAITING / EXTERNAL_PARTY
발송 자체로 업무가 종료된 안내 적절한 COMPLETED/REFERENCE
빈 본문·불확실                 REVIEW_REQUIRED 허용
```

보낸 메일이라는 이유만으로 모든 메일을 무조건 Waiting으로 만드는지도 적대적으로 확인한다.

## 8. 완료·Reference·자동 알림

최소 다음 유형을 각각 5건 이상 또는 존재하는 전체로 평가한다.

```text
작업 완료 회신
계약완료 안내
발주서·자료 첨부 안내
세금계산서 발행·도착 알림
세금계산서 실제 발행 요청
Verification code
자동 시스템 알림
광고·웨비나
기밀 고지
삭제·정크 폴더
전달 참고 메일
```

PASS:

```text
자동 세금계산서 ACTION         0
Verification code ACTION       0
광고 false action              0
삭제·정크 actionable           0
COMPLETED/REFERENCE HIGH       0
실제 세금계산서 발행 요청 miss 0
```

## 9. 영문 기술 요청 Important Miss

다음 표현을 합성 및 실제 메일로 검증한다.

```text
Please answer ...
Can you ...
Could you ...
Would you ...
Kindly ...
Is it possible to configure ...
Please investigate/fix/resolve/support ...
```

기밀 고지의 다음 문장은 Action이 아니어야 한다.

```text
If you receive this email by mistake, please delete it and notify the sender.
```

실제 이전 누락 유형인 영문 기술 지원 요청이 `ACTION_REQUIRED / ME`로 분류되는지 확인한다.

## 10. Due·Signal·Priority 오염

다음을 검증한다.

```text
계약기간 2026-02-01 ~ 2027-01-31
  → current Due 아님

가능한 빨리 견적서를 보내주세요
  → ambiguous due

라이선스 2026-10-13 만료
  → due 유지

FAQ의 장애 지원 문구
  → incident_security 아님

완료 안내에 과거 장애 단어
  → HIGH/CRITICAL 아님
```

운영 메일에서 과거 날짜·계약기간·행사일이 current due로 올라오는 사례가 0이어야 한다.

## 11. Evidence 전수 검사

활성 분류 전체를 다시 읽는다.

각 Evidence:

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

canonicalSource의 body는 current/history 분리 후 currentContent다.

PASS:

```text
Exact span              100%
Hash                    100%
Invalid offset          0
sourceMessageId mismatch 0
Placeholder             0
History evidence        0
```

## 12. 동일 50건 Blind Ground Truth 재평가

### 12.1 가장 중요한 원칙

가능하면 이전 재검증에서 사용한 **동일한 50개 message ID/해시와 기존 Ground Truth 라벨을 그대로 재사용**한다.

금지:

```text
새 시스템 결과를 본 뒤 Ground Truth 변경
불리한 메일 교체
fixture로 대체
개발자 예상값 사용
```

동일 50건 재사용이 기술적으로 불가능하면 사유를 기록하고 동일 계층 표집 방식으로 새 50건을 blind label한다.

### 12.2 지표

```text
Work State accuracy
Next Actor accuracy
Priority accuracy
Reference false-action
Important miss
Evidence exact
```

합격 기준:

```text
Work State accuracy       >=95%
Next Actor accuracy       >=95%
Reference false-action    <=2%
Important miss            <=3%
Evidence exact            100%
```

50건에서는 최대 허용 오류 수를 함께 적는다.

```text
Work State                최대 2건
Next Actor                최대 2건
Reference false-action    최대 1건
```

Important miss는 분모가 작으면 단 한 건도 기준을 넘길 수 있으므로 건수와 비율을 모두 보고한다.

### 12.3 대표 오류 변화표

이전 오류 유형별로 Before/After를 작성한다.

```text
보낸 요청
완료 안내
자동 세금계산서
자동 알림
전달 참고
영문 기술 요청
호칭 Actor 오탐
계약기간 Due
```

## 13. 동일 10개 Top-5 재평가

반드시 이전과 같은 질의를 사용한다.

```text
롯데건설
GS건설 라이선스
부산도시가스 견적
발주서
세금계산서
Sangfor IAG
긴급 견적
계약완료
장애
보안
```

각 Top-5 항목을 원문으로 다음 중 하나로 평가한다.

```text
Relevant
Partially Relevant
Wrong
```

보고:

```text
질의별 결과 수
질의별 Relevant/Partial/Wrong
Top-5 precision
질의 성공 여부
전체 hit rate
```

합격 기준:

```text
Query success >=90%
계약완료 result >0
발주서 residual != '서'
Promotional result 0
Deleted/Junk result 0
긴급 견적 invoice garbage 0
장애 invoice garbage 0
보안 invoice garbage 0
```

검색 스모크 PASS를 독립 relevance 90%로 간주하지 않는다.

## 14. Provider 회귀

F-01은 이전 독립 재검증에서 PASS였으므로 최소 회귀로 상태가 깨지지 않았는지 확인한다.

```text
CLI 설치
OAuth 로그인
최근 합성 테스트
최근 실메일 분석
operationalStatus
```

OpenAI:

```text
Luna 합성 1회
status=passed
Evidence 검증 PASS
latency 기록
재시작 후 유지
```

Grok 잔액이 여전히 부족한 경우:

```text
operationalStatus=unavailable
safeErrorCode=BILLING_BALANCE_EXHAUSTED
결제·잔액 안내
raw provider 오류 노출 0
```

Provider 자동 폴백은 없어야 한다.

## 15. Delta·백업·재시작

실제 Outlook 읽기 전용 Delta 2회:

```text
변경이 없으면 2차 fetched/upserted/deleted 0
messages 중복 0
folders 중복 0
외부 Outlook 변경 0
```

백업:

```bash
npm run memory:backup
npm run memory:integrity
```

복원은 live DB가 아닌 owner-only 격리 복사본에 수행한다.

재시작:

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
```

확인:

```text
messages 359 유지 또는 설명 가능한 Delta 변화
classifications 유지
provider 상태 유지
Delta cursor 유지
backup history 유지
```

## 16. 30분 안정성

최소 30분, 1분 간격으로 기록한다.

```text
두 서비스 active
NRestarts
CPU/RSS
WAL 크기
operator_jobs
Dead letters
fatal/unhandled
Graph 429/5xx
무한 retry
```

PASS:

```text
Unexpected restart 0
Fatal/unhandled 0
무한 retry 0
설명 불가능한 dead letter 증가 0
지속적 WAL/RSS runaway 없음
```

## 17. 최종 판정

### GO

모두 충족:

```text
안전선 PASS
한국어 reply boundary PASS
동일 50건 목표 PASS
동일 10개 Top-5 >=90%
Evidence 100%
Provider 회귀 PASS
Delta·backup·restart PASS
30분 안정성 PASS
```

### CONDITIONAL GO

제품 외부의 Grok 결제 잔액만 남고 Grok이 정확히 unavailable로 격리되며, 모든 분류·검색·Evidence·안전 기준이 PASS한 경우에만 허용한다.

### NO-GO

다음 중 하나:

```text
Work State <95%
Next Actor <95%
Reference false-action >2%
Important miss >3%
Evidence <100%
history Evidence 재현
sent request ACTION/ME 재현
자동 알림 false action 재현
Top-5 <90%
계약완료 0건
비밀·raw provider 오류 노출
안전선 위반
데이터 손실·중복
```

## 18. 보고서 형식

```text
1. 최종 판정
2. 안전선·기준선
3. 자동 게이트
4. 한국어 Outlook current/history
5. 보낸 편지함 상태·Actor
6. 완료·Reference·자동 알림
7. 영문 기술 요청
8. Due·Signal·Priority
9. Evidence 전수검사
10. 동일 50건 Ground Truth
11. 동일 10개 Top-5
12. Provider 회귀
13. Delta·백업·재시작
14. 30분 안정성
15. 결함·심각도·최소 수정안
16. 최종 GO/CONDITIONAL GO/NO-GO 근거
```

메일 전문, Token, Access Key, Cookie, Client Secret, OAuth Credential을 보고서에 포함하지 않는다.
