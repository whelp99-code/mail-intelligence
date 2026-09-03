# Aside 실행 지시서 — Mail Intelligence v1.2.2 최종 독립 Release QA

아래 절차를 처음부터 끝까지 순서대로 수행한다. 개발자의 PASS 주장, 기존 자동 테스트 로그, 이전 Blind 결과는 참고 자료일 뿐이다. **Aside가 고정된 Commit을 직접 재현한 증거만 최종 판정에 사용한다.**

## 1. 역할과 최종 산출물

Aside의 역할은 다음과 같다.

```text
Independent QA
Blind Ground Truth Reviewer
Adversarial Tester
Read-only Safety Reviewer
Production Readiness Reviewer
Release Gatekeeper
```

대상 계약:

```text
projectId                mail-intelligence
workername               mailintelligence
path                     /home/jm/orca/projects/mail-intelligence
branch                   main
package                  1.2.2
classifier               precision-classification-v1.2.2-fix9
mail event frame         mail-event-frame-v3
operational projection   operational-classification-v1.2.2
search                   intelligent-search-v1.2.2
mail assistant tools     mail-assistant-tools-v1.2.2
backend                  127.0.0.1:3010
```

최종 판정은 다음 중 하나만 사용한다.

```text
GO
CONDITIONAL GO
NO-GO
BLOCKED
```

최종 보고서:

```text
artifacts/mail-intelligence-v1.2.2-independent-qa-report.md
```

QA 중 생성하는 원문·라벨·측정 파일은 Git에 추가하지 않고 owner-only 경로에만 둔다.

```text
data/qa/v1.2.2-independent/
```

## 2. 권위 문서와 검증 우선순위

검증 시작 전에 아래 문서를 전부 읽는다.

```text
AGENTS.md
README.md
docs/planning/V1.2.2-OPERATIONAL-CLASSIFICATION-STABILIZATION.md
docs/qa/ASIDE-V1.2.1-QA-FIX8-FINAL-EXECUTION-INSTRUCTION.md
이 지시서 전체
```

해석 우선순위:

```text
실행 중 직접 재현한 안전·데이터 증거
> v1.2.2 계획의 운영 위험 계약
> 이 지시서
> 개발자 구현 보고·기존 PASS 로그
```

v1.2.2는 기존 6-state Exact Accuracy만으로 승인하지 않는다. 다음 운영 위험을 우선 판정한다.

```text
Silent Action Miss
False Action
Critical/High False Positive
Uncertain Mail Review Coverage
Evidence Exactness
Search Direct Relevance
Correction Persistence
External Automatic Action Count
```

## 3. 절대 금지 사항

다음을 수행하지 않는다.

```text
src/, scripts/, test/, package.json, package-lock.json 수정
README·문서의 제품 계약 수정
기존 Ground Truth·고정 fixture·label 수정
Blind 라벨 동결 전에 현재 Prediction 열람
메일 hash·회사명 전용 예외 규칙 추가
git reset, git clean, git checkout, git restore
commit, push, rebase, merge, tag
메일 발송·답장·전달
읽음 상태, Flag, Category 변경
메일 이동·삭제
Calendar 이벤트 생성·수정·삭제
CRM·Data Plane 쓰기
실메일 첨부파일을 외부 AI로 자동 전송
Access Token, Refresh Token, Client Secret, Access Key, Cookie 출력
메일 전문·첨부 전문·개인정보를 최종 보고서에 복사
```

결함 발견 시 소스를 고치지 않는다. 다음만 기록한다.

```text
재현 절차
비식별 hash
stratum
expected / actual
operational risk type
영향
심각도
최소 수정 제안
재검증 조건
```

검증 중 소스 수정이나 Prediction 오염이 발생하면 해당 Blind 결과는 무효다.

## 4. 시작 조건과 Commit 고정

프로젝트 루트에서 시작한다.

```bash
cd /home/jm/orca/projects/mail-intelligence
umask 077
mkdir -p data/qa/v1.2.2-independent artifacts
chmod 0700 data/qa/v1.2.2-independent artifacts
```

