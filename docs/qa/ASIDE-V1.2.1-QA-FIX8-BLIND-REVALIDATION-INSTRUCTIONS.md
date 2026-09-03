# Aside 전용 — Mail Intelligence v1.2.1 qa-fix8 최종 독립 Blind QA 지시서

## 0. 역할

너는 개발자가 아니다.

```text
Independent QA
Blind Ground Truth Reviewer
Adversarial Tester
Production Readiness Reviewer
Release Gatekeeper
```

개발자의 PASS, GO_CANDIDATE, 운영 DB 재분류 완료 주장을 사실로 간주하지 않는다. 직접 재현한 증거만 인정한다.

소스 코드를 수정하지 않는다. 결함을 찾으면 재현 증거, 영향, 최소 수정 제안만 기록한다.

최종 보고서:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-fix8-report.md
```

최종 판정:

```text
GO
CONDITIONAL GO
NO-GO
BLOCKED
```

## 1. 대상

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

## 2. 반드시 먼저 읽을 문서

```text
AGENTS.md
README.md
mail-intelligence-v1.2.1-independent-qa-fix7-report.md
docs/planning/V1.2.1-QA-FIX8-MEANING-SEARCH-DESIGN.md
docs/releases/v1.2.1-QA-FIX8-IMPLEMENTATION-REPORT.md
이 문서 전체
```

qa-fix7의 실패를 기준선으로 사용한다.

```text
Main State                 66%
Main Actor                 70%
Main Priority              76%
Main Important Action Miss 27.27%
Incident State/Actor       60%/60%
Search direct relevance    88%
```

## 3. 검증 시작 전 Live 대상 확인

사용자가 qa-fix8 Ubuntu 서비스 재배포·재시작을 승인했고, 개발자 측 선행 검증은 완료됐다고 보고됐다. 그러나 이 주장은 독립 QA의 PASS 증거가 아니며 반드시 직접 재현한다.

개발자 측 선행 증적은 참고 자료로만 취급한다.

```text
mail-intelligence.service          active/running, NRestarts=0
mail-intelligence-tailnet.service  active/running, NRestarts=0
classifier                        precision-classification-v1.2.1-qa-fix8
search                            intelligent-search-v1.2.1-qa-fix8
stability summary                 data/tmp/qa-fix8-stability-summary.json
reported stability                COMPLETE, 31/31, 1,803 seconds
```

가장 먼저 다음을 직접 실행한다.

```bash
npm run verify:live:local
npm run verify:tailnet
npm run verify:stability:status
systemctl --user show mail-intelligence.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp
systemctl --user show mail-intelligence-tailnet.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp
```

반드시 다음 조건을 만족해야 한다.

```text
precisionClassificationVersion=precision-classification-v1.2.1-qa-fix8
intelligentSearchVersion=intelligent-search-v1.2.1-qa-fix8
두 서비스 active/running
safetyMode=read-only
externalActionsAllowed=false
backend listener=127.0.0.1:3010
Tailnet listener=100.87.81.57:3010
```

다음 중 하나면 `BLOCKED`로 판정하고 Blind 라벨링을 시작하지 않는다.

```text
실행 버전이 qa-fix8이 아님
서비스가 inactive/failed
공개 listener 존재
read-only 안전선 위반
필수 계정·DB·파일 접근 불가
```

개발자 측 안정성 요약이 없거나 불완전한 것만으로 Blind 라벨링을 막지는 않는다. 해당 사실을 기록하고 24절의 독립 31회 안정성 관찰을 처음부터 수행한다.

Aside는 소스를 수정하거나 재배포하지 않는다. Live 버전 불일치나 재배포 필요가 확인되면 `BLOCKED`로 종료하고 배포 담당자에게 반환한다. 23절의 단일 정상 재시작 지속성 검증 외 추가 운영 변경은 수행하지 않는다.

## 4. 소스 동결

검증 대상 소스가 바뀌지 않아야 한다.

시작 시 기록:

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

작업 트리가 Dirty이면 다음 조건으로만 검증한다.

```text
시작 Source Snapshot SHA 기록
검증 중 src/scripts/test/package 파일 수정 금지
종료 시 동일 SHA 확인
SHA가 달라지면 검증 무효
```

정식 Production GO의 권장 기준은 고정 Commit SHA다. 고정 Commit이 없으면 보고서에 명시한다.

## 5. 절대 안전선

최종 환경변수는 모두 `0`이어야 한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

Graph 허용:

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
읽음 상태 변경
이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
신규 실메일 외부 AI 전송
```

