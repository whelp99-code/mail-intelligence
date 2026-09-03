# Aside 최종 독립 검증 지시서 — Mail Intelligence v1.2.1 qa-fix7

## 0. 역할

너는 개발자가 아니라 다음 역할이다.

```text
Independent QA
Blind Ground Truth Reviewer
Adversarial Tester
Production Readiness Reviewer
Release Gatekeeper
```

개발자의 `PASS`, `GO_CANDIDATE`, 알려진 벤치마크 결과를 사실로 간주하지 않는다. 직접 재현한 증거만 사용한다. 소스 코드는 수정하지 않는다.

최종 보고서:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-fix7-report.md
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
classifier      precision-classification-v1.2.1-qa-fix7
search          intelligent-search-v1.2.1-qa-fix7
backend         127.0.0.1:3010
tailnet         100.87.81.57:3010
```

Main Blind:

```text
data/qa/qa-fix7-blind-holdout-template.json
50 samples
known 150 excluded
```

Incident/security supplement:

```text
data/qa/qa-fix7-incident-security-supplement-template.json
5 samples
known 150 + Main Blind 50 excluded
```

## 2. Source of Truth

먼저 전체를 읽는다.

```text
AGENTS.md
README.md
mail-intelligence-v1.2.1-independent-qa-fix6-report.md
docs/planning/V1.2.1-QA-FIX7-EVENT-CLASSIFICATION-DESIGN.md
docs/releases/v1.2.1-QA-FIX7-IMPLEMENTATION-REPORT.md
이 문서
```

qa-fix6의 `NO-GO`와 동결 Ground Truth를 재해석하거나 변경하지 않는다.

## 3. 소스 동결

현재 변경은 아직 Commit되지 않았을 수 있다. 시작 시 기록한다.

```bash
cd /home/jm/orca/projects/mail-intelligence

git status --short
git branch --show-current
git rev-parse HEAD
git rev-list --left-right --count HEAD...origin/main
git diff --check

git diff --binary HEAD | sha256sum
find src scripts test package.json package-lock.json \
  -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum | sha256sum
```

종료 시 동일 명령을 다시 실행한다. Source Snapshot이 바뀌면 검증은 무효다.

검증 중 변경 금지:

```text
src/
scripts/
test/
package.json
package-lock.json
기존 frozen Ground Truth
Main Blind Manifest
Incident supplement Manifest
```

## 4. 절대 안전선

최종 환경변수는 모두 0이어야 한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

허용 Graph Scope:

```text
User.Read
Mail.Read
openid
profile
offline_access
```

금지:

```text
Mail.Send
Mail.ReadWrite
메일 발송·답장·전달
읽음 변경
이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
신규 실메일 외부 LLM 전송
```

안전선 위반은 즉시 `CRITICAL FAIL / NO-GO`다.

## 5. 서비스·DB 기준선

```bash
systemctl --user is-enabled mail-intelligence.service
systemctl --user is-active mail-intelligence.service
systemctl --user is-enabled mail-intelligence-tailnet.service
systemctl --user is-active mail-intelligence-tailnet.service
systemctl --user show mail-intelligence.service -p MainPID -p NRestarts -p ActiveEnterTimestamp
systemctl --user show mail-intelligence-tailnet.service -p MainPID -p NRestarts -p ActiveEnterTimestamp
ss -ltnp | grep ':3010'

