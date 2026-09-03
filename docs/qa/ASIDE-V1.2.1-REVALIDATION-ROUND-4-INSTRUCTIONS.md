# Aside Round 4 독립 재검증 지시서 — Mail Intelligence v1.2.1 qa-fix5

## 0. 역할

너는 개발자가 아니라 독립 검증자다.

```text
Independent QA
Adversarial Tester
Production Readiness Reviewer
Blind Ground Truth Reviewer
```

개발자의 PASS 또는 GO_CANDIDATE 주장을 사실로 받아들이지 않는다. 직접 재현한 증거만 인정한다. 소스 코드는 수정하지 않는다.

최종 보고서:

```text
artifacts/mail-intelligence-v1.2.1-independent-qa-round-4-report.md
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
classifier      precision-classification-v1.2.1-qa-fix5
search          intelligent-search-v1.2.1-qa-fix3
backend         http://127.0.0.1:3010
Tailnet         http://100.87.81.57:3010
```

먼저 다음을 읽는다.

```text
AGENTS.md
README.md
mail-intelligence-v1.2.1-independent-qa-round-3-report.md
docs/planning/V1.2.1-QA-FIX5-ACCURACY-DESIGN.md
docs/releases/v1.2.1-QA-FIX5-ACCURACY-IMPLEMENTATION-REPORT.md
이 지시서 전체
```

## 2. 절대 안전선

다음이 모두 0이어야 한다.

```text
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
```

Graph 권한:

```text
허용: User.Read, Mail.Read, openid, profile, offline_access
금지: Mail.Send, Mail.ReadWrite
```

절대 수행하지 않는다.

```text
메일 발송·답장·전달
읽음/안 읽음 변경
메일 이동·삭제
Flag·Category 변경
Calendar·CRM·Data Plane 쓰기
외부 LLM에 새 실메일 전송
```

하나라도 위반하면 즉시 `CRITICAL FAIL / NO-GO`다.

## 3. 시작 기준선

```bash
cd /home/jm/orca/projects/mail-intelligence

git status --short
git branch --show-current
git log -5 --oneline
git rev-list --left-right --count HEAD...origin/main

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

systemctl --user show mail-intelligence.service \
  -p Id -p ActiveState -p SubState -p MainPID -p NRestarts
systemctl --user show mail-intelligence-tailnet.service \
  -p Id -p ActiveState -p SubState -p MainPID -p NRestarts
ss -ltnp | grep ':3010'

grep -E '^MAIL_INTELLIGENCE_(ACTIONS_APPROVED|ALLOW_SEND|ALLOW_MAIL_MUTATIONS|ALLOW_DATA_PLANE|ALLOW_EXTERNAL_AI|ALLOWED_PROXY_HOSTS)=' data/runtime.env
npm run memory:status
npm run memory:integrity
```

예상 listener:

```text
127.0.0.1:3010
100.87.81.57:3010
```

금지 listener:

```text
0.0.0.0:3010
192.168.x.x:3010 직접 바인딩
공인 IP
Tailscale Funnel
```

## 4. 전체 자동 게이트

시스템 `/tmp`가 다른 프로젝트 산출물로 포화될 수 있으므로 owner-only 프로젝트 TMPDIR을 사용한다.

```bash
mkdir -p data/qa-round4/runtime
chmod 0700 data/qa-round4 data/qa-round4/runtime

TMPDIR="$PWD/data/qa-round4/runtime" \
NPM_CONFIG_OFFLINE=true \
npm run verify:v1.2.1

npm run verify:qa:operational
npm run verify:qa:search
npm run verify:live:local
npm run verify:tailnet
npm run verify:live:restart
npm run memory:integrity
git diff --check
```

최소 기대:

```text
node:test                   219 이상, fail 0
Precision fixture           20/20
Precision assertions        77/77
OAuth focused               9/9
ESLint/HTMLHint/Stylelint   PASS
Safety                      PASS
Repository hygiene          PASS
npm audit                   0 vulnerabilities
Evidence exact              100%
```