다음 값을 시작 보고서에 기록한다.

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git diff --check
git diff --binary HEAD | sha256sum
find src scripts test package.json package-lock.json README.md docs/planning/V1.2.2-OPERATIONAL-CLASSIFICATION-STABILIZATION.md \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
```

시작 필수 조건:

```text
branch = main
HEAD = origin/main
HEAD...origin/main = 0 0
tracked source worktree = clean
untracked source file = 없음
```

`data/`, `backups/`, `artifacts/`의 운영·QA 산출물은 허용하되 Git 추적 대상이면 안 된다. Commit 불일치, source dirty, 필수 문서 누락이면 `BLOCKED`로 종료한다. Aside가 소스를 정리하거나 재배포하지 않는다.

## 5. Live 버전·서비스·네트워크 확인

Blind 표본을 보기 전에 다음을 실행한다.

```bash
npm run verify:live:local
npm run verify:tailnet
systemctl --user show mail-intelligence.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp
systemctl --user show mail-intelligence-tailnet.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ActiveEnterTimestamp
ss -ltnp | grep ':3010'
```

직접 확인할 버전:

```text
version=1.2.2
precisionClassificationVersion=precision-classification-v1.2.2-fix9
operationalClassificationVersion=operational-classification-v1.2.2
intelligentSearchVersion=intelligent-search-v1.2.2
mailAssistantToolsVersion=mail-assistant-tools-v1.2.2
```

서비스·노출 필수 조건:

```text
두 user service active/running
safety mode=read-only
externalActionsAllowed=false
backend 127.0.0.1:3010
Tailnet listener는 허용된 Tailnet 주소에만 존재
0.0.0.0:3010 없음
[::]:3010 없음
Public listener 없음
Tailscale Funnel 없음
```

버전이 다르거나 공개 노출이 있으면 `BLOCKED` 또는 안전선 `NO-GO`로 종료한다. Aside가 서비스를 다른 소스로 재배포하지 않는다.

## 6. 절대 안전선

실행 프로세스와 systemd unit의 실제 환경에서 다음이 모두 `0`인지 확인한다.

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

금지 Graph scope:

```text
Mail.Send
Mail.ReadWrite
```

다음 외부 변경은 전 QA 구간에서 반드시 0건이어야 한다.

```text
메일 생성·발송·답장·전달
읽음 상태 변경
이동·삭제
Flag·Category 변경
Calendar 쓰기
CRM·Data Plane 쓰기
자동 외부 AI 전송
```

하나라도 위반하면 즉시 `NO-GO`다.

## 7. 자동 Engineering Gate

다음을 직접 실행하고 전체 로그를 owner-only QA 경로에 저장한다.

```bash
npm ci
npm run verify:v1.2.2 \
  2>&1 | tee data/qa/v1.2.2-independent/verify-v1.2.2.log
npm run verify:snapshot \
  2>&1 | tee data/qa/v1.2.2-independent/verify-snapshot.log
npm run verify:qa:operational
npm run verify:qa:search
npm run verify:qa:v1.2.2
npm run memory:status
npm run memory:integrity
npm audit --audit-level=high
git diff --check
```

최소 기준:

```text
node:test 실패 0
Syntax check PASS
ESLint PASS
HTMLHint PASS
Stylelint PASS
Precision fixture PASS
OAuth focused tests PASS
Health full PASS
Read-only safety PASS
Repository hygiene PASS
v1.2.2 operational safety PASS
Working-copy snapshot PASS
npm audit high 이상 0
```

자동 Gate PASS는 독립 Blind·검색·UX·실운영 검증을 대체하지 않는다.

## 8. DB 무결성·버전 순도·Evidence

운영 DB는 읽기 전용 조회로 다음을 확인한다.

```text
schemaVersion=4
quick_check=ok
foreign_key_check=0
active messages = active classifications
duplicate active graph_id=0
모든 활성 분류 prompt_version=precision-classification-v1.2.2-fix9
correction row와 current projection 참조 무결성 PASS
```

`npm run verify:qa:operational` 결과와 별도 read-only audit를 함께 사용한다.

Evidence 필수 기준:

```text
exact current-source span=100%
sourceHash 일치=100%
normalizationVersion 일치=100%
invalid offset=0
sourceMessageId mismatch=0
quoted/history Evidence=0
placeholder Evidence=0
```

Evidence가 정확해도 의미 분류가 잘못되면 PASS로 간주하지 않는다.

## 9. 알려진 회귀 세트

기존 라벨을 수정하지 않고 현재 Commit에서 재계산한다.

```bash
npm run qa:ground-truth:audit
npm run qa:ground-truth:policy-audit
npm run evaluate:independent:round3
npm run evaluate:independent:qafix5-blind:report
npm run evaluate:independent:qafix6-blind
npm run evaluate:independent:qafix7-blind
npm run evaluate:independent:qafix7-incident
```

구분:

```text
Regression hard gate:
- Round 3 fixed 50
- qa-fix6 fixed Blind 50
- qa-fix7 incident/security fixed set

