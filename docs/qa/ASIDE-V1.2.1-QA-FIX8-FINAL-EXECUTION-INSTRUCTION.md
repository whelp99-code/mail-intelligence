# Aside 실행 지시서 — Mail Intelligence v1.2.1 qa-fix8 최종 독립 QA

아래 지시를 처음부터 끝까지 순서대로 수행한다. 중간에 개발자의 주장이나 기존 PASS 로그를 신뢰하지 말고, 독립적으로 재현한 증거만 최종 판정에 사용한다.

## 1. 역할과 목표

너의 역할은 다음과 같다.

```text
Independent QA
Blind Ground Truth Reviewer
Adversarial Tester
Production Readiness Reviewer
Release Gatekeeper
```

대상:

```text
projectId       mail-intelligence
workername      mailintelligence
path            /home/jm/orca/projects/mail-intelligence
branch          main
package         1.2.1
classifier      precision-classification-v1.2.1-qa-fix8
search          intelligent-search-v1.2.1-qa-fix8
backend         127.0.0.1:3010
tailnet         100.87.81.57:3010
```

최종 목표는 qa-fix8의 실운영 가능 여부를 다음 중 하나로 판정하는 것이다.

```text
GO
CONDITIONAL GO
NO-GO
BLOCKED
```

최종 보고서 파일:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-fix8-report.md
```

## 2. 권위 문서

작업 시작 전에 아래 문서를 전부 읽는다.

```text
AGENTS.md
README.md
docs/planning/V1.2.1-QA-FIX8-MEANING-SEARCH-DESIGN.md
docs/releases/v1.2.1-QA-FIX8-IMPLEMENTATION-REPORT.md
docs/qa/ASIDE-V1.2.1-QA-FIX8-BLIND-REVALIDATION-INSTRUCTIONS.md
이 실행 지시서 전체
```

이 실행 지시서는 전달용 요약이다. 실제 세부 절차와 의미 기준은 `ASIDE-V1.2.1-QA-FIX8-BLIND-REVALIDATION-INSTRUCTIONS.md`를 따른다. 충돌이 있으면 더 엄격한 조건을 적용한다.

qa-fix7 독립 QA 보고서도 읽고 실패 유형을 기준선으로 사용한다. 특히 다음 문제가 qa-fix8에서 실제로 일반화됐는지 검증한다.

```text
지원 문의의 완료·종료 승인·외부 회신 대기 경계
반송·입찰·서비스 비활성화·라이선스 장애의 Action 보존
발신 전달 완료와 외부 회신 대기 구분
자동 결제·세금계산서·청구서·카드 명세 경계
GPU·노드·보안 사건의 Priority 보존
복합 자연어 검색의 직접 관련성
```

## 3. 절대 금지 사항

다음을 수행하지 않는다.

```text
src/, scripts/, test/, package.json, package-lock.json 수정
기존 Ground Truth 라벨 수정
Blind 평가 전에 현재 시스템 예측 열람
정답에 맞추기 위한 예외 규칙 추가
git reset, clean, checkout
commit 또는 push
메일 발송·답장·전달
읽음 상태 변경
메일 이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
실메일을 외부 AI로 신규 전송
Access Token, Refresh Token, Client Secret, Access Key, Cookie 출력
메일 전문 또는 개인정보를 최종 보고서에 복사
```

결함이 발견되면 소스를 고치지 말고 다음만 기록한다.

```text
재현 절차
비식별 hash
expected / actual
영향
심각도
최소 수정 제안
재검증 조건
```

## 4. 개발자 측 선행 주장

다음은 참고 정보이며 독립 PASS 증거가 아니다.

```text
Ubuntu 서비스 재배포·재시작 완료 주장
mail-intelligence.service active/running 주장
mail-intelligence-tailnet.service active/running 주장
NRestarts=0 주장
classifier=precision-classification-v1.2.1-qa-fix8 주장
search=intelligent-search-v1.2.1-qa-fix8 주장
개발자 안정성 요약=data/tmp/qa-fix8-stability-summary.json
개발자 안정성 결과=COMPLETE, 31/31, 1,803초 주장
```

모두 직접 재확인한다. 개발자 안정성 결과가 있어도 최종 독립 QA에서는 별도의 31회 관찰을 수행한다.

## 5. 시작 조건과 Source Snapshot

프로젝트 루트로 이동한다.

```bash
cd /home/jm/orca/projects/mail-intelligence
```

시작 즉시 아래 값을 파일과 보고서 초안에 기록한다.

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-list --left-right --count HEAD...origin/main
git diff --check
git diff --binary HEAD | sha256sum
find src scripts test package.json package-lock.json \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
```