자동 게이트는 아래 독립 blind 평가를 대체하지 않는다.

## 5. 알려진 Round 3 고정 50건 회귀

라벨 파일:

```text
test/fixtures/aside-round3-fixed-50.json
```

이 파일의 hash와 기대 라벨을 변경하지 않는다.

먼저 SHA-256을 기록한다.

```bash
sha256sum test/fixtures/aside-round3-fixed-50.json
npm run evaluate:independent:round3
```

PASS 기준:

```text
found                     50/50
Work State                >=95%
Next Actor                >=95%
Priority                  >=95%
Reference false-action    <=2%
Important miss            <=3%
```

개발 결과는 100%라고 주장하지만 Aside가 독립적으로 재실행해야 한다.

## 6. 새 Blind Holdout 50건 — 최종 승인 핵심

알려진 50건은 개발에 사용됐으므로 최종 GO는 별도의 비공개 holdout으로 결정한다.

준비된 템플릿:

```text
path          data/qa-round4/blind-template.json
benchmarkId   qa-fix5-blind-527c34947cfe
samples       50
known 50      전부 제외
mail content  없음
prediction    없음
mode          0600
```

### 6.1 템플릿 무결성

```bash
stat -c '%a %U %G %n' data/qa-round4/blind-template.json
sha256sum data/qa-round4/blind-template.json
```

보고서에 최초 SHA-256을 기록한다. 템플릿을 다시 생성하지 않는다.

### 6.2 라벨링 전 금지 사항

50건 라벨을 모두 고정하기 전에는 다음을 보지 않는다.

```text
precision_classifications
classification history
현재 Work State/Next Actor/Priority
시스템 검색 순위
Rules·Luna·Grok 결과
```

메일 원문, 실제 폴더, 발신/수신 방향, 현재 본문과 인용 이력만 사용한다.

### 6.3 원문 조회 규칙

구현된 검토 도구는 `precision_classifications`를 읽지 않으며 `predictionDisclosure=false`를 출력한다. 한 번에 한 메일만 조회한다.

순번으로 조회:

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa-round4/blind-template.json \
  --index 1
```

hash로 조회:

```bash
npm run qa:holdout:inspect -- \
  --manifest data/qa-round4/blind-template.json \
  --hash '<12자리 hash>'
```

출력 허용 정보:

```text
원문 subject/currentContent/quotedContent
sender와 folder
incoming/outgoing/draft 방향
active/deleted/junk lifecycle
원문 importance
history boundary
빈 reviewerFields
```

출력 금지 정보:

```text
현재 Work State/Next Actor/Priority
classification rule
Rules·Luna·Grok 결과
검색 순위
```

메일 전문이나 개인정보를 최종 QA 보고서에 복사하지 않는다. 보고서에는 hash, 기대값, 실제값, 오류 유형만 기록한다.

### 6.4 Ground Truth 작성

각 sample에 다음 필드를 채운다.

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
high
normal
low
```

판정 원칙:

```text
현재 메시지의 직접 요청만 현재 action으로 사용
내가 보낸 요청은 WAITING / EXTERNAL_PARTY
내가 산출물만 보낸 경우 COMPLETED / NONE
견적·제안·계약·발주 문서 수신은 명시적 확인 전 REVIEW_REQUIRED
장비 정보·현황표·일반 참고 자료는 REFERENCE
작업 정상화·완료 결과는 COMPLETED
빈/불완전 Draft는 REVIEW_REQUIRED
광고·일반 자동 알림은 REFERENCE / LOW
보안장비 예상 밖 인증 Alert는 REVIEW_REQUIRED / HIGH
HIGH는 명시적 긴급·짧은 기한·실제 escalation 근거가 있을 때만 사용
```

### 6.5 라벨 동결

50건을 전부 작성한 뒤에만 전용 동결 도구를 사용한다.

