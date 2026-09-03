# Aside 독립 재검증 지시서 — Mail Intelligence v1.2.1 qa-fix5

## 0. 역할

너는 개발자가 아니다.

역할:

```text
Independent QA
Adversarial Tester
Production Readiness Reviewer
Blind Ground Truth Reviewer
```

개발자가 기록한 PASS, 기존 fixture PASS, 기존 50건 회귀 PASS를 최종 승인 근거로 그대로 받아들이지 않는다.
직접 재현한 증거만 인정한다.

이번 재검증은 두 층으로 분리한다.

```text
A. 알려진 Round 3 고정 50건 회귀
B. qa-fix5 코드 고정 후 새로 뽑은 비공개 Blind Holdout 50건
```

A는 과거 결함의 재발 방지 게이트다.
B가 새로운 정확도 검증이며 최종 GO 판단의 핵심이다.

## 1. 대상

```text
projectId       mail-intelligence
workername      mailintelligence
path            /home/jm/orca/projects/mail-intelligence
branch          main
classifier      precision-classification-v1.2.1-qa-fix5
search          intelligent-search-v1.2.1-qa-fix3
backend         http://127.0.0.1:3010
tailnet         http://100.87.81.57:3010
```

## 2. 필수 문서

먼저 아래 문서를 읽는다.

```text
AGENTS.md
README.md
docs/planning/V1.2.1-QA-FIX5-ACCURACY-DESIGN.md
docs/releases/v1.2.1-QA-FIX5-ACCURACY-IMPLEMENTATION-REPORT.md
이전 Round 3 독립 QA 보고서
이 지시서 전체
```

## 3. 절대 안전선

Outlook은 계속 읽기 전용이다.

반드시 다음 값이어야 한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

Microsoft Graph 권한:

```text
허용:
openid
profile
offline_access
User.Read
Mail.Read

금지:
Mail.Send
Mail.ReadWrite
```

금지 행동:

```text
메일 발송·답장·전달
읽음/안 읽음 변경
이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
외부 AI에 실메일 신규 전송
```

안전선 위반이 하나라도 있으면 다른 결과와 무관하게 `CRITICAL FAIL / NO-GO`다.

## 4. 시작 전 기준선

소스 수정 없이 기록한다.

```bash
cd /home/jm/orca/projects/mail-intelligence

git status --short
git branch --show-current
git log -5 --oneline
git rev-list --left-right --count HEAD...origin/main
```

주의:

- 기존 dirty worktree를 reset, clean, checkout하지 않는다.
- 테스트 중 소스 파일을 수정하지 않는다.
- 테스트용 Ground Truth는 `data/qa/` 아래에만 둔다.
- `data/`는 Git 대상이 아니다.

서비스:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus

