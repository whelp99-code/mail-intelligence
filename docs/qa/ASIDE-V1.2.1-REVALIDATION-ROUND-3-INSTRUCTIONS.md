# Aside Round 3 재검증 지시서 — Mail Intelligence v1.2.1 qa-fix3

## 0. 역할

너는 개발자가 아니다.

```text
Independent QA
Adversarial Tester
Production Readiness Reviewer
UX Tester
```

개발 보고서의 PASS를 사실로 간주하지 않는다. 직접 재현한 증거만 인정한다.

이번 목표는 Round 2의 동일 Ground Truth와 동일 검색 질의에서 qa-fix3이 실제 릴리스 기준을 만족하는지 확인하는 것이다.

최종 산출물:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-round-3-report.md
```

최종 판정:

```text
GO
CONDITIONAL GO
NO-GO
```

## 1. 대상

```text
projectId          mail-intelligence
workername         mailintelligence
path               /home/jm/orca/projects/mail-intelligence
branch             main
runtime version    1.2.1
classifier         precision-classification-v1.2.1-qa-fix3
search             intelligent-search-v1.2.1-qa-fix3
backend            127.0.0.1:3010
Tailnet            http://100.87.81.57:3010
```

## 2. 먼저 읽을 문서

```text
AGENTS.md
README.md
이전 Round 1 독립 QA 보고서
이전 Round 2 독립 QA 보고서
docs/releases/v1.2.1-QA-RERUN-3-REMEDIATION-REPORT.md
본 지시서
```

## 3. 핵심 재검증 원칙

1. Round 2에서 사용한 **동일 50개 message ID/hash와 동일 Ground Truth 라벨**을 그대로 사용한다.
2. qa-fix3 결과를 본 뒤 Ground Truth를 변경하지 않는다.
3. 신규 유입된 메일은 동일 50건 점수에서 제외한다.
4. Round 2와 동일한 10개 검색 질의를 그대로 사용한다.
5. 개발 fixture와 개발자의 latest-50 진단을 독립 점수에 사용하지 않는다.
6. 소스 코드를 수정하지 않는다.
7. 메일 전문·Token·Access Key·Cookie·Client Secret을 보고서에 기록하지 않는다.

Round 2 기준 DB는 361건이었다. qa-fix3 재배포 중 신규 2건이 유입돼 현재 live DB는 363건이다. 반드시 hash로 기존 50건을 선택한다.

## 4. 절대 안전선

최종 실행 환경에서 확인:

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

Graph scope:

```text
허용: openid, profile, offline_access, User.Read, Mail.Read
금지: Mail.Send, Mail.ReadWrite
```

금지 행동:

```text
메일 발송·답장·전달
읽음/안 읽음 변경
이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
```

안전선이 깨지면 즉시 `CRITICAL FAIL / NO-GO`다.

## 5. Git·서비스·DB 기준선

```bash
git status --short
git branch --show-current
git log -5 --oneline
git rev-list --left-right --count HEAD...origin/main
```

기존 dirty worktree를 정리·reset·checkout·clean하지 않는다.

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

허용 listener:

```text
127.0.0.1:3010
100.87.81.57:3010
```

금지:

```text
0.0.0.0:3010
공인 IP
Tailscale Funnel
```

DB:

```bash
npm run memory:status
npm run memory:integrity
```

예상:

```text
active messages             363 전후
active classifications      active messages와 동일
folders                     20
schema                      4
quick_check                 ok
foreign_key errors          0
```

## 6. 자동 게이트

직접 실행:

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

기대:

```text
node:test                   209 이상, 실패 0
Precision fixtures          20/20
Precision assertions        77/77
OAuth focused               8/8
Evidence exact              100%
Operational blockers        0
Search smoke                PASS
취약점                       0
```

자동 게이트는 동일 50건과 수동 Top-5 relevance를 대체하지 않는다.

## 7. qa-fix3 분류 규칙 직접 재현

### 7.1 custom folder의 사용자 발신 메일

Round 2에서 외부 발주·회신 대기 메일 두 건이 `ACTION_REQUIRED / ME`로 남았다.

검증:

```text
보낸 편지함에서 사용자 sender alias를 찾는다.
같은 sender가 custom folder에 있는 메일을 확인한다.
Draft가 아닌 실제 발송 메일은 outgoing이어야 한다.
```

기대:

```text
보낸 요청 → WAITING / EXTERNAL_PARTY
보낸 자료·견적 전달 → WAITING / EXTERNAL_PARTY
Draft → ACTION_REQUIRED / ME 또는 REVIEW_REQUIRED
```

전수 기준:

```text
own-sender non-draft ACTION_REQUIRED/ME = 0
outgoing WAITING actor != EXTERNAL_PARTY = 0
```

### 7.2 incoming 재견적·자료 전달

다음은 새 요청이 없으면 완료다.

```text
본사 확인받아 Renewal 재견적 보내드립니다.
장비 정보 직접 전달 드립니다.
발주서·견적서·자료를 송부드립니다.
```

기대:

```text
COMPLETED / NONE
```

단, 별도 문장으로 `확인/검토 부탁드립니다`가 있으면:

```text
ACTION_REQUIRED / ME
```

### 7.3 전자서명 최종 완료

```text
문서가 최종 완료되었습니다.
```

기대:

```text
COMPLETED / NONE / NORMAL 또는 명시적 중요도
```

`REFERENCE / LOW`로 내리면 실패다.

### 7.4 Ecount 자동 문서 알림

필수 표본:

```text
수신문서보기
이카운트에서 보낸 메일
EFFICIENT CHANGE
Ecount URL
```

새 업무 요청이 없으면:

```text
REFERENCE / NONE / LOW
```

실제 발주서 발행·제출·검수 요청은 Action으로 유지해야 한다.

### 7.5 정보성 thread update

```text
내용 혼선 방지 위해 본문 메일에 수정 게시 합니다.
```

기대:

```text
REFERENCE / NONE / NORMAL
```

### 7.6 직접 연락처·이메일 요청

```text
다른 메일이나 연락처 부탁드립니다.
```

기대:

```text
ACTION_REQUIRED / ME
```

### 7.7 다중 중요 업무

한 메일에 발주, 세금계산서, 계약서 검토 등 구체적인 업무가 둘 이상 있으면 Priority가 HIGH인지 확인한다.

단순 단어 수만으로 HIGH가 되면 안 된다. 실제 요청 Evidence가 최소 두 개 있어야 한다.

### 7.8 빈 Draft·인사말 Draft

본문이 비어 있거나 인사말·서명만 있는 불완전 Draft를 억지로 Action/Completed로 확정하지 않는다.

```text
REVIEW_REQUIRED / UNKNOWN
```

은 정상 보류로 인정한다.

## 8. 동일 50건 Ground Truth 재채점

Round 2의 동일 50개 hash를 모두 찾는다.

```text
found = 50/50
```

이 아니면 평가를 중단하고 `BLOCKED`로 보고한다.

각 건에서 다음을 비교한다.

```text
Expected Work State
Actual Work State
Expected Next Actor
Actual Next Actor
Expected Priority
Actual Priority
Reference false-action
Important miss
Evidence 위치
```

합격 기준:

```text
Work State accuracy          >= 95%
Next Actor accuracy          >= 95%
Priority accuracy            >= 95%
Reference false-action       <= 2%
Important miss               <= 3%
Evidence exact               100%
```

Round 2 대표 오류 각각의 Before/After를 별도 표로 만든다.

```text
외부 대기 2건 ACTION/ME
Reference → Action 1건
실제 요청 → REVIEW/UNKNOWN
완료 안내 → Reference
중요 요청 → normal 또는 reference/low
```

## 9. Evidence 전수검사

전체 active classification을 독립 코드로 다시 검사한다.

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

검증:

```text
canonicalSource.slice(startOffset,endOffset) === exactText
sha256(canonicalSource) === sourceHash
```

합격:

```text
Exact span                   100%
Hash match                   100%
sourceMessageId mismatch     0
invalid offset               0
placeholder                  0
history Evidence             0
```

## 10. 동일 10개 검색 질의

limit 5로 다음을 재실행한다.

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

각 결과를 원문 제목·현재 본문·Work State Evidence로 수동 판정한다.

```text
Relevant
Partial
Wrong
```

특히 `장애`, `보안`은 다음을 확인한다.

허용 근거:

```text
현재 제목의 장애·오류·중단·접속불가·outage·incident
현재 제목의 보안·security·침해·해킹·랜섬웨어·취약점
incident_security signal
Work State exact Evidence의 실제 장애·보안 문맥
VPN과 문제 문맥이 같은 제목 또는 같은 Evidence에 함께 존재
```

금지 noise:

```text
보험·청약서
일반 VPN 임대 계약 완료
세금계산서
광고
삭제·정크
서명·FAQ 단어
서로 다른 Evidence field를 합친 cross-field match
```

합격:

```text
질의 성공                   >= 9/10
promotional result          0
Deleted/Junk result         0
긴급 견적 invoice garbage   0
장애 invoice/insurance      0
보안 invoice/insurance      0
계약완료 결과               1건 이상
발주서 residual             `발주서`
```

## 11. Provider 회귀

Round 2에서 실제 OpenAI Luna는 PASS했고 Grok 잔액 부족은 정확히 격리됐다. qa-fix3은 Provider 실행 방식이 아니라 정책 차단 상태 기록을 수정했다.

### 11.1 실제 테스트 전 임시 승인

실제 Provider 테스트가 허용된 세션에서만:

```bash
npm run oauth:enable -- openai-codex-oauth
```

그 후 합성 입력과 실메일 1건 이하로 확인한다.

```text
OpenAI synthetic           passed
OpenAI real mail           passed
raw JSONL                  0
Token exposure             0
```

### 11.2 정책 OFF가 건강 상태를 덮어쓰지 않는지 확인

테스트 후 반드시:

```bash
bash scripts/activate-user-service.sh
```

으로 안전 플래그를 모두 0으로 되돌린다.

그 상태에서 외부 AI 분석을 시도하면 Rules fallback은 가능하지만, 마지막 실제 Provider 성공 상태가 `PROVIDER_CALL_FAILED`로 덮어써지면 실패다.

사용자 안내:

```text
외부 AI 분석이 운영 정책으로 비활성화됨
Rules 결과 사용
필요할 때만 운영자 승인과 데이터 정책 동의 활성화
```

### 11.3 Grok

잔액 부족이 계속되면:

```text
OAuth authenticated
operational unavailable
BILLING_BALANCE_EXHAUSTED
결제·잔액 확인 안내
raw 오류 노출 0
```

Grok 잔액만 남고 다른 모든 기준이 PASS하면 Conditional Go를 허용할 수 있다.

## 12. Delta·백업·재시작

읽기 전용 Delta 2회:

```text
20 folders
오류 0
변경 없으면 두 번째 upsert/delete 0
중복 message 0
```

백업:

```bash
npm run memory:backup
npm run memory:integrity
```

owner-only QA 디렉터리의 복사본만 restore 검증한다. 운영 DB를 교체하지 않는다.

재시작:

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
```