하나라도 위반하면 즉시 `CRITICAL FAIL / NO-GO`다.

## 6. 서비스·네트워크 기준선

```bash
systemctl --user is-enabled mail-intelligence.service
systemctl --user is-active mail-intelligence.service
systemctl --user is-enabled mail-intelligence-tailnet.service
systemctl --user is-active mail-intelligence-tailnet.service
systemctl --user show mail-intelligence.service -p MainPID -p NRestarts -p ActiveEnterTimestamp
systemctl --user show mail-intelligence-tailnet.service -p MainPID -p NRestarts -p ActiveEnterTimestamp
ss -ltnp | grep ':3010'
```

허용:

```text
127.0.0.1:3010
100.87.81.57:3010
```

금지:

```text
0.0.0.0:3010
[::]:3010
192.168.x.x 직접 listener
public listener
Tailscale Funnel
```

## 7. DB 기준선

```bash
npm run memory:status
npm run memory:integrity
npm run verify:qa:operational
```

기대:

```text
schema                         4
quick_check                    ok
foreign_key_check              0
active messages/classifications 동일
duplicate active graph IDs     0
active classifier version      qa-fix8 only
Evidence exact                 100%
WAL                            설명 가능한 범위
```

운영 DB의 모든 활성 분류가 qa-fix8인지 직접 확인한다.

```sql
SELECT pc.prompt_version, COUNT(*)
FROM precision_classifications pc
JOIN messages m ON m.id = pc.message_id
WHERE m.deleted_at IS NULL
GROUP BY pc.prompt_version;
```

qa-fix8 이외 활성 버전이 남으면 FAIL이다.

## 8. 전체 자동 게이트

직접 실행:

```bash
npm run verify:v1.2.1
npm run verify:snapshot
npm run verify:qa:known-acceptance
npm run verify:live:local
npm run verify:tailnet
npm run memory:integrity
npm audit --audit-level=high
git diff --check
```

기대 최소값:

```text
node:test                    285 이상, 실패 0
Precision fixture           20/20
Precision assertions        77/77
OAuth focused               9/9
ESLint                       PASS
HTMLHint                     PASS
Stylelint                    PASS
Health                       PASS
Safety                       PASS
Repository hygiene          PASS
npm audit                    0 vulnerabilities
Working-copy snapshot       PASS
```

자동 게이트는 신규 Blind를 대체하지 않는다.

## 9. Ground Truth 충돌 감사

실행:

```bash
npm run qa:ground-truth:audit
npm run qa:ground-truth:policy-audit
```

원칙:

```text
기존 라벨 수정 금지
충돌 숨김 금지
충돌을 점수에서 몰래 제외 금지
report-only 세트와 hard gate 분리
신규 qa-fix8 Blind가 release-deciding gate
```

알려진 정책 충돌 예:

```text
삭제 폴더를 현재 Action으로 라벨링
최근 불완전 삭제 Draft를 즉시 Low Reference로 라벨링
현재 긴급 근거 없는 High
완료된 구매 처리를 Low Reference로 라벨링
```

정책 충돌의 존재 자체는 신규 Blind 실패가 아니다. 그러나 충돌을 숨기거나 기존 라벨을 고치면 검증 무효다.

## 10. 알려진 회귀

### Hard gate

```bash
npm run evaluate:independent:round3
npm run evaluate:independent:qafix6-blind
npm run evaluate:independent:qafix7-incident
```

합격 기준:

```text
각 평가의 모든 threshold PASS
Reference false-action <=2%
Important Priority Miss <=3%
Important Action Miss <=3%
```

### Report-only

```bash
npm run evaluate:independent:qafix5-blind:report
npm run evaluate:independent:qafix7-blind
```

Report-only 세트의 실패를 숨기지 않는다. 예상과 실제, 정책 충돌 여부를 보고서에 기록한다. 최종 승인 여부는 신규 qa-fix8 Blind로 결정한다.

## 11. Main Blind 무결성

대상:

```text
data/qa/qa-fix8-blind-holdout-template.json
benchmarkId=qa-fix8-blind-86e496fb1b8c
samples=50
```

검사:

```bash
sha256sum data/qa/qa-fix8-blind-holdout-template.json
stat -c '%a %n' data/qa/qa-fix8-blind-holdout-template.json
```

필수:

```text
unique hash                    50
known hashes excluded          205
containsMessageContent         false
containsStoredPredictions      false
classifierVersion              qa-fix8
mode                           0600
```

현재 계층 한계를 그대로 기록한다.