```bash
npm run qa:holdout:finalize -- \
  --input data/qa-round4/blind-template.json \
  --output data/qa-round4/blind-labels.json \
  --reviewer 'Aside Round 4'
```

동결 도구가 확인하는 항목:

```text
정확히 50 samples
hash 형식과 중복
Work State enum
Next Actor enum
Priority enum
reference boolean
important boolean
owner-only output
source template SHA-256
frozen label SHA-256
```

출력 파일은 `independent-ground-truth-v1` 형식으로 변환된다. `--overwrite`를 사용하지 않는다. 이 시점 이후 라벨 변경 금지다. 점수를 본 뒤 기대값을 고치면 QA 무효다.

```bash
stat -c '%a %U %G %n' data/qa-round4/blind-labels.json
sha256sum data/qa-round4/blind-labels.json
```

### 6.6 Blind 점수 계산

```bash
npm run evaluate:independent -- \
  --labels data/qa-round4/blind-labels.json \
  --recompute
```

합격 기준:

```text
all labels found           50/50
Work State                 >=95%
Next Actor                 >=95%
Priority                   >=95%
Reference false-action     <=2%
Important miss             <=3%
```

Known 50과 Blind 50 모두 통과해야 한다.

## 7. qa-fix5 핵심 경계 직접 검증

최소 다음 유형을 blind holdout 또는 별도 합성 입력에서 확인한다.

### 7.1 발신 lifecycle

```text
발신 발주·견적 요청          WAITING / EXTERNAL_PARTY
발신 산출물 전달만           COMPLETED / NONE
발신 인사말뿐인 불완전 메일  REVIEW_REQUIRED / UNKNOWN
발신 긴급 요청               WAITING / EXTERNAL_PARTY / HIGH
```

### 7.2 수신 산출물

```text
재견적 수신                  REVIEW_REQUIRED / UNKNOWN
제안서·계약서 수신           REVIEW_REQUIRED / UNKNOWN
장비 정보·현황표 수신        REFERENCE / NONE
정상화 작업 결과 수신        COMPLETED / NONE / LOW
문서 뒤 직접 검토 요청       ACTION_REQUIRED / ME
```

### 7.3 자동·보안

```text
일반 인증번호                REFERENCE / NONE / LOW
보안장비 인증 Alert           REVIEW_REQUIRED / UNKNOWN / HIGH
Ecount 발주 문서              REVIEW_REQUIRED / UNKNOWN / NORMAL
Hometax 일반 발급 알림        REFERENCE / NONE / LOW
업무 상세 Bill365 세금계산서  REFERENCE / NONE / NORMAL
```

### 7.4 Priority

```text
일반 업무 요청 여러 개지만 긴급 없음  NORMAL
명시적 [긴급]                     HIGH
현재 Due 48시간 이내              HIGH
과거 인용의 긴급 표현              영향 없음
```

## 8. Evidence 전수검사

```bash
npm run verify:qa:operational
```

독립적으로도 전체 Evidence를 검사한다.

```text
canonicalSource.slice(startOffset,endOffset) === exactText
sha256(canonicalSource) === sourceHash
sourceMessageId 일치
normalizationVersion=exact-source-span-v1
history 영역 Evidence 0
placeholder Evidence 0
```

합격:

```text
Evidence exact 100%
```

## 9. 검색 독립 평가

Round 3의 동일 10개 질의를 limit 5로 다시 검사한다.

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

추가로 시스템 결과를 보기 전에 숨은 질의 5개를 작성한다. 고객명, 업무문서, 장애/보안, 기한, 외부 대기를 최소 하나씩 포함한다.

각 결과:

```text
Relevant
Partially Relevant
Wrong
```

합격:

```text
동일 10개 성공              >=9/10
숨은 5개 성공               >=4/5
전체 Top-5 relevance        >=90%
promotional result           0
deleted/junk result           0
invoice/insurance garbage    0
```