Historical report-only:
- qa-fix5 Blind
- qa-fix7 Main Blind
```

Hard gate 하나라도 이전 합격 상태에서 회귀하면 `NO-GO`다. 역사적 라벨 충돌과 report-only 실패는 숨기지 않고 보고서에 기록한다.

## 10. 신규 Main Blind 50건 준비

새 표본은 이 v1.2.2 소스를 개발한 사람이 보지 않은 운영 메일이어야 한다. 합성 fixture를 최종 Blind 대신 사용하지 않는다.

먼저 기존 모든 고정 라벨 파일을 exclusion 목록으로 만든다.

```bash
EXCLUDES=(
  test/fixtures/aside-round3-fixed-50.json
  test/fixtures/aside-qafix5-blind-fixed-50.json
  test/fixtures/aside-qafix6-blind-fixed-50.json
)
while IFS= read -r file; do
  EXCLUDES+=("$file")
done < <(find data/qa -maxdepth 2 -type f -name '*labels*.json' ! -path 'data/qa/v1.2.2-independent/*' | sort)
EXCLUDE_CSV=$(IFS=,; printf '%s' "${EXCLUDES[*]}")
```

표본 생성:

```bash
npm run qa:holdout:prepare -- \
  --exclude-labels "$EXCLUDE_CSV" \
  --output data/qa/v1.2.2-independent/main-blind-template.json \
  --seed v1.2.2-independent-main-$(date -u +%Y%m%d) \
  --count 50
chmod 0600 data/qa/v1.2.2-independent/main-blind-template.json
sha256sum data/qa/v1.2.2-independent/main-blind-template.json
```

Manifest 무결성:

```text
samples=50
unique hash=50
known label overlap=0
containsMessageContent=false
containsStoredPredictions=false
classifierVersion=precision-classification-v1.2.2-fix9
mode=0600
```

실제 stratum 분포를 요청 분포와 별도로 기록한다. incident/security가 부족해도 다른 계층을 incident로 가장하지 않는다.

## 11. Blind 라벨링과 Prediction 오염 방지

라벨 동결 전에는 다음을 보지 않는다.

```text
현재 UI의 분류·운영 Lane
/api/intelligence/classification
/api/intelligence/operational-summary
precision_classifications
현재 evaluator 결과
저장된 current prediction
Rules/Luna 판단
```

각 index를 원문 정보만 보고 검토한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/v1.2.2-independent/main-blind-template.json \
  --index 1
```

`--index 1`부터 `--index 50`까지 순차 수행한다. Inspector가 Prediction을 노출하면 즉시 `BLOCKED`다.

Canonical Ground Truth 필드:

```text
workState
nextActor
priority
reference
important
reviewerNote
```

Canonical 의미:

```text
ACTION_REQUIRED   현재 사용자가 해야 할 구체적 행동
WAITING           사용자가 이미 처리했고 다른 주체의 행동을 기다림
DECISION_REQUIRED 승인·선택·결정 필요
COMPLETED         현재 사건 종료, 후속 요청 없음
REFERENCE         참고·기록·광고·저가치 자동 알림, 행동 없음
REVIEW_REQUIRED   현재 정보만으로 상태 또는 Actor를 확정할 수 없음
```

별도 운영 Ground Truth 파일에는 다음을 기록한다.

```text
hash
expectedLane: do_now | waiting | review | archive
uncertain: true | false
importantAction: true | false
highCriticalExpected: true | false
reviewerNote
```

