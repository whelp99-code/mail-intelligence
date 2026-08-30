# Persistent Mail Memory 운영 런북

- 대상 버전: `1.1.0`
- 데이터베이스: SQLite
- 기본 DB: `/home/jm/orca/projects/mail-intelligence/data/mail-intelligence.sqlite`
- 기본 백업: `/home/jm/orca/projects/mail-intelligence/data/backups/`
- 안전 모드: 읽기 전용

## 1. 운영 원칙

1. Outlook은 메일 원본이고 SQLite는 Mail Intelligence의 정규화·분석·보정 원본이다.
2. DB와 백업 파일은 일반 사용자나 웹 서버에 공개하지 않는다.
3. 복원 전에 반드시 서버를 정지한다.
4. DB, WAL, SHM 파일을 실행 중 임의 복사하지 않는다. 백업은 제공된 `VACUUM INTO` 절차를 사용한다.
5. 레거시 JSON은 이관 확인 전 삭제하지 않는다.
6. 메일 발송·읽음 변경·이동·삭제는 v1.2.0 운영 범위가 아니다.

## 2. 기동 전 점검

```bash
cd /home/jm/orca/projects/mail-intelligence
node --version
npm ci
npm run verify:v1.2.0
```

Node.js는 22 이상이어야 한다.

저장 디렉터리를 별도로 사용하려면 서버와 관리 CLI 모두 같은 환경변수를 사용한다.

```bash
export MAIL_INTELLIGENCE_DATA_DIR=/srv/mail-intelligence/data
```

## 3. 서버 시작과 종료

시작:

```bash
npm start
```

기본 주소:

```text
http://127.0.0.1:3010
```

정상 종료:

```text
SIGTERM 또는 Ctrl+C
```

서버는 종료 신호를 받으면 HTTP 수신을 중단하고 SQLite 연결을 닫는다. 강제 종료 후에는 재기동 전에 무결성 검사를 실행한다.

## 4. 상태 확인

### CLI

```bash
npm run memory:status
npm run memory:integrity
```

정상 기준:

```text
authoritativeStore = sqlite
ready = true
quickCheck = ["ok"]
foreignKeyErrors = []
schemaVersion = 4
```

### HTTP

인증된 로컬 세션에서:

```text
GET /api/storage/status
GET /api/outlook/sync/status
```

공개 Health는 비밀이나 커서를 노출하지 않고 준비 상태와 스키마 버전만 반환한다.

## 5. 동기화 운영

UI의 `Delta 동기화` 또는 다음 API를 사용한다.

```text
POST /api/outlook/sync
{
  "top": 50,
  "forceInitial": false
}
```

일반 운영에서는 `forceInitial=false`를 사용한다. 전체 재수집은 커서 손상, 파일럿 초기화 또는 승인된 복구 절차에서만 사용한다.

### 정상 동기화 기준

- 발견 폴더 수가 0이 아님
- 완료 폴더 수와 발견 폴더 수가 일치하거나 설명 가능한 부분 실패만 존재
- `pagesProcessed`가 증가
- `failedFolders = 0`
- `deadLetters`가 증가하지 않음
- 최근 메일 건수와 삭제 tombstone 변화가 예상 범위

### 부분 실패

폴더 하나가 실패해도 성공한 폴더는 커밋된다. 실패 폴더는 `dead_letter_events`에 기록된다.

확인:

```bash
npm run memory:status
```

원인을 해결한 뒤 Delta 동기화를 다시 실행한다. 저장된 `nextLink` 또는 `deltaLink`에서 재개한다.

### Delta cursor 만료

Graph 410은 `DELTA_CURSOR_EXPIRED`로 변환된다. 해당 폴더의 커서를 지우고 초기 Delta를 수행한다. 다른 폴더의 커서는 유지한다.

## 6. 작업 이력과 Dead Letter

`operator_jobs`는 다음 운영 작업을 추적한다.

```text
mail-sync
legacy-import
integrity-check
backup
restore
```

상태:

```text
queued → running → completed
                 ↘ failed / dead-letter
```

반복 실패는 숨기지 않는다. `dead_letter_events`에는 작업 ID, Entity, 오류 코드, 안전한 오류 메시지와 비밀이 제거된 Payload가 저장된다.

운영자는 다음 순서로 처리한다.

1. 오류 코드와 대상 폴더·메일함을 확인한다.
2. OAuth, Graph 권한, 네트워크, Cursor 만료 여부를 확인한다.
3. 원인을 해결한다.
4. 동기화를 재실행한다.
5. 정상 반영과 중복 부재를 확인한다.
6. 후속 버전에서 제공되는 해소 처리 전까지 기록은 감사 근거로 보존한다.

## 7. 레거시 JSON 이관

자동 이관 후보:

```text
MAIL_INTELLIGENCE_DATA_DIR/.mail-cache.json
MAIL_INTELLIGENCE_LEGACY_DATA_DIR/.mail-cache.json
```