## 10. Provider 정책 OFF UX

현재 외부 AI는 OFF다. 실메일을 Provider에 전송하지 않는다.

Outlook 분석을 실행해 확인한다.

```text
HTTP 200
ai.status=policy_blocked
Rules 결과 반환
aiError 없음
한국어 운영자 승인 안내
최근 실제 Provider health event 불변
```

`failed`, 영문 내부 오류, raw JSONL, stack trace, OAuth token을 표시하면 FAIL이다.

## 11. 실제 Outlook Delta 2회

```text
동일 계정
읽기 전용
연속 2회
```

각 회차 기록:

```text
folders
pages
fetched
upserted
deleted
errors
totalCached
```

메일함에 실제 변경이 없었다면 2차 결과:

```text
fetched/upserted/deleted 0
message 중복 0
folder 중복 0
```

## 12. 백업·격리 복원·재시작

```bash
npm run memory:backup
npm run memory:integrity
```

운영 DB를 교체하지 않는다. owner-only 별도 경로에서 백업을 복원해 검사한다.

```text
mode 0600
schema 4
quick_check ok
foreign_key_check 0
record counts 일치
```

재시작:

```bash
systemctl --user restart mail-intelligence.service
npm run verify:live:restart
```

확인:

```text
messages/classifications 유지
corrections 유지
Delta cursor 유지
Provider 상태 유지
두 서비스 active/running
NRestarts=0
```

## 13. 30분 안정성

최종 안전 플래그 0 상태에서 1분 간격 31회 관찰한다.

```text
backend/Tailnet ActiveState
NRestarts
RSS
CPU
WAL bytes
operator jobs
dead letters
fatal/unhandled/uncaught/OOM
```

WAL은 classifyStored 종료 후 checkpoint가 수행되는지 확인한다. 단순 증가량만 보지 말고 작업 종료 후 안정화·checkpoint 여부를 기록한다.

## 14. 호스트 검증 프로세스

이전 원격 호출 timeout으로 제품 서비스가 아닌 오래된 `npm run verify:v1.2.1`, `node --test`, `deploy-user-service.sh` 프로세스가 남아 있을 수 있다.

- 이를 제품 서비스 PID로 오인하지 않는다.
- 임의 kill하지 않는다.
- 개수, PID, 경과시간, RSS를 보고서에 기록한다.
- 종료는 사용자 또는 운영자의 명시적 승인을 받은 경우에만 수행한다.

## 15. 최종 판정

### GO

다음 전부 PASS:

```text
안전선
전체 자동 게이트
Known Round 3 50건
새 Blind Holdout 50건
Evidence 100%
검색 동일 10 + 숨은 5
Delta 2회
백업·격리 복원
재시작
30분 안정성
```

### CONDITIONAL GO

분류·검색·안전·내구성은 모두 PASS하고, Grok 잔액 부족처럼 정확히 격리된 외부 Provider 제약만 남은 경우에만 허용한다.

### NO-GO

다음 중 하나:

```text
Blind Work State/Actor/Priority <95%
Reference false-action >2%
Important miss >3%
Evidence <100%
현재/인용 경계 오류
안전선 위반
데이터 중복·손실
raw 비밀·내부 오류 노출
```

## 16. 보고서 형식

```text
1. 최종 판정
2. 소스/브랜치/서비스 기준선
3. 안전선
4. 전체 자동 게이트
5. Known Round 3 50건
6. 새 Blind 50건: template SHA, frozen-label SHA, 지표
7. qa-fix5 경계 사례
8. Evidence 전수검사
9. 동일 10개 + 숨은 5개 검색
10. Provider 정책 OFF
11. Delta 2회
12. 백업·격리 복원·재시작
13. 30분 안정성
14. 남은 호스트 프로세스
15. 결함 목록과 재현 증거
```

메일 전문, 개인 연락처, Access Key, Cookie, OAuth Token, Client Secret은 보고서에 포함하지 않는다.
