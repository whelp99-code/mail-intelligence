# MI × Notion CRM 협업으로 AI 메일 공백 보완

> 상태: Phase 1A fixture **ACCEPTED by Jae 2026-09-11/12 (구두 「진행해」)**. Phase 1B read-only collect **authorized to start** (live pull still `BLOCKED_ON_SECRET` until token+map; 2026-09-12 재확인). 커밋·배포·Notion 쓰기·발송·3010 컷오버 승인 없음. CRM go-live 아님.
> 기준일: 2026-09-11
> 정본 정렬: Mail Intelligence `AGENTS.md` PILLAR-7, 개발계획 P6/P7, `AI-CRM+PM/docs/planning/notion-crm-psa-v1/00-canonical-master-plan-v2-ko.md` (v1 `00-master-plan-ko.md`는 superseded)

**Goal:** Copilot식 받은편지함 대화를 MI 안에 만들지 않고, Notion `JM Business OS`(이후 자체 CRM+PSA)를 협업 표면으로 써서 “오늘 뭐가 중요한지 / 스레드를 업무로 남기고 초안을 쓰는지 / 쓸수록 똑똑해지는지”를 메운다.

**Architecture:** **Grokbot investigates**, **Codex contrasts/verifies**. MI 안 챗봇이나 Outlook Copilot이 아니다. Grokbot이 조사·초안을 내고, Codex가 대조·검증·ACK한다. MI는 메일 기억·규칙 분류·WorkLink 저장·승인 발송만 한다. 기존 CRM 분석 원장은 `jm-business.db` / JSONL이다. Notion은 사람이 고치는 projection이다. CRM 운영자가 제안을 적용한다. 둘 사이는 교체 가능한 `WorkLink` 어댑터다. 첫 어댑터는 Notion fixture 읽기(Phase 1A), 둘째는 운영 워크스페이스 읽기 전용(Phase 1B, 게이트만). 이후 `AI-CRM+PM` PostgreSQL. CRM 쓰기와 메일 발송은 각각 별도 승인이다. 상세 계약: `01-CONTRACTS.md`, 게이트: `02-PHASE-GATES.md`.

**Tech Stack:** MI SQLite + 기존 분류/초안 API. Notion API는 Activity/Project 후보 게시용. 이후 CWOS `accounts` / `engagements` / `activities` / `commitments`. 공통 이벤트는 `MailLinked` / `WorkCorrected` / `DraftProposed`.

## Global Constraints

- MI는 Outlook 대체재, 범용 CRM, 자율 회신 봇이 아니다.
- Outlook이 메일 원문 권위다. Notion/CWOS가 고객·프로젝트·재무 권위다.
- CRM 레코드 생성·수정은 `ActionProposal → Approval → Execution → Receipt` 없이는 금지.
- 메일 발송 승인이 CRM 쓰기를 허가하지 않는다. 그 반대도 아니다.
- Notion과 PostgreSQL 이중 쓰기를 하지 않는다. 한 시점에 write target은 하나.
- 실메일·실고객 원문·토큰을 git에 넣지 않는다. 테스트는 synthetic/redacted.
- 운영 3010 플래그(`ALLOW_SEND`, attachments, Drive, Data Plane)는 이 계획만으로 켜지 않는다.
- UNKNOWN-005는 둘로 나눈다. **논리 fixture 계약 = done**. **운영 매핑 = unverified** (실 workspace schema pull 없음, `crm-review-routing.v3.json` 로컬 미발견).
- Copilot식 자유 대화나 MI 내부 두 번째 모델 두뇌를 추가하지 않는다. 조사는 Grokbot, 대조/검증은 Codex다.
- Phase 1A fixture 파이프라인은 유지한다. Phase 1B live HTTP는 `MAIL_INTELLIGENCE_NOTION_READONLY=1` + 읽기 전용 시크릿이 있을 때만. 기본 OFF. 쓰기/발송/3010 금지.

---

## 1. 왜 이 단점이 핵심인가

이전 비교의 단점은 두 문장이었다.

1. 오늘 뭐가 중요한지 **대화로** 묻거나, 스레드를 읽고 **바로 초안**을 쓰는 경험은 Copilot이 낫다.
2. 프로젝트 링크와 학습이 없어 **쓸수록 똑똑해지지 않는다**.