systemctl --user is-enabled mail-intelligence.service
systemctl --user is-active mail-intelligence.service
systemctl --user show mail-intelligence.service -p MainPID -p NRestarts
systemctl --user is-enabled mail-intelligence-tailnet.service
systemctl --user is-active mail-intelligence-tailnet.service
systemctl --user show mail-intelligence-tailnet.service -p MainPID -p NRestarts
ss -ltnp | grep ':3010'
```

예상:

```text
127.0.0.1:3010       backend
100.87.81.57:3010    Tailnet proxy
0.0.0.0:3010         없어야 함
```

## 5. 자동 게이트

직접 실행한다.

```bash
npm run verify:v1.2.1
npm run verify:qa:operational
npm run verify:qa:search
npm run verify:live:local
npm run verify:tailnet
npm run memory:integrity
npm audit --audit-level=high
git diff --check
```

자동 게이트 PASS는 Blind Holdout을 대체하지 않는다.

## 6. qa-fix5 결정 구조 직접 확인

qa-fix5는 분류 수를 늘린 버전이 아니다.
현재/과거 문맥, 메일 생명주기, 전달물 의미, 실제 요청, 긴급 근거를 하나의 우선순위 표로 정리한 버전이다.

직접 확인할 우선순위:

```text
1. 불완전 Draft
2. 삭제·정크 lifecycle
3. 자동 완료 알림
4. 보안 인증 Alert
5. 자동 업무 문서
6. 자동 Reference
7. 수신 본문 직접 요청·Inline 응답
8. 발신 요청 → WAITING
9. 발신 전달 완료 → COMPLETED
10. 수신 전달물 의미 판정
11. 충분한 근거 없음 → REVIEW_REQUIRED
```

Priority는 다음 근거가 있을 때만 HIGH 이상이어야 한다.

```text
명시적 긴급 표현
48시간 이내 검증된 Due
실제 장애·보안 사고 문맥
원격 지원 긴급 요청
사용자 보정
```

다음만으로 HIGH를 만들면 안 된다.

```text
Outlook importance=high 단독
요청 문장 수가 많음
제목에 일반 업무 단어가 있음
과거 인용문에 긴급 표현이 있음
```

## 7. 알려진 Round 3 고정 50건 회귀

고정 파일:

```text
test/fixtures/aside-round3-fixed-50.json
```

파일의 label을 수정하지 않는다.

실행:

```bash
npm run evaluate:independent:round3
```

중요:

이 명령은 저장된 `precision_classifications` 값을 그대로 믿지 않고, 현재 qa-fix5 소스에서 50건을 다시 계산해야 한다.
출력에서 다음을 확인한다.

```text
evaluationMode=recomputed-from-source
classifierVersion=precision-classification-v1.2.1-qa-fix5
found=50/50
```

회귀 합격 기준:

```text
Work State             >=95%
Next Actor             >=95%
Priority               >=95%
Reference false-action <=2%
Important miss         <=3%
```

현재 개발 기준선은 50/50이지만, 이것은 알려진 회귀 벤치마크이므로 최종 독립 GO를 단독으로 만들 수 없다.

## 8. Blind Holdout 오염 방지

Blind Holdout을 라벨링하기 전 다음을 하지 않는다.

```text
/api/intelligence/classification 조회
precision_classifications 테이블 조회
현재 Work State/Next Actor/Priority UI 확인
evaluate:independent 실행
소스 규칙을 읽고 정답을 역산
기존 Round 3 label을 새 표본에 복사
```

라벨링 중 허용 정보:

```text
원본 제목
현재 본문
인용·전달된 과거 본문
발신자와 수신 방향
폴더 lifecycle
Outlook 원문 중요도
수신·발신 시각
```

## 9. 새 Blind Holdout 50건

개발 완료 시 생성된 템플릿:

```text
data/qa/qa-fix5-blind-holdout-template.json
```

특성:

```text
기존 Round 3 50개 hash 전부 제외
새 50건
8개 계층 표집
메일 본문 미포함
현재 시스템 예측 미포함
파일 권한 0600
```

예상 계층:

```text
draft
lifecycle
automated
outgoing
forwarded_or_replied
incident_or_security
business_document
general_inbound
```

템플릿이 없거나 현재 코드 고정 이후 새로 생성해야 한다면:

```bash
npm run qa:holdout:prepare -- \
  --output data/qa/qa-fix5-blind-holdout-template.json
```

기존 템플릿을 의도 없이 재생성하지 않는다.

## 10. Blind 표본 원문 확인

한 번에 한 건씩 확인한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/qa-fix5-blind-holdout-template.json \
  --index 1
```

`--index 1`부터 `--index 50`까지 반복한다.

또는 hash로 확인한다.

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa/qa-fix5-blind-holdout-template.json \
  --hash <12자리-hash>
```

Inspector 출력에는 현재 시스템 분류가 없어야 한다.

확인 필드:

```text
predictionDisclosure=false
subject
sender
direction
lifecycle
currentContent
quotedContent
historyBoundary
```

## 11. Ground Truth 작성 원칙

각 표본에 다음을 입력한다.

```text
workState
nextActor
priority
reference
important
reviewerNote
```

허용 Work State:

```text
action_required
waiting
decision_required
completed
reference
review_required
```

허용 Next Actor:

```text
me
internal_team
external_party
shared
none
unknown
```

허용 Priority:

```text
critical
high
normal
low
```

### 11.1 Work State

```text
ACTION_REQUIRED
현재 우리 측의 구체적 행동이 있다.

WAITING
이미 요청하거나 전달했고 상대방·외부 조건의 다음 행동을 기다린다.

DECISION_REQUIRED
대표·승인권자의 명시적 선택·승인·판단이 필요하다.