작업 트리가 Dirty여도 임의 정리하지 않는다. 시작 snapshot과 종료 snapshot이 완전히 같아야 한다. 검증 중 소스가 바뀌면 결과는 `BLOCKED` 또는 `검증 무효`로 처리한다.

## 6. Live 대상 확인

Blind 라벨링 전에 먼저 실행한다.

```bash
npm run verify:live:local
npm run verify:tailnet
npm run verify:stability:status
systemctl --user show mail-intelligence.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp
systemctl --user show mail-intelligence-tailnet.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp
ss -ltnp | grep ':3010'
```

필수 조건:

```text
precisionClassificationVersion=precision-classification-v1.2.1-qa-fix8
intelligentSearchVersion=intelligent-search-v1.2.1-qa-fix8
두 서비스 active/running
safetyMode=read-only
externalActionsAllowed=false
127.0.0.1:3010 listener 존재
100.87.81.57:3010 listener 존재
0.0.0.0:3010 없음
[::]:3010 없음
public listener 없음
Tailscale Funnel 없음
```

버전 불일치, 서비스 실패, 공개 노출 또는 안전선 위반이면 Blind 라벨링을 시작하지 말고 `BLOCKED` 또는 `CRITICAL FAIL / NO-GO`로 종료한다. 소스를 수정하거나 재배포하지 않는다.

## 7. 안전선 검증

최종 실행 프로세스에서 다음 플래그가 모두 `0`인지 확인한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

허용 Graph scope:

```text
User.Read
Mail.Read
openid
profile
offline_access
```

금지 scope:

```text
Mail.Send
Mail.ReadWrite
```

하나라도 위반하면 즉시 `NO-GO`다.

## 8. DB 및 자동 게이트

다음을 실행한다.

```bash
npm run memory:status
npm run memory:integrity
npm run verify:qa:operational
npm run verify:v1.2.1
npm run verify:snapshot
npm run verify:qa:known-acceptance
npm run verify:live:local
npm run verify:tailnet
npm audit --audit-level=high
git diff --check
```

최소 기준:

```text
schema 4
quick_check ok
foreign-key 오류 0
active messages = active classifications
duplicate active graph ID 0
활성 classifier version 전부 qa-fix8
Evidence exact 100%
node:test 실패 0
Precision fixture 20/20
Precision assertions 77/77
OAuth focused 9/9
ESLint PASS
HTMLHint PASS
Stylelint PASS
Safety PASS
Repository hygiene PASS
npm audit 취약점 0
Working-copy snapshot PASS
```

자동 게이트는 Blind QA를 대체하지 않는다.

## 9. 기존 Ground Truth 감사와 알려진 회귀

기존 라벨을 수정하지 않은 상태에서 실행한다.

```bash
npm run qa:ground-truth:audit
npm run qa:ground-truth:policy-audit
npm run evaluate:independent:round3
npm run evaluate:independent:qafix6-blind
npm run evaluate:independent:qafix7-incident
npm run evaluate:independent:qafix5-blind:report
npm run evaluate:independent:qafix7-blind
```

구분:

```text
Hard gate:
- Round 3
- qa-fix6 Blind
- qa-fix7 incident

Report-only:
- qa-fix5 Blind
- qa-fix7 Main Blind
```

정책 충돌을 숨기거나 기존 라벨을 고치지 않는다. Report-only 실패도 최종 보고서에 그대로 기록한다.

## 10. 신규 Main Blind 50건

대상 manifest:

```text
data/qa/qa-fix8-blind-holdout-template.json
```

먼저 SHA-256, 권한, 50개 unique hash, known hash overlap 0, 원문·예측 미포함을 확인한다.

라벨 동결 전에는 현재 분류 UI, classification API, `precision_classifications`, evaluator 결과를 절대 보지 않는다.

각 index를 원문 정보만 보고 순서대로 검토한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/qa-fix8-blind-holdout-template.json \
  --index 1
```

`--index 1`부터 `--index 50`까지 반복한다.

각 표본에 다음 값을 독립적으로 작성한다.

```text
workState
nextActor
priority
reference
important
reviewerNote
```

Ground Truth 의미:

```text
ACTION_REQUIRED  현재 사용자가 해야 할 구체적 행동
WAITING          사용자가 이미 처리했고 다른 주체의 행동을 기다림
DECISION_REQUIRED 승인·선택·결정 필요
COMPLETED        현재 사건 종료, 후속 요청 없음
REFERENCE        참고·기록·광고·저가치 자동 알림, 행동 없음
REVIEW_REQUIRED  현재 정보만으로 상태 또는 Actor 확정 불가
```

50건 입력 후에만 finalize한다.

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix8-blind-holdout-template.json \
  --output data/qa/qa-fix8-blind-holdout-labels.json \
  --reviewer aside-independent-qafix8 \
  --expected-count 50
chmod 0400 data/qa/qa-fix8-blind-holdout-labels.json
sha256sum data/qa/qa-fix8-blind-holdout-labels.json
```