Jae의 목적은 Copilot을 이기는 것이 아니다.

```text
지금:  Notion JM Business OS 와 협업
나중:  자체 CRM+PSA (AI-CRM+PM / CWOS) 연동
```

그래서 보완 목표는 받은편지함 챗봇이 아니다.

| Copilot이 잘하는 것 | 여기서 대신 채울 곳 |
|---|---|
| “오늘 뭐가 중요해?” 대화 | **모든 진행 중 CRM 프로젝트** 합집합 + MI 메일 위험. `DO NOW ∩ next action`만 쓰지 않음 |
| 스레드 읽고 바로 초안 | 메일 → **Activity 후보** → 사람 확인 → 같은 Engagement 문맥의 **초안 제안** → MI 승인 발송 |
| 쓸수록 개인화 | Notion/CWOS에서 고친 고객·프로젝트·다음 행동이 MI **alias / project link / 정책 예시**로 남음 |

CRM 마스터플랜(v2 정본)도 같은 선을 이미 긋는다. AI는 화면 옆 챗봇이 아니라 Capture & Link 운영 계층이다. Activity DB는 이미 `출처 ID/경로`, `근거등급`, `확신도`, `검토상태`, `자연키`를 가진다. “근거/확신/확인 필드가 없다”는 주장은 거짓이다. MI는 내부 0–1 점수를 그 select 값으로 투영한다.

---

## 2. 권위와 어댑터

```text
Outlook          = 메일/스레드 원문
Mail Intelligence = 분류, 증거, 초안, 발송 receipt, WorkLink
Notion (지금)     = 사람이 매일 여는 고객·프로젝트·활동 검증판
CWOS PG (나중)    = 고객·Engagement·재무·승인의 단일 원장
```

교체면:

```text
WorkLink {
  mailbox_id,
  message_id,              // MI
  object_type,             // account | engagement | activity | commitment
  system,                  // "notion" | "cwos"
  external_id,             // Notion page id → 이후 CWOS uuid
  confidence,
  evidence_refs[],
  status,                  // candidate | confirmed | rejected | superseded
  corrected_by,            // user | policy
}
```

Phase 전환 시 `system`과 `external_id`만 바꾼다. MI 분류 스키마와 초안 경로는 유지한다.

금지:

- MI `projects` 테이블을 Notion 프로젝트의 두 번째 원장으로 키우기
- Notion에 메일 원문 전체를 미승인 게시
- CWOS가 살아 있는 동안 Notion에 같은 Activity를 자동 이중 기록

---

## 3. 현재 갭 (2026-09-11 실측)

MI: 활성 516, 규칙 분류만, `projects=0`, 보정 0, observations 0, 발송 OFF, sync 수동.
Notion Activity: `출처 ID/경로` · `근거등급` · `확신도`(높음/보통/낮음) · `검토상태`(검증완료/연결검토/제외) · `자연키`가 이미 있다. 운영 database_id 매핑은 아직 unverified.
기존 분석 원장: `jm-business.db` / JSONL (CRM operator). Notion은 human-editable projection.
CWOS: Notion import는 읽기·승인 apply. 메일 실행자 연결은 아직 없음.

이 상태로는 CRM 협업이 성립하지 않는다. 메일이 프로젝트에 안 붙고, Notion 활동은 손으로만 생기며, 초안은 Engagement 문맥이 없다.

---

## 4. 보완 루프

```text
INGEST (MI, 증분)
  → CLASSIFY (규칙, 후보 프로젝트)
  → LINK CANDIDATE (WorkLink → Notion page / 이후 CWOS id)
  → PRESENT IN CRM (오늘 할 일 = Commitment ∪ DO NOW)
  → HUMAN CORRECT (Notion에서 프로젝트/다음행동 수정)
  → LEARN (보정 → MI alias·정책 예시·재평가)
  → DRAFT (CRM 문맥 + 메일 증거 → 초안)
  → APPROVE SEND (MI만, 별 플래그)
  → RECEIPT → Activity(발신) 후보
```

Copilot 대화창은 이 루프의 필수 단계가 아니다. 사람이 이미 여는 면은 Notion 프로젝트 페이지다.

---

## 5. Phase