```text
draft                         0
lifecycle                     9
automated                    14
outgoing                      9
forwarded_or_replied         16
incident_or_security          0
business_document             0
general_inbound               2
```

이 표집 편향을 숨기지 않는다.

## 12. Main Blind 라벨링

라벨 동결 전에 절대 보면 안 되는 정보:

```text
현재 Work State
현재 Next Actor
현재 Priority
precision_classifications 결과
분류 UI
classification API
현재 evaluator 출력
개발자의 예상 정답
```

한 건씩 원문만 확인한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/qa-fix8-blind-holdout-template.json \
  --index 1
```

`--index 1`부터 `--index 50`까지 반복한다.

Inspector가 다음을 노출하면 즉시 검증을 중단한다.

```text
workState
nextActor
priority
storedClassification
currentPrediction
systemPrediction
```

허용 정보:

```text
제목
발신자
수신자 역할
방향
folder
Draft/lifecycle
currentContent
quotedContent
history boundary
receivedAt
attachment 여부
```

각 표본에 입력:

```text
workState
nextActor
priority
reference
important
reviewerNote
```

## 13. Ground Truth 의미 기준

### Work State

```text
ACTION_REQUIRED
현재 사용자가 해야 할 구체적인 행동이 있음

WAITING
사용자가 이미 요청·전달·회신했고 다른 주체의 다음 행동을 기다림

DECISION_REQUIRED
선택·승인·결정이 필요함

COMPLETED
현재 사건이 종료·해결·전달 완료됐고 후속 요청이 없음

REFERENCE
참고·기록·광고·일반 자동 알림이며 현재 행동이 없음

REVIEW_REQUIRED
업무 가능성은 있지만 현재 정보만으로 정확한 상태·Actor를 확정할 수 없음
```

### Next Actor

```text
ME
INTERNAL_TEAM
EXTERNAL_PARTY
SHARED
NONE
UNKNOWN
```

### Priority

```text
CRITICAL
현재 서비스 중단·보안 침해·치명 incident

HIGH
현재 본문의 긴급·즉시·금일·오늘·내일·48시간 이내 기한
카드·쿼터 초과 위험
현재 업무 중단을 유발하는 라이선스 invalid/expired

NORMAL
일반 업무 요청·대기·검토·완료·업무 기록

LOW
광고·뉴스레터·일반 인증번호·삭제/정크·저가치 자동 알림
```

### Important

```text
놓치면 실제 업무·계약·금액·서비스·고객 대응 손실이 있는 경우 true
Important=true는 반드시 Actionable을 의미하지 않는다.
```

## 14. qa-fix8 핵심 경계 사례

라벨링 시 다음을 별도 표기한다.

### Lifecycle

```text
삭제·정크
→ 현재 업무 Action으로 복구하지 않음

최근 불완전 삭제 Draft
→ REVIEW_REQUIRED 가능
```

### Support

```text
문제 해결·종료 통보
→ COMPLETED

종료 승인 질문
→ ACTION_REQUIRED / ME

상대 지원 일정 확정
→ WAITING / EXTERNAL_PARTY

지원팀이 사용자에게 로그·조치 요청
→ ACTION_REQUIRED / ME

파트너가 외부 Support 주소에 조치 요청하고 사용자는 참조
→ WAITING / EXTERNAL_PARTY
```

### 발신

```text
내가 요청
→ WAITING / EXTERNAL_PARTY

내가 전달만 완료
→ COMPLETED / NONE

내가 전달 후 상대 확인·회신 요청
→ WAITING / EXTERNAL_PARTY
```

### 자동 알림

```text
광고·일반 인증번호
→ REFERENCE / LOW

청구서 준비·확인 완료
→ REFERENCE / LOW

신규 세금계산서 도착
→ REVIEW_REQUIRED / NORMAL

검수·승인 처리 완료
→ COMPLETED / NORMAL

서비스 비활성화 예정
→ ACTION_REQUIRED / NORMAL

카드 한도 위험
→ ACTION_REQUIRED / HIGH

공유 폴더 이메일 인증
→ ACTION_REQUIRED / NORMAL
```

### 수신 문서

```text
견적·제안·계약 문서만 도착
→ REVIEW_REQUIRED

상세 기술 답변과 문서 전달, 후속 요청 없음
→ COMPLETED

장비 정보·현황표
→ REFERENCE

문서 전달 후 직접 검토·회신 요청
→ ACTION_REQUIRED
```

### Priority

```text
Important Notice만 존재
→ 자동 High 금지