COMPLETED
현재 업무가 완료됐거나 전달 행위가 끝났고 후속 요청이 없다.

REFERENCE
정보·광고·자동 안내·단순 자료이며 현재 후속 행동이 없다.

REVIEW_REQUIRED
현재 본문만으로 확정할 근거가 부족하거나 상충한다.
```

### 11.2 Next Actor

```text
ACTION_REQUIRED 수신 요청 기본: me
내부 담당자가 명시됨: internal_team
내가 보낸 요청·회신 대기: external_party
공동 행동이 명시됨: shared
COMPLETED/REFERENCE: none
REVIEW_REQUIRED로 주체 불명: unknown
```

### 11.3 Priority

```text
CRITICAL
실제 서비스 중단·침해 등 즉시 대응 사고이며 긴급 근거가 있다.

HIGH
명시적 긴급, 오늘/내일 또는 48시간 이내 확정 기한, 실제 원격 긴급 지원.

NORMAL
일반 업무·일반 대기·일반 완료·업무 참고.

LOW
광고, 자동 인증번호, 저가치 자동 알림, 삭제·정크, 빈/인사말 Draft.
```

### 11.4 Reference와 Important

```text
reference=true
현재 업무 행동이 없는 정보성 메일.

important=true
놓치면 실제 업무 손실이 생기는 메일. 일반적으로 actionable이고, 중요한 계약·발주·긴급 기술 요청 등을 포함한다.
```

Important를 Priority HIGH와 동일시하지 않는다.
중요한 일반 업무는 `important=true`, `priority=normal`일 수 있다.

## 12. 반드시 포함해 판단할 경계 사례

```text
빈 Draft
인사말·서명만 있는 Draft
실질 요청이 들어간 Draft
보낸 요청 메일
보낸 자료 전달 완료
수신 견적·발주서·계약서 전달
전달물 뒤 별도 확인 요청
자동 Ecount 문서
전자서명 완료 알림
인증번호·보안 Alert
한국어 Outlook `님이 작성:`
영문 Forwarded/Original Message
다중 전달
현재 요청 + 과거 완료 문장
현재 완료 + 실제 후속 검수 요청
영문 기술 문의
광고·뉴스레터
장애·보안 실제 사고와 단순 제품 설명
```

## 13. 라벨 고정

50건 라벨 입력을 모두 끝낸 뒤에만 고정한다.

```bash
npm run qa:holdout:finalize -- \
  --input data/qa/qa-fix5-blind-holdout-template.json \
  --output data/qa/qa-fix5-blind-holdout-labels.json \
  --reviewer aside-independent-round4
```

출력되는 SHA-256을 보고서에 기록한다.

고정 후:

```bash
chmod 0400 data/qa/qa-fix5-blind-holdout-labels.json
sha256sum data/qa/qa-fix5-blind-holdout-labels.json
```

이후 label을 변경하지 않는다.

## 14. Blind Holdout 채점

라벨이 고정된 뒤 처음으로 시스템 결과와 비교한다.

```bash
npm run evaluate:independent -- \
  --labels data/qa/qa-fix5-blind-holdout-labels.json \
  --recompute