### Phase 0 — 계약 디스커버리 (쓰기 없음)

**하는 일**

- Notion `JM Business OS`의 고객·프로젝트·활동·재무 database_id와 속성 맵을 적는다.
- 메일 메시지 → 활동 속성 초안: 유형=`메일 수신`, 활동일, 요약, 고객, 프로젝트, `출처 ID/경로`, `근거등급`, `확신도`(select), `검토상태`(select), `자연키`.
- CWOS 쪽 대응 객체: `cwos_accounts`, `cwos_engagements`, `cwos_activities`, `cwos_commitments`.
- UNKNOWN-005를 논리 fixture 계약(done)과 운영 매핑(unverified)으로 분리한다.

**완료 조건**

- synthetic 3통이 어느 Notion 페이지 / 어느 CWOS 필드에 붙는지 표로 재현 가능.
- 운영 토큰·실페이지 ID를 git에 넣지 않음.

**산출**

- `docs/planning/notion-crm-collaboration-v1/01-CONTRACTS.md` (Grokbot/Codex 역할, 속성 맵, synthetic 3통, Phase 1A HTTP)
- `docs/planning/notion-crm-collaboration-v1/02-PHASE-GATES.md` (1A/1B, verify 명령, rollback)
- `AI-CRM+PM` v2 마스터플랜을 정본으로 유지. 교차 링크: Notion은 검증판, CWOS PG가 이후 원장. 기존 분석 원장은 `jm-business.db`/JSONL.

### Phase 1A — fixture pipeline (구현 범위)

**하는 일**

- fixture snapshot만 읽어 MI에 `WorkLink` 후보를 만든다.
- WorkLink-derived classification을 하나의 projection으로 create/replace/clear. 사용자 확정·타출처 확정은 보호.
- 전체 페이지를 끝낸 뒤에만 generation swap. 부분 실패는 기존 링크를 유지하고 `partial/stale`을 보고한다.
- 분류 `project_resolution=candidate`. 자동 확정 금지.
- UI/API: 메일 옆에 “후보 프로젝트 (Notion)”만 보여 준다.

**완료 조건**

- fixture Notion export로 후보 링크 + 분류 projection 테스트 PASS.
- 1001+ 페이지/중도 abort 회귀 PASS.
- 운영 Notion에 POST/PATCH 0건.
- WorkLink query · classification query · stats가 일치한다.

### Phase 1B — live read-only snapshot (구현 착수, 실 pull은 시크릿 대기)

**하는 일**

- `MAIL_INTELLIGENCE_NOTION_READONLY=1` (기본 OFF) + token file/env + untracked database map으로 읽기 전용 snapshot collect.
- schema hash / property types를 기존 `notion-schema-contract.js`로 검증. `proposeActivity`는 계속 `NOTION_WRITE_DISABLED`.
- 스냅샷은 `data/notion-readonly/` (gitignore) 또는 지정 경로. source vs analysisComplete watermark 분리. 실패 시 LKG 유지 + `stale/partial`.
- 시크릿이 없으면 live pull은 `BLOCKED_ON_SECRET`. 테스트는 recorded-response / live-shaped harness로 네트워크 없이 PASS.

**완료 조건 (실 워크스페이스)**

- 읽기 스코프 분리 시크릿 제공 후 schema hash 재확인.
- 운영 Notion POST(페이지 생성)/PATCH/DELETE 0건. query POST만 허용.
- ops-scale perf·3010 컷오버는 별 게이트.

### Phase 2 — 오늘 할 일 브리핑 (대화창 대신, 계약만)

**하는 일**

- 매일 한 장: **모든 진행 중 CRM 프로젝트**를 우주(universe)로 두고, 그 위에 MI 메일 위험을 더한다 (union / 합집합). `DO NOW ∩ 다음 행동이 있는 프로젝트`만 쓰지 않는다.
- 기존 deadline / slip / external-dep / stall / importance 점수를 재사용한다. 최대 5개. 제외 이유를 남긴다.
- 내부 다음 행동(`internal_next_action`) · 외부 확정 약속(`external_confirmed_commitment`) · 외부 확정 예정일(`external_expected_confirm`)을 구분한다.
- 표면은 Notion 요약 페이지 **또는** MI `/today` JSON. 챗봇 불필요.
- Jarvis/Gateway가 읽는다면 이 JSON만 읽는다. 메일을 다시 요약하지 않는다.