유지:

```text
messages/classifications
Ground Truth 대상 50건
Provider 상태
Delta cursor
backup manifests
```

## 13. 30분 안정성

최종 안전 플래그 0 상태에서 1분 간격 최소 31회 관찰한다.

```text
두 서비스 active/running
NRestarts 0
fatal/unhandled 0
무한 retry 0
비정상 RSS/WAL 증가 없음
설명 불가능한 dead-letter 증가 없음
```

## 14. 최종 판정

### GO

모두 충족:

```text
동일 50건 모든 정확도 기준 PASS
검색 >= 9/10
Evidence 100%
안전선 PASS
Delta/backup/restart PASS
30분 안정성 PASS
```

### CONDITIONAL GO

Grok 결제 잔액처럼 제품 외부 제약만 남고, 해당 Provider가 정확히 unavailable로 격리되며 다른 모든 기준이 PASS한 경우만 허용한다.

### NO-GO

다음 중 하나:

```text
Work State/Next Actor/Priority <95%
Reference false-action >2%
Important miss >3%
검색 <9/10
Evidence <100%
own-sender ACTION/ME 재발
자동 문서 false-action
장애·보안 noise 재발
안전선 위반
```

## 15. 보고서 형식

```text
1. 최종 판정
2. Round 2 지표와 Round 3 지표 비교
3. 동일 50건 found/score
4. 대표 오분류 Before/After
5. Evidence 전수검사
6. 동일 10개 검색 수동 relevance
7. qa-fix3 신규 규칙 재현
8. Provider 회귀와 최종 안전 플래그
9. Delta·백업·재시작
10. 30분 안정성
11. 안전선
12. 남은 결함과 우선순위
```

소스 코드는 수정하지 않는다. 새 결함을 찾으면 재현 증거와 최소 수정 제안만 기록하고 NO-GO로 보고한다.