Label SHA를 기록한 뒤 최초로 채점한다.

```bash
npm run evaluate:independent -- \
  --labels data/qa/qa-fix8-blind-holdout-labels.json \
  --recompute \
  --include-deleted \
  --expected-count 50
```

합격 기준:

```text
Work State             >=95%, 최소 48/50
Next Actor             >=95%, 최소 48/50
Priority               >=95%, 최소 48/50
Reference false-action <=2%, 최대 1건
Important Priority Miss <=3%
Important Action Miss   <=3%
```

평가 스크립트 결과만 복사하지 말고 expected와 actual에서 Important Priority Miss와 Important Action Miss를 별도 코드로 다시 계산한다.

모든 mismatch는 메일 전문 없이 hash, stratum, expected, actual, false-action, important miss, 오류 유형으로 표에 기록한다.

## 11. Incident/Security 보충 Blind

대상 manifest:

```text
data/qa/qa-fix8-incident-security-supplement-template.json
```

현재 예상 상태는 requested 5, available 4, complete false다. 먼저 직접 확인한다.

4건을 예측 없이 독립 라벨링하고 동결·채점한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/qa-fix8-incident-security-supplement-template.json \
  --index 1
```

전체 입력 후:

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix8-incident-security-supplement-template.json \
  --output data/qa/qa-fix8-incident-security-supplement-labels.json \
  --reviewer aside-independent-qafix8-incident \
  --expected-count 4
chmod 0400 data/qa/qa-fix8-incident-security-supplement-labels.json
sha256sum data/qa/qa-fix8-incident-security-supplement-labels.json

npm run evaluate:independent -- \
  --labels data/qa/qa-fix8-incident-security-supplement-labels.json \
  --recompute \
  --include-deleted \
  --expected-count 4
```

기존 4건은 Work State, Next Actor, Priority가 모두 4/4여야 한다. 하나라도 실패하면 `NO-GO`다.

개발자가 보지 않은 실제 incident/security 신규 표본을 1건 더 확보해 총 5/5를 검증하지 못하면 최종 판정 상한은 `CONDITIONAL GO`다. 표본 부족을 임의 합성 데이터나 기존 표본 재사용으로 채우지 않는다.

## 12. 검색 독립 평가

먼저 결과를 보지 않은 상태에서 Hidden 자연어 질의 5개를 작성하고 별도 파일에 저장한 뒤 SHA-256을 고정한다.

Hidden 질의 유형:

```text
특정 고객·프로젝트
외부 회신 대기
완료된 지원 사건
검토할 문서
장애·보안 사건
```

그 후 기존 고정 20개와 Hidden 5개, 총 25개 질의를 평가한다.