과거 인용문에 긴급
→ 현재 High 금지

Disclaimer·Footer
→ Priority 근거 금지
```

## 15. Main 라벨 동결

50건 모두 라벨링한 뒤 실행:

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix8-blind-holdout-template.json \
  --output data/qa/qa-fix8-blind-holdout-labels.json \
  --reviewer aside-independent-qafix8

chmod 0400 data/qa/qa-fix8-blind-holdout-labels.json
sha256sum data/qa/qa-fix8-blind-holdout-labels.json
```

기록:

```text
Reviewer
Finalize 시각
Labels 50/50
Manifest SHA-256
Label SHA-256
File mode 0400
Source snapshot SHA
```

채점 후 Label SHA가 바뀌면 검증 무효다.

## 16. Main 최초 채점

라벨 동결 이후 처음 실행:

```bash
npm run evaluate:independent -- \
  --labels data/qa/qa-fix8-blind-holdout-labels.json \
  --recompute \
  --include-deleted \
  --expected-count 50
```

합격 기준:

```text
Work State accuracy          >=95%  # 최소 48/50
Next Actor accuracy          >=95%  # 최소 48/50
Priority accuracy            >=95%  # 최소 48/50
Reference false-action       <=2%   # 최대 1건
Important Priority Miss      <=3%
Important Action Miss        <=3%
```

평가 스크립트 verdict만 복사하지 말고 expected/actual로 Important miss를 독립 재계산한다.

## 17. Incident/Security 보충 Blind

대상:

```text
data/qa/qa-fix8-incident-security-supplement-template.json
requested=5
available=4
complete=false
```

현재 4건은 예측을 보지 않고 라벨링한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/qa-fix8-incident-security-supplement-template.json \
  --index 1
```

4건 모두 라벨링·동결:

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix8-incident-security-supplement-template.json \
  --output data/qa/qa-fix8-incident-security-supplement-labels.json \
  --reviewer aside-independent-qafix8-incident \
  --expected-count 4

chmod 0400 data/qa/qa-fix8-incident-security-supplement-labels.json
sha256sum data/qa/qa-fix8-incident-security-supplement-labels.json
```

채점:

```bash
npm run evaluate:independent -- \
  --labels data/qa/qa-fix8-incident-security-supplement-labels.json \
  --recompute \
  --include-deleted \
  --expected-count 4
```

4/4 전 항목 정확해야 한다.

그 후 개발자가 보지 않은 incident/security 실제 메일 1건 이상을 추가 확보한다.

권장 사건:

```text
active service outage
GPU/node offline
security alert
license failure causing outage
support incident pending response
```

추가 1건까지 합쳐 5/5를 검증하지 못하면 최종 판정은 최대 `CONDITIONAL GO`다.

## 18. Evidence 전수검사

```bash
npm run verify:qa:operational
```

독립적으로도 검증:

```text
canonicalSource.slice(startOffset,endOffset) === exactText
sha256(canonicalSource) === sourceHash
```

합격:

```text
Exact span                  100%
Source hash                 100%
Invalid offset              0
SourceMessageId mismatch    0
History Evidence            0
Placeholder                 0
```

Evidence가 정확해도 의미 상태가 틀리면 FAIL이다.

## 19. 검색 독립 평가

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

결과를 확인하기 전에 Hidden 질의 5개를 작성하고 SHA-256을 고정한다.

Hidden 유형:

```text
특정 고객·프로젝트
외부 회신 대기
완료된 지원 사건
검토할 문서
장애·보안 사건
```

각 결과 Top-5를 원문 기준으로 평가:

```text
Direct
Partial
Wrong
```

합격:

```text
직접 관련 결과 비율        >=90%
사용 가능한 질의           >=90%
광고 결과                  0
삭제·정크 결과             0
보험·세금계산서 incident noise 0
semantic intent 직접 근거 위반 0
```

특히 확인:

```text
Sangfor IAG
→ 같은 current field에 Sangfor + IAG

검토 필요한 세금계산서
→ REVIEW_REQUIRED + 직접 세금계산서 Evidence

완료된 Sangfor 지원 문의
→ COMPLETED + Sangfor + support 의미

대기 중인 라이선스 회신
→ WAITING + EXTERNAL_PARTY + license 의미

Confluence 비활성화
→ Confluence 직접 근거, Jira 등 타 서비스 제외
```

## 20. Provider OFF

외부 AI를 켜지 않는다.

기대:

```text
HTTP 200
ai.status=policy_blocked
ai.code=EXTERNAL_AI_DISABLED
ai.fallback=rules
ai.rulesUsed=true
aiError=null
Provider audit event 증가 0
외부 AI 전송 0
```

raw token, stderr, JSONL, stack trace가 없어야 한다.

## 21. Outlook Delta 두 번

```bash
npm run verify:live:delta-twice
```

기대:

```text
20/20 folders
failed folders 0
errors 0
두 번째 중복 증가 0
실제 변경 없으면 second upsert/delete 0
external Outlook writes 0
duplicate active graph IDs 0
```

## 22. 백업·격리 복원

```bash
npm run memory:backup
npm run memory:integrity
npm run verify:backup:isolated
```

운영 DB를 복원본으로 교체하지 않는다.

합격:

```text
schema 4
quick_check ok
foreign-key 0
backup/restore SHA 일치
restore dir 0700
restore DB 0600
message/classification count 일치
qa-fix8 version purity 100%
```

## 23. 재시작 지속성

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
npm run verify:tailnet
```

확인:

```text
두 서비스 active/running
NRestarts=0
health에 qa-fix8 classifier/search
message/classification 유지
Delta cursor 유지
Provider OFF 유지
안전 플래그 유지
외부 Send 차단 유지
```

## 24. 안정성 31회

1분 간격 31회, 30분 이상 관찰한다.

기록:

```text
Backend health
Tailnet health
PID
NRestarts
CPU/RSS
SQLite WAL
operator jobs
dead letters
fatal/unhandled/uncaught/OOM
Graph 반복 오류
OAuth 반복 오류
```

합격:

```text
31/31 healthy
unexpected restart 0
fatal/unhandled/OOM 0
무한 retry 0
설명 불가능 dead-letter 증가 0
WAL runaway 없음
RSS runaway 없음
```

## 25. 종료 불변성

시작 시 기록한 값을 다시 계산한다.

```bash
git rev-parse HEAD
git status --short
git diff --binary HEAD | sha256sum
find src scripts test package.json package-lock.json \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
sha256sum data/qa/qa-fix8-blind-holdout-labels.json
sha256sum data/qa/qa-fix8-incident-security-supplement-labels.json
```

Source 또는 Label SHA가 변하면 검증 무효다.

## 26. 최종 판정 규칙

### GO

모두 충족:

```text
실행 프로세스 classifier/search qa-fix8
전체 자동 게이트 PASS
신규 Main 50 PASS
Incident/Security 5/5 PASS
Evidence 100%
검색 직접 관련 >=90%
Provider OFF PASS
Delta PASS
백업·복원 PASS
재시작 PASS
31분 안정성 PASS
안전선 위반 0
Source·Label 불변
```

### CONDITIONAL GO

다른 모든 기준은 PASS했지만, 개발자가 보지 않은 incident/security 표본이 4건만 존재해 다섯 번째 실제 표본을 확보하지 못한 경우에만 허용한다.

필수 조건:

```text
장애·보안 결과는 자동 실행에 사용하지 않음
REVIEW_REQUIRED/HIGH 또는 사용자 직접 검토
메일 자동 행동 계속 차단
다섯 번째 실제 표본 유입 후 재검증
```

### NO-GO

다음 중 하나:

```text
Main Blind 기준 미달
incident/security 기존 4건 중 하나라도 실패
Evidence <100%
검색 <90%
Reference false-action >2%
Important miss >3%
현재/과거 본문 오염
Outlook 외부 쓰기
데이터 중복·손실
재시작·안정성 실패
```

### BLOCKED

```text
qa-fix8 서비스 미배포
live health version 불일치
Source snapshot 변동
Prediction이 라벨 동결 전에 노출
필수 파일·계정·접근권한 부재
```

## 27. 보고서 구조

```text
1. 최종 판정
2. 대상 Commit·Source Snapshot
3. qa-fix8 live version
4. 안전선
5. 서비스·DB 기준선
6. 전체 자동 게이트
7. Ground Truth conflict/policy audit
8. 알려진 회귀
9. Main manifest·라벨 동결
10. Main Blind 최초 채점
11. Main mismatch
12. Incident/Security supplement
13. Evidence 전수검사
14. 검색 25개 독립 평가
15. Provider OFF
16. Delta 2회
17. 백업·격리 복원
18. 재시작
19. 31분 안정성
20. Source·Label 불변성
21. 남은 문제
22. GO / CONDITIONAL GO / NO-GO / BLOCKED
```

보고서에 메일 전문, Token, Client Secret, Access Key, Cookie, OAuth Credential을 포함하지 않는다.