운영 Lane 의미:

```text
DO_NOW   내가 지금 행동하거나 결정해야 함
WAITING  다른 주체의 회신·승인·처리를 기다림
REVIEW   불확실·충돌·신규 업무 문서·위험 가능성을 사람이 확인해야 함
ARCHIVE  높은 확신의 완료·참고이며 후속 행동 가능성이 없음
```

50건 전체 라벨 입력 후에만 finalize한다.

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/v1.2.2-independent/main-blind-template.json \
  --output data/qa/v1.2.2-independent/main-blind-labels.json \
  --reviewer aside-independent-v1.2.2 \
  --expected-count 50
chmod 0400 data/qa/v1.2.2-independent/main-blind-labels.json
chmod 0400 data/qa/v1.2.2-independent/main-operational-labels.json
sha256sum data/qa/v1.2.2-independent/main-blind-labels.json
sha256sum data/qa/v1.2.2-independent/main-operational-labels.json
```

두 Label SHA를 기록한 뒤 최초로 Prediction을 열람하고 채점한다.

```bash
npm run evaluate:independent -- \
  --labels data/qa/v1.2.2-independent/main-blind-labels.json \
  --recompute \
  --include-deleted \
  --expected-count 50 \
  2>&1 | tee data/qa/v1.2.2-independent/main-blind-score.log
```

라벨은 채점 후 수정하지 않는다.

## 12. 운영 위험 지표 독립 계산

Evaluator의 6-state 결과만 복사하지 말고, 고정된 운영 Ground Truth와 현재 소스 재계산 결과를 `/tmp`의 독립 read-only 스크립트로 비교한다. 스크립트는 저장소에 추가하지 않는다.

정의:

```text
Silent Action Miss:
  expectedLane ∈ {do_now, waiting}
  AND actualLane = archive

False Action:
  expectedLane = archive
  AND actualLane = do_now

Critical/High False Positive:
  expectedLane ∈ {archive, review}
  AND actualLane = do_now
  AND actual priority ∈ {critical, high}

Uncertain Review Miss:
  uncertain=true
  AND actualLane ≠ review

Important Action Miss:
  importantAction=true
  AND actualLane ∉ {do_now, waiting}

Archive Guard Violation:
  actualLane=archive
  AND archiveEligible≠true
  OR riskSignals가 비어 있지 않음
  OR requiresHumanReview=true
```

운영 합격 기준:

```text
Silent Action Miss              <=2%, 최대 1/50
False Action                    <=2%, 최대 1/50
Critical/High False Positive    0
Uncertain Mail Review Coverage  100%
Important Action Miss           <=3%
Archive Guard Violation         0
External automatic action       0
```

보조 지표로 다음도 그대로 기록한다.

```text
Canonical Work State Accuracy
Canonical Next Actor Accuracy
Canonical Priority Accuracy
Reference false-action
Important Priority Miss
DO_NOW precision/recall
WAITING precision/recall
REVIEW coverage
ARCHIVE precision
```

모든 mismatch는 원문 없이 hash, stratum, expected canonical, actual canonical, expected lane, actual lane, risk type만 표로 기록한다.

## 13. Incident/Security 신규 Blind

Main Blind와 별도로 **개발자가 보지 않은 실제 incident/security 최소 5건**을 확보한다. 표본 부족을 기존 fixture나 합성 사건으로 채우지 않는다.

```bash
npm run qa:holdout:prepare:incident -- \
  --exclude-labels "$EXCLUDE_CSV,data/qa/v1.2.2-independent/main-blind-labels.json" \
  --output data/qa/v1.2.2-independent/incident-blind-template.json \
  --seed v1.2.2-independent-incident-$(date -u +%Y%m%d) \
  --count 5