```

출력에서 확인:

```text
evaluationMode=recomputed-from-source
classifierVersion=precision-classification-v1.2.1-qa-fix5
found=50/50
mismatches
```

Blind Holdout 합격 기준:

```text
Work State accuracy       >=95%
Next Actor accuracy       >=95%
Priority accuracy         >=95%
Reference false-action    <=2%
Important miss            <=3%
Evidence exact            100%
```

정확도 계산 후 Ground Truth를 수정하면 검증 무효다.

## 15. Evidence 전수검사

```bash
npm run verify:qa:operational
```

추가로 전체 활성 메일 Evidence에서 다음을 검증한다.

```text
canonicalSource.slice(startOffset,endOffset) === exactText
sha256(canonicalSource) === sourceHash
sourceMessageId 일치
invalid offset 0
placeholder 0
history evidence 0
normalizationVersion=exact-source-span-v1
```

합격:

```text
Exact Evidence 100%
```

## 16. 동일 10개 검색 질의

limit 5로 다음을 다시 평가한다.

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

각 결과:

```text
Relevant
Partial
Wrong
```

합격:

```text
질의 성공 >=9/10
promotional result 0
deleted/junk result 0
긴급 견적 invoice garbage 0
장애 invoice/insurance noise 0
보안 invoice/insurance noise 0
계약완료 결과 1건 이상
발주서 residual=발주서
```

검색은 Round 3에서 10/10이었으므로 회귀 여부를 중점 확인한다.

## 17. Provider 정책 OFF UX

최종 안전선에서 External AI는 OFF다.

Outlook 분석을 실행해 다음을 확인한다.

```text
HTTP 200
ai.status=policy_blocked
Rules 결과 반환
aiError=null
fallback=rules
한국어 사용자 안내
Provider runtime health event 불변
외부 AI 전송 0
```

`failed`나 영문 내부 오류로 표시되면 FAIL이다.

## 18. 실제 Outlook Delta 2회

읽기 전용으로 연속 두 번 실행한다.

확인:

```text
20개 폴더
오류 0
동일 Graph message 중복 0
변경이 없으면 두 번째 upsert/delete 0
Delta cursor 20/20
외부 Outlook 변경 0
```

## 19. 백업·격리 복원

```bash
npm run memory:backup
npm run memory:integrity
```

운영 DB를 교체하지 않는다.
Owner-only 임시 디렉터리에만 복원한다.

확인:

```text
source/target owner-only
checksum 일치
schema 4
quick_check ok
foreign_key_check 0
message/classification count 일치
```

## 20. 재시작 지속성

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
npm run verify:tailnet
```

확인:

```text
messages/classifications 유지
correction 유지
Delta cursor 유지
provider 상태 유지
두 서비스 active/running
NRestarts=0
```

## 21. WAL·30분 안정성

1분 간격 최소 31회 관찰한다.

기록:

```text
backend active/substate
Tailnet active/substate
NRestarts
RSS
WAL bytes
operator job count
dead letter count
fatal/unhandled/uncaught/OOM
```

qa-fix5는 분류 배치 후 WAL checkpoint를 수행한다.

합격:

```text
unexpected restart 0
fatal/unhandled 0
무한 retry 0
설명 불가능한 dead letter 증가 0
분류 완료 후 WAL이 지속 무한 증가하지 않음
```

## 22. 최종 판정

### GO

다음을 모두 만족할 때만 가능하다.

```text
알려진 고정 50건 회귀 PASS
새 Blind Holdout 50건 모든 기준 PASS
Evidence 100%
검색 >=9/10
Provider OFF UX PASS
Delta 2회 PASS
백업·격리 복원 PASS
재시작 PASS
30분 안정성 PASS
안전선 유지
```

### CONDITIONAL GO

Grok 결제 잔액처럼 제품 외부 제약만 남고, 해당 Provider가 정확히 unavailable로 격리되며 Rules/OpenAI 및 읽기 전용 운영에 영향을 주지 않을 때만 허용한다.

### NO-GO

다음 중 하나:

```text
Blind Holdout 정확도 기준 미달
Reference false-action >2%
Important miss >3%
Evidence <100%
Ground Truth 오염 또는 사후 수정
메일 쓰기 안전선 위반
중복·데이터 손실
Raw credential/provider error 노출
서비스 불안정
```

## 23. 최종 보고서

생성 위치:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-fix5-report.md
```

필수 구성:

```text
1. 최종 판정
2. Git·서비스·DB 기준선
3. 안전선
4. 자동 게이트
5. 알려진 Round 3 50건 회귀
6. Blind Holdout 선택 manifest와 SHA-256
7. 라벨링 절차와 오염 방지 증거
8. Blind Holdout 50건 지표
9. mismatch 목록
10. Evidence 전수검사
11. 검색 10개 수동 relevance
12. Provider 정책 OFF UX
13. Delta 2회
14. 백업·격리 복원
15. 재시작
16. 30분 안정성
17. 외부 Outlook 변경 0건 확인
18. 남은 제약과 다음 조치
```

보고서에 다음을 포함하지 않는다.

```text
메일 전문
Access Token
Refresh Token
Basic Access Key
Cookie
Client Secret
ChatGPT/Grok OAuth Credential
```

검증 중 새 결함을 발견하면 소스를 수정하지 말고 재현 증거, 영향, 최소 수정 제안을 기록하고 NO-GO로 판정한다.