npm run memory:status
npm run memory:integrity
```

허용 Listener:

```text
127.0.0.1:3010
100.87.81.57:3010
```

금지 Listener:

```text
0.0.0.0:3010
[::]:3010
공인 인터페이스
Tailscale Funnel
```

운영 DB 수치는 신규 메일에 따라 변할 수 있으므로 숫자 자체가 아니라 다음 계약을 검증한다.

```text
active messages == active classifications
duplicate active graph ID == 0
schema == 4
quick_check == ok
foreign_key_check == 0
active prompt_version == qa-fix7 only
```

SQL:

```bash
sqlite3 data/mail-intelligence.sqlite "
SELECT
  (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS active_messages,
  (SELECT COUNT(*) FROM precision_classifications pc JOIN messages m ON m.id=pc.message_id WHERE m.deleted_at IS NULL) AS active_classifications;
"

sqlite3 data/mail-intelligence.sqlite "
SELECT prompt_version, COUNT(*)
FROM precision_classifications pc
JOIN messages m ON m.id=pc.message_id
WHERE m.deleted_at IS NULL
GROUP BY prompt_version;
"
```

이전 qa-fix6 이하 active classification이 1건이라도 남으면 FAIL이다.

## 6. 자동 Gate

```bash
npm run verify:v1.2.1
npm run verify:snapshot
npm run verify:qa:operational
npm run verify:qa:search
npm run verify:live:local
npm run verify:tailnet
npm run memory:integrity
npm audit --audit-level=high
git diff --check
```

기대:

```text
node:test            271 이상, 실패 0
Precision            20 fixtures / 77 assertions
OAuth                9/9
ESLint               PASS
HTMLHint             PASS
Stylelint            PASS
Health               PASS
Safety               PASS
npm audit            0 vulnerabilities
snapshot npm ci      PASS
```

`verify:fresh`가 uncommitted source를 이유로 차단되는 것은 정상이다. Commit 전 검증에서는 `verify:snapshot`을 사용한다. 최종 릴리스 Commit 후에는 `verify:fresh`도 다시 실행해야 한다.

## 7. 알려진 150건 회귀

먼저 라벨 무결성·충돌을 확인한다.

```bash
npm run qa:ground-truth:audit
```

기대:

```text
unique hashes           150
messages found          150
missing                 0
historical tombstones   included
labels mutated          false
```

동일 Microsoft 청구서 템플릿과 오래된 삭제 Draft에 qa-fix5와 qa-fix6의 동결 라벨 충돌이 존재한다. 이를 수정하거나 숨기지 않는다.

Release gate:

```bash
npm run evaluate:independent:round3
npm run evaluate:independent:qafix6-blind
```

각 세트 합격 기준:

```text
found                    50/50
Work State               >=95%
Next Actor               >=95%
Priority                 >=95%
Reference false-action   <=2%
Important Priority Miss  <=3%
Important Action Miss    <=3%
```

qa-fix5 Blind는 충돌 감사용 report-only다.

```bash
npm run evaluate:independent:qafix5-blind:report
```

report-only 결과를 최종 GO gate로 사용하지 않는다.

## 8. Main Blind Manifest 무결성

```bash
sha256sum data/qa/qa-fix7-blind-holdout-template.json
stat -c '%a %n' data/qa/qa-fix7-blind-holdout-template.json
```

확인:

```text
samples                   50
unique                    50
known 150 overlap          0
containsMessageContent     false
containsStoredPredictions  false
mode                       0600
classifierVersion          qa-fix7
```

정상 Manifest는 재생성하지 않는다.

## 9. Main Blind 라벨링

라벨 동결 전 절대 열람 금지:

```text
현재 Work State
현재 Next Actor
현재 Priority
현재 Classification UI
precision_classifications의 대상 결과
/api/intelligence/classification 결과
evaluate:independent 결과
```

원문만 한 건씩 확인한다.

```bash
for i in $(seq 1 50); do
  npm run qa:holdout:inspect -- \
    --manifest data/qa/qa-fix7-blind-holdout-template.json \
    --index "$i"
done
```

Inspector에 현재 시스템 예측이 노출되면 검증을 중단한다.

각 표본에 입력:

```text
workState
nextActor
priority
reference
important
reviewerNote
```

### 상태 정의

```text
ACTION_REQUIRED
- 현재 사용자가 실제로 해야 할 구체적 행동

WAITING
- 사용자가 이미 요청·전달·회신했고 다른 주체의 다음 행동을 기다림

DECISION_REQUIRED
- 선택·승인·결정이 명시적으로 필요

COMPLETED
- 현재 업무가 해결·완료·종료됐고 별도 후속 요청이 없음

REFERENCE
- 참고·기록·광고·자동 완료·낮은 가치의 자동 알림

REVIEW_REQUIRED
- 업무 가능성은 있지만 현재 정보만으로 확정 불가
```

### 핵심 의미 경계

```text
Support 해결·종료 통보
→ COMPLETED / NONE

Support 종료 승인 요청
→ ACTION_REQUIRED / ME

Support 일정 확정
→ WAITING / EXTERNAL_PARTY

서비스 비활성화 예정
→ ACTION_REQUIRED / ME

카드 한도·쿼터 초과 위험
→ ACTION_REQUIRED / ME

공유 폴더 접근 이메일 인증
→ ACTION_REQUIRED / ME

Bill36524 확인 완료
→ REFERENCE / NONE / LOW

신규 전자세금계산서 검토 필요
→ REVIEW_REQUIRED / UNKNOWN / NORMAL

발신 자료·답변 전달만 존재
→ COMPLETED / NONE

발신 전달 후 수신자 확인·회신 요청
→ WAITING / EXTERNAL_PARTY

active 보안 침해·서비스 중단
→ ACTION_REQUIRED / ME / CRITICAL
```

법적 Disclaimer, 조건부 Footer, 과거 인용문은 현재 Action·Priority 근거가 아니다.

## 10. Main Blind 동결·최초 채점

50건 라벨을 모두 작성한 후:

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix7-blind-holdout-template.json \
  --output data/qa/qa-fix7-blind-holdout-labels.json \
  --reviewer aside-independent-qafix7 \
  --expected-count 50

chmod 0400 data/qa/qa-fix7-blind-holdout-labels.json
sha256sum data/qa/qa-fix7-blind-holdout-labels.json
```

라벨 SHA를 기록한 뒤 최초 채점:

```bash
npm run evaluate:independent -- \
  --labels data/qa/qa-fix7-blind-holdout-labels.json \
  --recompute \
  --expected-count 50
```

합격 기준:

```text
Work State               >=95%  # 최소 48/50
Next Actor               >=95%  # 최소 48/50
Priority                 >=95%  # 최소 48/50
Reference false-action   <=2%   # 최대 1/50
Important Priority Miss  <=3%
Important Action Miss    <=3%
```

채점 후 라벨 변경은 검증 무효다.

## 11. Incident/security 5건 보충 Blind

무결성:

```bash
sha256sum data/qa/qa-fix7-incident-security-supplement-template.json
stat -c '%a %n' data/qa/qa-fix7-incident-security-supplement-template.json
```

기대:

```text
samples                   5
unique                    5
previous 200 overlap       0
containsMessageContent     false
containsStoredPredictions  false
mode                       0600
complete                   true
```

예측을 보지 않고 index 1~5를 라벨링한다.

```bash
for i in $(seq 1 5); do
  npm run qa:holdout:inspect -- \
    --manifest data/qa/qa-fix7-incident-security-supplement-template.json \
    --index "$i"
done
```

동결:

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix7-incident-security-supplement-template.json \
  --output data/qa/qa-fix7-incident-security-supplement-labels.json \
  --reviewer aside-independent-qafix7-incident \
  --expected-count 5

chmod 0400 data/qa/qa-fix7-incident-security-supplement-labels.json
sha256sum data/qa/qa-fix7-incident-security-supplement-labels.json
```

최초 채점:

```bash
npm run evaluate:independent -- \
  --labels data/qa/qa-fix7-incident-security-supplement-labels.json \
  --recompute \
  --expected-count 5
```

5건 보충 세트는 전부 정확해야 PASS다.

```text
Work State       5/5
Next Actor       5/5
Priority         5/5
false-action     0
important miss   0
```

## 12. Evidence 전수검사

```bash
npm run verify:qa:operational
```

추가로 전체 active Evidence를 독립 검사한다.

```text
canonicalSource.slice(startOffset,endOffset) === exactText
sha256(canonicalSource) === sourceHash
```

합격:

```text
Exact span                100%
Hash match                100%
Invalid offset            0
History Evidence          0
Source message mismatch   0
Placeholder               0
```

## 13. 검색 독립 평가

결과를 보기 전에 기존 15개와 겹치지 않는 Hidden 질의 5개를 작성한다.

고정 15개:

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
미국 ITAC 원격 접속 회신
외부 회신 대기 라이선스
완료된 패치 티켓
검토 필요한 세금계산서
HCI 라이선스 장애
```

각 질의 Top-5를 원문으로 평가:

```text
Relevant
Partially Relevant
Wrong
```

합격:

```text
전체 질의 usable >=90%
Top-5 직접 관련 비율 >=90%
Promotional 0
Deleted/Junk 0
Invoice/insurance security garbage 0
완료된 패치 티켓 결과 >=1
HCI 라이선스 장애 결과 >=1
```

## 14. Provider 정책 OFF

External AI를 활성화하지 않는다.

기대:

```text
HTTP 200
ai.status=policy_blocked
ai.code=EXTERNAL_AI_DISABLED
aiError=null
fallback=rules
rulesUsed=true
Provider event 증가 0
외부 AI 전송 0
```

## 15. 실제 Outlook Delta 2회

```bash
npm run verify:live:delta-twice
```

합격:

```text
20/20 folders each run
failed folders 0
errors 0
attachment errors 0
duplicate graph IDs 0
변경 없는 두 번째 run의 upsert/delete 0
외부 Outlook 쓰기 0
```

최초 진단에서 transient attachment metadata 오류가 다시 보이면 원인과 재현 빈도를 보고하고 무조건 PASS 처리하지 않는다.

## 16. 백업·격리 복원

```bash
npm run verify:backup:isolated
```

합격:

```text
schema 4
quick_check ok
foreign-key 0
backup/restore checksum 동일
restore directory 0700
restored DB 0600
active counts 동일
qa-fix7 version purity 100%
live DB replacement false
```

## 17. 재시작

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
npm run verify:tailnet
```

합격:

```text
두 서비스 active/running
NRestarts 0
counts 유지
qa-fix7 only
Delta cursor 유지
Provider OFF 유지
외부 Send 차단 유지
```

## 18. 30분 안정성

1분 간격 31회 관찰한다.

```text
health
backend/tailnet ActiveState
NRestarts
RSS
WAL
messages/classifications
operator jobs
dead letters
fatal/unhandled/uncaught/OOM
```

합격:

```text
health 31/31
unexpected restart 0
fatal/unhandled/OOM 0
DB count 불일치 0
WAL runaway 0
RSS runaway 0
설명 불가능한 dead letter 증가 0
```

## 19. 최종 소스·라벨 불변성

시작 시 Source Snapshot과 종료 시 Snapshot을 비교한다.

Main·Incident label SHA도 채점 전후 동일해야 한다.

다르면 검증 무효다.

## 20. 최종 판정

### GO

모두 충족:

```text
자동 gate PASS
Round3·qa-fix6 known gate PASS
Main Blind PASS
Incident/security 5/5 PASS
Evidence 100%
검색 >=90%
Delta 2회 PASS
백업·격리 복원 PASS
재시작 PASS
30분 안정성 PASS
안전선 위반 0
소스·라벨 불변
```

### CONDITIONAL GO

제품 외부 제약만 남고 해당 기능이 정확히 격리된 경우에만 허용한다. 분류 정확도·검색·Evidence·안전선 실패는 Conditional Go 사유가 될 수 없다.

### NO-GO

다음 중 하나:

```text
Main Blind 기준 미달
Incident/security 오분류
Reference false-action 초과
Important miss 초과
Evidence 100% 미달
검색 기준 미달
DB version 혼재
Ground Truth 사후 변경
Source Snapshot 변경
외부 Outlook 쓰기
서비스·백업·재시작·안정성 실패
```

## 21. 보고서 구조

```text
1. 최종 판정
2. Source Snapshot
3. 안전선
4. 서비스·DB 기준선
5. 자동 gate
6. Ground Truth conflict audit
7. 알려진 회귀
8. Main Blind 무결성·라벨 동결·점수
9. Incident supplement 무결성·라벨 동결·점수
10. 전체 mismatch
11. Evidence
12. 검색 20개
13. Provider OFF
14. Delta 2회
15. 백업·격리 복원
16. 재시작
17. 30분 안정성
18. 소스·라벨 불변성
19. 남은 문제
20. GO / CONDITIONAL GO / NO-GO
```

메일 전문, Token, Access Key, Cookie, OAuth Credential, 개인정보를 보고서에 포함하지 않는다.