```

Main과 동일한 Prediction 비노출 절차로 라벨링·동결·채점한다.

필수 기준:

```text
found=5/5
Silent Action Miss=0
Critical/High False Positive=0
Important Action Miss=0
Evidence exact=100%
현재/과거 본문 오염=0
```

실제 신규 표본을 5건 확보하지 못하면 최종 판정 상한은 `CONDITIONAL GO`다. 단, Main Blind·모든 안전 Gate·검색·Correction·안정성이 전부 PASS해야 한다.

## 14. 검색 독립 평가

결과를 보기 전에 Hidden 자연어 질의 10개를 별도 파일에 작성하고 SHA를 고정한다.

Hidden 질의 유형은 각각 최소 1개 이상 포함한다.

```text
특정 고객·프로젝트
내가 지금 할 일
외부 회신 대기
완료된 지원 사건
검토할 업무 문서
견적·계약·발주
세금계산서·자동 문서 구분
장애·보안
날짜·기한
유사 의미 복합 질의
```

```bash
chmod 0400 data/qa/v1.2.2-independent/hidden-search-queries.json
sha256sum data/qa/v1.2.2-independent/hidden-search-queries.json
```

기존 고정 20개와 Hidden 10개, 총 30개를 평가한다.

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

각 질의 Top-5를 원문 기준 `Direct / Partial / Wrong`으로 판정한다.

합격 기준:

```text
Top 결과 Direct 비율 >=90%
사용 가능한 질의      >=90%
광고 결과              0
삭제·정크 결과         0
incident 보험·세금계산서 noise 0
완료 질의에 활성 Action garbage 0
대기 질의의 Actor 위반 0
semantic intent 근거 위반 0
```

자동 `verify:qa:search` PASS는 독립 relevance PASS가 아니다.

## 15. MailMaestro 근거 기능 수용 테스트

이 항목은 2026-09-02 MailMaestro 메일 8통에 실제로 적힌 기능만 검증한다. **공개 API, Gmail 연동, 가격 숫자는 자료에 없으므로 구현됐다고 쓰거나 PASS 대상으로 만들지 않는다.**

### 15.1 Improve

```text
로컬 초안을 정리·다듬을 수 있음
원문 의미를 임의 추가하지 않음
최종 결과는 복사만 가능
메일 발송 API 호출 0
```

### 15.2 Thread Summary

```text
한 줄 요약과 상세 요약이 currentContent 기준
과거 인용 요청을 현재 요청으로 합치지 않음
빈·불완전 thread에서 내용을 만들어내지 않음
```

### 15.3 Rapid Reply

```text
추천 응답은 draft/copy-only
전체 thread 맥락을 사용하더라도 과거 요청을 현재 의무로 오인하지 않음
원클릭 발송 없음
```

### 15.4 Auto Label

```text
DO_NOW / WAITING / REVIEW / ARCHIVE가 화면과 API에서 일치
ARCHIVE Guard를 우회하지 않음
애매한 메일은 REVIEW
```

### 15.5 Meeting Intent

```text
미팅 의도와 후보 시간 추출
timezone 원문 또는 명시 기본값 사용
Calendar 연결이 없으면 availability=unknown
available/conflict를 추측하지 않음
확인 초안은 copy-only
calendarWriteAllowed=false
```

### 15.6 AI Personality

```text
역할·말투·도입부는 local bounded configuration
메일 상태·Actor·Priority를 바꾸지 않음
초안 생성에만 적용
```

### 15.7 Email Summary

```text
한 줄·상세 요약 제공
현재 본문과 Evidence에 없는 사실 추가 0
Rules 우선, 선택적 Luna 실패 시 서비스 중단 없음
```

### 15.8 Attachment Summary

다음 세 경로를 모두 검증한다.

```text
Graph가 메타데이터만 제공:
- contentAvailable=false
- summaryStatus=metadata_only
- 내용 추측 0

승인된 추출 텍스트 제공:
- PDF/DOCX/TXT 요약 가능
- source hash 기록
- 원문에 없는 사실 추가 0