**완료 조건**

- “오늘 뭐가 중요해?”에 대한 답이 프로젝트명 + 다음 행동 + 근거 메일 id로 떨어진다.
- 근거 없는 문장 요약은 거절한다.

### Phase 3 — Activity 후보 게시 (승인 후 Notion 쓰기)

**하는 일**

- `object_type=activity` 제안: 요약, 유형, 활동일, 고객/프로젝트 relation, MI evidence ref, confidence.
- 승인 전에는 Notion에 행이 생기지 않는다.
- 원문 본문 전체가 아니라 요약 + 증거 포인터.
- 거부/수정은 `WorkCorrected`로 남긴다.

**완료 조건**

- 미승인 경로로 Notion write가 실패하는 테스트.
- 동일 `request_id`로 활동 행이 한 번만 생긴다.
- Activity 행에 `출처 ID/경로` · `근거등급` · `확신도` · `검토상태` · `자연키`가 채워진다. 내부 0–1 점수는 WorkLink에 남기고 select로만 투영한다.
- Phase 3 시작 전: natural key, proposal hash, expected revision, actor/policy, outbox, timeout readback, dedupe, rollback. Notion read-before-write를 atomic CAS라고 부르지 않는다.

### Phase 4 — 문맥 초안 (바로 보내기 아님)

**하는 일**

- 초안 입력: 스레드 + **확정 WorkLink** + Notion/CWOS Commitment.
- 기존 mail-send-drafts digest에는 WorkLink/Commitment 개정이 없다. Phase 4는 draft 생성 시 snapshot+revision을 묶고, approve/execute에서 재확인하며, 링크가 다른 고객으로 바뀌면 실행하지 않는다.
- 출력: 기존 MI send-draft. 복붙 또는 승인 발송.
- Activity post ≠ project-link confirm ≠ customer send. 링크 확인/거절/수정 이벤트 계약이 Phase 4보다 앞선다.
- 3개 시나리오 고정 생성 금지. Engagement 문맥이 없으면 초안 거절 또는 `review_required`.
- 발송 receipt가 있으면 Activity(메일 발신) 후보를 연다.

**완료 조건**

- 링크 없는 메일의 자동 고객 발송 초안 0.
- 발송 플래그와 CRM 쓰기 플래그가 독립.

여기가 Copilot “바로 초안”의 대체다. 속도는 느리고, 고객·프로젝트 문맥은 맞다.

### Phase 5 — 학습 루프

**하는 일**

학습은 **재적용(re-apply)** 과 **일반화(generalization)** 를 분리한다. holdout/rollback은 이후 게이트. Phase 5 학습 모델 개선은 이 REJECT 치유에서 구현하지 않는다.

학습 원천 순위는 기존과 같다.

```text
명시적 사용자 보정
> 승인된 프로젝트/엔티티 alias
> 검증된 실행 결과
> 결정적 정책
> 모델 추출
> 유사도 제안
```

CRM에서 일어나는 일 → MI 반영:

| CRM에서 한 일 | MI에 남는 것 |
|---|---|
| 메일 활동을 다른 프로젝트로 옮김 | `WorkLink` rejected + 새 confirmed, alias 후보 |
| 다음 행동을 직접 씀/마침 | Commitment 상태, 재분류 replay |
| 초안 거부 | 정책 예시(왜 거부했는지 코드) |
| 발송 receipt | 실행 결과, 동일 스레드 재평가 |

**완료 조건**

- 보정 전후 replay fixture에서 같은 메일 유형의 링크 정확도가 올라간다.
- 모델 파인튜닝 없음.

이 단계가 “쓸수록 똑똑해진다”의 정의다.

### Phase 6 — 자체 솔루션 교체

**하는 일**

- `system=cwos` 어댑터. 객체는 이미 CWOS 계약에 있는 Account/Engagement/Activity/Commitment.
- Notion write adapter를 끈다. Notion은 읽기 요약만 (마스터플랜 §12.4).
- 기존 confirmed `WorkLink`는 `external_id` 마이그레이션 테이블로 옮긴다.

**완료 조건**