고정 20개:

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
완료된 Sangfor 지원 문의
대기 중인 라이선스 회신
카드 한도 초과 위험
Confluence 비활성화
공유 폴더 이메일 인증
```

각 질의의 Top-5를 원문 기준으로 `Direct / Partial / Wrong`으로 판정한다.

합격 기준:

```text
Top 결과 직접 관련 비율 >=90%
사용 가능한 질의       >=90%
광고 결과               0
삭제·정크 결과          0
incident 보험·세금계산서 noise 0
semantic intent 직접 근거 위반 0
```

자동 `verify:qa:search` PASS를 독립 relevance PASS로 간주하지 않는다.

## 13. Evidence·Provider OFF·Delta·백업·재시작

다음을 모두 직접 재현한다.

```bash
npm run verify:qa:operational
npm run verify:live:delta-twice
npm run memory:backup
npm run memory:integrity
npm run verify:backup:isolated
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
npm run verify:tailnet
```

필수 결과:

```text
Evidence exact span 100%
source hash 100%
invalid offset 0
sourceMessageId mismatch 0
history Evidence 0
placeholder 0
Provider OFF: policy_blocked / EXTERNAL_AI_DISABLED / Rules fallback
Provider audit event 증가 0
외부 AI 전송 0
Delta 20/20 folders, failed 0, errors 0
두 번째 실행 중복 증가 0
external Outlook writes 0
백업·복원 SHA 일치
restore directory 0700
restore DB 0600
운영 DB 교체 없음
재시작 후 두 서비스 active/running
NRestarts=0
qa-fix8 버전 유지
DB count·cursor·안전 플래그 유지
```

서비스 정상 재시작 1회 외 추가 운영 변경은 하지 않는다.

## 14. 독립 안정성 관찰

개발자 측 안정성 파일을 그대로 PASS 처리하지 않는다. 최종 재시작 후 60초 간격 31회, 최소 30분을 독립 관찰한다.

프로젝트에 포함된 관찰 도구를 사용할 수 있다.

```bash
npm run verify:stability:start
npm run verify:stability:status
```

단, 관찰 도구의 자동 판정만 복사하지 말고 JSONL 및 systemd/journal 값을 표본별로 독립 확인한다.

기록:

```text
Backend/Tailnet health
두 PID
NRestarts
CPU/RSS
SQLite WAL
active messages/classifications
qa-fix8 version purity
operator jobs
dead letters
fatal/unhandled/uncaught/OOM
Graph 반복 오류
OAuth 반복 오류
```

합격 기준:

```text
31/31 healthy
unexpected restart 0
service·read-only contract failure 0
DB count mismatch 0
version purity failure 0
integrity failure 0
duplicate Graph ID 0
fatal/unhandled/OOM 0
무한 retry 0
설명 불가능 dead-letter 증가 0
WAL runaway 없음
RSS runaway 없음
```

## 15. 종료 불변성

시작 시 기록한 모든 snapshot과 Manifest/Label SHA를 종료 시 다시 계산한다.

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --binary HEAD | sha256sum
find src scripts test package.json package-lock.json \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
sha256sum data/qa/qa-fix8-blind-holdout-template.json
sha256sum data/qa/qa-fix8-blind-holdout-labels.json
sha256sum data/qa/qa-fix8-incident-security-supplement-template.json
sha256sum data/qa/qa-fix8-incident-security-supplement-labels.json
```

Source snapshot 또는 라벨 SHA가 바뀌면 검증은 무효다.

## 16. 최종 판정

`GO`는 다음이 전부 충족될 때만 허용한다.

```text
Live classifier/search qa-fix8
전체 자동 게이트 PASS
신규 Main Blind PASS
Incident/Security 신규 5/5 PASS
Evidence 100%
검색 직접 관련 >=90%
Provider OFF PASS
Delta PASS
백업·격리 복원 PASS
재시작 지속성 PASS
31회 안정성 PASS
안전선 위반 0
Source·Label 불변
```

`CONDITIONAL GO`는 다른 모든 항목이 PASS했지만 개발자가 보지 않은 incident/security 실제 표본이 4건뿐이고 다섯 번째 표본을 확보하지 못한 경우에만 허용한다.

조건:

```text
장애·보안 분류를 자동 실행에 사용하지 않음
REVIEW_REQUIRED/HIGH 또는 사용자 직접 검토 유지
메일 자동 행동 계속 차단
다섯 번째 실제 표본 유입 즉시 재검증
```

다음 중 하나면 `NO-GO`다.

```text
Main Blind 기준 미달
기존 Incident/Security 4건 중 하나라도 실패
Evidence <100%
검색 <90%
Reference false-action >2%
Important miss >3%
현재/과거 본문 오염
외부 Outlook 쓰기
데이터 중복·손실
재시작·안정성 실패
안전선 위반
```

다음이면 `BLOCKED`다.

```text
qa-fix8 live version 불일치
서비스·DB·계정·필수 파일 접근 불가
Source snapshot이 검증 중 변동
Blind 라벨 동결 전에 Prediction 노출
재배포 또는 소스 수정이 필요한 상태
```

## 17. 최종 보고서 필수 구조

보고서는 다음 순서로 작성한다.

```text
1. 최종 판정
2. 대상 Commit·Source Snapshot
3. qa-fix8 Live Version
4. 안전선
5. 서비스·DB 기준선
6. 전체 자동 게이트
7. Ground Truth conflict/policy audit
8. 알려진 회귀
9. Main manifest·독립 라벨 동결
10. Main Blind 최초 채점
11. Main mismatch 전체 표
12. Incident/Security supplement
13. Evidence 전수검사
14. 검색 25개 독립 평가
15. Provider OFF
16. Outlook Delta 2회
17. 백업·격리 복원
18. 재시작 지속성
19. 독립 31회 안정성
20. Source·Label 불변성
21. 남은 문제와 최소 수정안
22. GO / CONDITIONAL GO / NO-GO / BLOCKED 근거
```

최종 보고서에는 메일 전문, 계정 정보, Token, Secret, Key, Cookie를 포함하지 않는다. 개인 정보는 hash 또는 비식별 축약으로만 남긴다.

작업을 중간 보고로 끝내지 말고 최종 보고서 파일을 생성한 뒤, 사용자에게 최종 판정과 보고서 경로만 명확히 전달한다.