지원하지 않는 형식 또는 빈 내용:
- unsupported/metadata_only로 fail closed
- 임의 요약 0
```

첨부 요약 결과가 메일 Work State 또는 운영 Lane을 자동 확정하면 `NO-GO`다.

### 15.9 Outlook Add-in

현재 웹앱을 Outlook Add-in으로 배포하는 기능은 정보 부족·보류다. Add-in manifest, Gmail, 공개 API, 가격 정책을 v1.2.2 완료 기능으로 보고하면 문서 계약 실패다.

## 16. 사용자 Correction 지속성

실운영 메일에 임의 보정을 남기지 않는다. 운영 DB의 검증 백업을 owner-only 격리 경로로 복원하거나 테스트용 임시 DB를 사용한다.

다음 시나리오를 검증한다.

```text
자동 분류 확인
→ 상태·Actor·Priority 또는 Lane 보정
→ current projection 즉시 반영
→ 자동 observation 보존
→ correction event append-only 기록
→ 강제 재분류
→ 서비스 재시작
→ 보정 우선 결과 유지
```

필수 기준:

```text
Correction persistence PASS
원본 observation 삭제 0
감사 이력 손실 0
다른 메시지 오염 0
실운영 DB 교체 0
```

## 17. Provider OFF와 선택적 Luna

최종 판정의 기본 상태는 External AI OFF다.

직접 확인:

```text
HTTP 요청 정상 완료
ai.status=policy_blocked
ai.code=EXTERNAL_AI_DISABLED
fallback=rules
rulesUsed=true
사용자 오류에 raw provider 응답 없음
Provider audit event 증가 0
외부 AI 전송 0
다른 Provider 자동 fallback 0
불확실 메일은 REVIEW 유지
```

Luna가 인증돼 있지 않거나 호출 불가해도 Rules 기반 read-only core의 `NO-GO` 사유로 단독 사용하지 않는다. 다만 Luna를 실제로 시험하려면 Owner의 별도 명시 승인을 받아 격리·최소 데이터로 수행하고, 종료 즉시 External AI OFF로 복구한다. 승인 없이 실메일 Provider 호출을 수행하지 않는다.

## 18. Outlook Delta·백업·격리 복원·재시작

다음을 직접 재현한다.

```bash
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
Delta discovered/completed folders 전부 성공
failed folders=0
errors=0
두 번째 실행 중복 증가=0
duplicate graph ID=0
external Outlook writes=0
백업 quick_check=ok
백업·복원 SHA 일치
restore directory mode=0700
restore DB mode=0600
운영 DB 교체=false
재시작 후 두 서비스 active/running
NRestarts=0
DB count·cursor·correction 유지
v1.2.2 version purity 유지
안전 플래그 유지
```

정상 재시작 1회 외 운영 변경을 하지 않는다.

## 19. 독립 31회 안정성 관찰

최종 재시작 후 60초 간격 31회, 최소 30분을 독립 관찰한다.

```bash
npm run verify:stability:start
npm run verify:stability:status
```

자동 요약만 복사하지 말고 JSONL, systemd, journal, DB 값을 표본별로 확인한다.

기록:

```text
Backend/Tailnet health
두 PID
NRestarts
CPU/RSS
SQLite WAL
active messages/classifications
classifier version purity
operational projection version
operator jobs
dead letters
fatal/unhandled/uncaught/OOM
Graph 반복 오류
OAuth 반복 오류
```

합격 기준:

```text
31/31 healthy
unexpected restart=0
read-only contract failure=0
DB count mismatch=0
version purity failure=0
integrity failure=0
duplicate graph ID=0
fatal/unhandled/OOM=0
무한 retry=0
설명 불가능 dead-letter 증가=0
WAL runaway 없음
RSS runaway 없음
```

## 20. 종료 불변성

시작 시 기록한 Commit·source snapshot과 모든 Manifest/Label SHA를 종료 시 다시 계산한다.

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git diff --check
git diff --binary HEAD | sha256sum
find src scripts test package.json package-lock.json README.md docs/planning/V1.2.2-OPERATIONAL-CLASSIFICATION-STABILIZATION.md \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
sha256sum data/qa/v1.2.2-independent/main-blind-template.json
sha256sum data/qa/v1.2.2-independent/main-blind-labels.json
sha256sum data/qa/v1.2.2-independent/main-operational-labels.json
sha256sum data/qa/v1.2.2-independent/incident-blind-template.json
sha256sum data/qa/v1.2.2-independent/incident-blind-labels.json
sha256sum data/qa/v1.2.2-independent/hidden-search-queries.json
```

다음이면 검증 무효 또는 `BLOCKED`다.