이관은 파일 SHA-256 digest를 기준으로 한 번만 실행한다.

수동 이관:

```bash
node scripts/mail-memory-admin.mjs import-legacy /absolute/path/.mail-cache.json
```

검증:

- `legacy_imports` 1건
- 메일·보정·분석 건수 일치
- 원본 JSON 내용 불변
- 재실행 시 `already-imported`

손상 JSON은 자동으로 비우거나 덮어쓰지 않는다.

## 8. 검증 백업

### UI

`검증 백업` 버튼을 사용한다.

### CLI

기본 경로:

```bash
npm run memory:backup
```

지정 경로:

```bash
node scripts/mail-memory-admin.mjs backup /backup/mail-intelligence-2026-08-28.sqlite
```

완료 기준:

- 파일 존재
- 권한 `0600`
- SQLite quick check `ok`
- foreign-key 오류 0
- SHA-256 생성
- schema version 기록
- record counts 기록
- `backup_manifests` 기록
- `operator_jobs` 상태 `completed`

백업과 checksum은 동일 장애 도메인 밖으로 복사하되, 현재 저장소나 Git에는 넣지 않는다.

## 9. 복원

### 사전 조건

1. Mail Intelligence 서버를 정지한다.
2. 복원 대상 백업의 checksum과 무결성을 확인한다.
3. 데이터 손실 가능 시점을 기록한다.
4. DB 경로와 `MAIL_INTELLIGENCE_DATA_DIR`가 맞는지 확인한다.

복원:

```bash
node scripts/mail-memory-admin.mjs restore /absolute/path/backup.sqlite --confirm-stopped
```

절차:

```text
백업 Source 검사
→ 임시 복사본 생성
→ 임시 복사본 무결성 검사
→ 기존 WAL/SHM 제거
→ 현재 DB를 restore-rollbacks로 이동
→ 임시 복사본을 Live DB로 원자적 rename
→ 최종 Live DB 무결성 검사
```

실패 시 기존 DB를 자동으로 원위치한다.

### 복원 후

```bash
npm run memory:integrity
npm start
```

확인:

- Health `ready=true`
- 스키마 버전 인식
- 주요 메일·보정·분석 건수
- FTS 검색
- Sync cursor 상태
- 서버 시작만으로 외부 변경이 발생하지 않음
- Delta 동기화 재개 시 중복 메시지 없음

Rollback 파일은 복원 검증과 보존 정책 승인 후 삭제한다.

## 10. 장애별 대응

### DB quick check 실패

- 서버를 중지한다.
- 손상 DB를 덮어쓰지 않는다.
- 마지막 검증 백업을 선택한다.
- 오프라인 복원을 수행한다.
- 원본 손상 DB는 조사용으로 보존한다.

### 디스크 부족

- 동기화를 중단한다.
- DB와 백업 크기를 확인한다.
- 오래된 검증 백업을 승인된 보존 정책에 따라 다른 저장소로 이동한다.
- DB 파일을 직접 압축·분할하지 않는다.

### Graph 권한 오류

- `Mail.Read`가 있는지 확인한다.
- `Mail.Send`, `Mail.ReadWrite`가 불필요하게 추가되지 않았는지 확인한다.
- 계정·Tenant·App Registration 일치 여부를 확인한다.
- 권한 문제를 해결하기 전 자동으로 다른 계정이나 App 권한으로 우회하지 않는다.

### 반복 동기화 실패

- `operator_jobs`, Dead Letter를 확인한다.
- Retry 횟수를 무한히 늘리지 않는다.
- Graph throttling이면 Retry-After와 다음 실행 시간을 따른다.
- 전체 초기화는 특정 폴더의 Delta 복구로 해결할 수 없는 경우에만 사용한다.

## 11. 보존과 용량

v1.2.0은 자동 보존 삭제 정책을 실행하지 않는다. 운영 파일럿에서 다음을 측정한 뒤 정책을 승인한다.

- 일일 신규·변경 메일 건수
- DB 증가량
- 첨부 메타데이터 증가량
- FTS 크기
- 백업 크기와 소요 시간
- 복원 소요 시간

Outlook 원문과 SQLite 정규화 데이터의 보존 목적을 구분한다. 사용자 보정·감사·결정 근거를 임의로 삭제하지 않는다.

## 12. 운영 승격 조건

실제 Outlook read-only 파일럿 전에 다음 증거가 필요하다.

- Delegated OAuth 로그인·갱신·만료
- 전체 폴더 수와 페이지 수
- 신규·변경·이동·삭제 Delta
- Throttling과 일시 오류
- 동기화 중 재시작 후 재개
- Source link 정확성
- 백업·복원 훈련
- Secret·메일 내용 로그 비노출

이 조건이 통과해도 메일 발송이나 원본 상태 변경 권한은 활성화하지 않는다.