- 같은 MI 메일이 Notion page id 없이 CWOS uuid로 재링크된다.
- Notion/CWOS 이중 쓰기 테스트가 실패로 막는다.

---

## 6. 파일 경계 (구현 착수 시)

Mail Intelligence (이 리포):

- Create: `src/application/work-links.js` — WorkLink 후보/확정/거절
- Create: `src/adapters/work-system-port.js` — `listMasters`, `proposeActivity`, `fetchCommitments`
- Create: `src/adapters/notion-work-system.js` — Phase 1–3만
- Create: `src/adapters/cwos-work-system.js` — Phase 6
- Create: `migrations/008_work_links.sql`
- Create: `test/work-links.test.js`, `test/notion-work-system.test.js` (synthetic)
- Modify: `src/application/mail-send-drafts.js` — 확정 링크 없으면 고객 초안 거절(Phase 4)
- Modify: `server.mjs` — `/api/work-links`, `/api/today-briefing` (플래그 OFF 기본)
- 금지: Notion SDK를 `server.mjs`에 직접 매기, 운영 `.env`를 테스트에 읽기

AI-CRM+PM (별 리포, Phase 6 또는 Phase 3 수신 API):

- Modify: `packages/connectors` — inbound `MailLinked` (이미 메일 커넥터 자리)
- 금지: Notion dual-write, MI가 CWOS 재무 행을 만들기

운영:

- Notion integration은 read(Phase 1)와 write(Phase 3) 스코프를 분리한 별 시크릿.
- MI 3010에 CRM write 플래그를 넣지 않는다. 새 플래그 이름 예: `MAIL_INTELLIGENCE_ALLOW_CRM_PROPOSALS`.

---

## 7. 하지 않을 것

- MI 안에 Copilot식 자유 대화창
- 모든 메일에 회신 시나리오 3개
- 분류만으로 Notion 프로젝트 자동 생성
- 메일 표시만으로 읽음/CRM 갱신
- attachments-drive 미배포 코드를 이 계획에 끼워 넣기
- 운영 원본에 승인 없는 직접 패치

---

## 8. 선행 조건 (이 리포만)

Phase 1 전에 운영 MI에서 필요한 것:

1. 읽기 전용 증분 sync가 다시 멈추지 않게 하는 방법 (timer 또는 명시적 일 1회). 스케줄 추가는 별 승인.
2. `projects=0`을 Notion 읽기 후보로 채우기 전까지는 “똑똑해짐”을 주장하지 않음.
3. 발송·CRM 쓰기는 계속 기본 OFF.

---

## 9. 성공 판정

이 계획이 Copilot 단점을 보완했다고 말하려면 아래가 동시에 참이어야 한다.

1. Jae가 Notion 프로젝트 페이지에서 **근거 메일 id가 붙은 활동/다음 행동**을 본다.
2. 링크 없는 DO NOW와 링크된 DO NOW가 숫자로 갈린다.
3. 잘못된 프로젝트 수정을 한 뒤, 비슷한 다음 메일의 후보가 바뀐다 (replay).
4. 초안은 Engagement 문맥 없이 고객에게 나가지 않는다.
5. Notion → CWOS 교체 후에도 1–4가 같은 API로 성립한다.

1이 없으면 협업이 아니다. 3이 없으면 학습이 아니다. 5가 없으면 자체 솔루션 연동이 아니다.

---

## 10. Phase 1A verify (machine-check 공백 해소)

독립 리뷰의 machine-check에 verify 명령이 0개였다. Phase 1A 명령:

```bash
cd /home/jm/orca/projects/mail-intelligence-notion-crm-dev
TMPDIR=/var/tmp node scripts/run-tests-isolated.mjs \
  test/work-links.test.js \
  test/work-links-refresh.test.js \
  test/work-links-api.test.js \
  test/work-links-ui.test.js \
  test/notion-schema-contract.test.js \
  test/today-briefing-contract.test.js \
  test/work-link-events.test.js
```

또는 `TMPDIR=/var/tmp npm run verify:notion-crm-p1a` (P1A + P1B unit/harness).

기대: exit 0. 실 Notion 시크릿 없이도 harness PASS. live pull은 `npm run collect:notion-readonly` (시크릿 필요). 상세 게이트·rollback: `02-PHASE-GATES.md`.