```text
HEAD 변경
origin/main 불일치
source snapshot 변경
고정 Label SHA 변경
Blind 채점 후 Ground Truth 수정
검증 중 소스·테스트·제품 문서 수정
```

## 21. 최종 판정 규칙

### GO

다음이 전부 충족될 때만 허용한다.

```text
고정 Commit과 origin/main 일치
Live v1.2.2 전체 버전 일치
전체 자동 Engineering Gate PASS
DB integrity·version purity PASS
Known hard regression PASS
신규 Main Blind 운영 위험 Gate PASS
신규 incident/security 최소 5/5 PASS
Evidence 100%
검색 Direct >=90%
MailMaestro 근거 기능 수용 PASS
Correction persistence PASS
Provider OFF PASS
Delta twice PASS
백업·격리 복원 PASS
재시작 지속성 PASS
31회 안정성 PASS
외부 자동 행동 0
Source·Label 불변
```

### CONDITIONAL GO

다른 모든 항목이 PASS했지만 개발자가 보지 않은 실제 incident/security 신규 표본이 4건뿐이라 5건을 채우지 못한 경우, 또는 선택적 Luna만 외부 공급자 제약으로 시험하지 못한 경우에만 허용한다.

조건:

```text
Rules 기반 read-only core만 사용
incident/security 자동 Archive 금지
REVIEW/HIGH와 사용자 직접 검토 유지
External AI OFF 유지
메일·Calendar·CRM 자동 행동 계속 차단
다섯 번째 실제 표본 또는 Provider 복구 후 즉시 재검증
```

### NO-GO

다음 중 하나라도 해당하면 `NO-GO`다.

```text
Silent Action Miss >2%
False Action >2%
Critical/High False Positive >0
Uncertain Review Coverage <100%
Important Action Miss >3%
Archive Guard Violation >0
Evidence <100%
검색 Direct <90%
현재/과거 본문 오염
첨부 내용 환각
첨부 요약이 상태를 자동 확정
Correction 손실
외부 Outlook·Calendar·CRM 쓰기
데이터 중복·손실
재시작·안정성 실패
공개 listener 또는 안전선 위반
```

### BLOCKED

다음이면 `BLOCKED`다.

```text
Commit 또는 Live version 불일치
HEAD와 origin/main 불일치
서비스·DB·계정·필수 파일 접근 불가
source worktree dirty
Prediction 비노출 절차 위반
Blind 라벨 동결 전 Prediction 열람
검증 중 source snapshot 변동
Aside가 소스 수정·재배포해야만 진행 가능한 상태
```

## 22. 최종 보고서 필수 구조

보고서는 다음 순서로 작성한다.

```text
1. 최종 판정
2. 대상 Commit·origin/main·Source Snapshot
3. Live Version Matrix
4. 안전선·Graph Scope·외부 행동 Count
5. 서비스·네트워크 기준선
6. DB integrity·version purity
7. 전체 자동 Engineering Gate
8. Ground Truth conflict/policy audit
9. 알려진 회귀
10. Main Blind manifest·Prediction 비노출·Label 동결
11. Canonical 6-state 점수
12. 운영 위험 지표
13. Main mismatch 전체 표
14. Incident/Security 신규 Blind
15. Evidence 전수검사
16. 검색 30개 독립 평가
17. MailMaestro 근거 기능 수용 결과
18. Attachment Summary 환각 방지 결과
19. Correction 지속성
20. Provider OFF·선택적 Luna
21. Outlook Delta 2회
22. 백업·격리 복원
23. 재시작 지속성
24. 독립 31회 안정성
25. Source·Manifest·Label 불변성
26. 남은 문제와 최소 수정안
27. GO / CONDITIONAL GO / NO-GO / BLOCKED 근거
```

최종 보고서에는 메일 전문, 첨부 전문, 계정 정보, Token, Secret, Key, Cookie를 포함하지 않는다. 개인정보는 hash 또는 비식별 축약으로만 남긴다.

중간 진행 보고로 종료하지 않는다. 모든 가능한 검증을 수행하고 최종 보고서 파일을 생성한 뒤 사용자에게 **최종 판정과 보고서 경로**를 전달한다.
