상태: 조사 단계 / 결정 아님 / 새 첨부 기능 실행·측정 미실시

# 인수 기준·운영 게이트

현재 결과는 01의 기존26/16 테스트뿐이다. 아래 새 기능 검증은 모두 구현 후 수행한다. 합성 테스트 PASS와 실제 사용자 수신 PASS를 분리한다.

| 게이트 | 검증 내용 | 증거·합격 |
|---|---|---|
| G1 입력 R01~03 | 0bytes 거절, 2MiB 허용/2MiB+1 거절, 5개/6개, UTF-8 파일명, MIME 위장, ZIP 폭탄, 암호화, request replay | assets/policy 테스트 실패0·메모리/시간 실측 |
| G2 보안 R04~07/R15 | CSRF/Origin, bearer+cookie, 타 메일함/source, XSS 이름, immutable digest, 동시 approve | API 테스트, unauthorized send0, duplicate send1 |
| G3 영수증 R08 | 202만 수신, timeout, pagination, 누락/추가/동일명 다른bytes | send mock; 불일치 sent0·자동 재발송0 |
| G4 링크 R09 | 허용/악성 URL, 경고 미확인, body 재현 | link 테스트; 네트워크 fetch0·공유변경0 |
| G5 Drive R10~14 | state/PKCE replay, 다른계정, 철회, canDownload false, 삭제/변경 race, export 초과 | OAuth/client 테스트; 실패 전송0 |
| G6 보존 R16~17 | abort quota 반환, 동시3번째, 한도 초과, 참조 보호, dryrun, DB+키 복원 | retention/backup 테스트; 복원 bytes SHA 동일 |
| G7 호환 R18 | 구 migration→신규, text-only v1, flags OFF, 전체 기존 테스트 | PR006 commands exit0; skip은 이유와 미검증으로 표시 |
| G8 UI | 키보드·모바일·진행/오류·다운로드·파일교체 재승인 | 합성 파일로 브라우저 실제 조작과 screenshot, 비밀 제거 |
| G9 운영 | 실제 scanner·OAuth·자기소유파일 PDF/Office 변환·자기수신함 | 별도 승인 후 아래 절차, bytes 일치 |

## 실메일 시험 계약

별도 승인 전 발송0. 사용자에게 Goal(첨부 수신 검증), Done(송수신 hash 일치), Scope(본인 수신인1·합성 파일), Risks(외부 파일 전송·OAuth), Plan(초안→승인→단일발송→대사), Validation(보낸/받은 파일 SHA)을 제시한다. 이메일 주소를 계획서에 고정하거나 과거 승인을 재사용하지 않는다.

PC 합성 PDF, Drive 소유 binary, Docs PDF 변환은 서로 다른 케이스다. 각 발송은 승인된 범위에서만 한다. 수신 파일 bytes hash가 초안 manifest와 같아야 해당 케이스 PASS. Drive 링크는 접근 가능한지 실제 수신자로 확인하되 권한을 자동 변경하지 않는다. 원본 버전 변경·접근 철회는 미발송 결과를 확인한다. 사용자 업무 파일은 시험 기본값이 아니다.

## 배포·복구 절차(실행 승인 필요)

1. 실제 HEAD·서비스·DB 경로를 read-only 확인한다. 현 계획의 로컬 SHA를 최신 운영으로 추정하지 않는다.
2. DB snapshot과 암호화 키의 별도 복구 가능성을 확인한다. 키를 보고서에 출력하지 않는다.
3. flag OFF 상태로 migration, health와 본문 전용 회귀를 검증한다. 운영 scanner/OAuth 설정을 확인한다.
4. 승인된 파일 시험만 수행하고 flag를 이전값으로 복구한다. 영수증 불확실은 재발송하지 않고 읽기 대사를 수행한다.
5. 실패 시 우선 첨부/Drive flag OFF. additive migration DB를 구형 코드가 읽을 수 있는지 확인한 후 코드 rollback. DB backup restore는 이후 생성된 메일/초안 손실을 유발할 수 있으므로 별도 승인 없이 실행하지 않는다. 보내진 메일은 rollback으로 회수되지 않는다.

## 최종 보고 형식

각 R ID에 test명·명령·exit·count·증거 경로를 기록한다. 상태는 PASS/FAIL/NOT_RUN/BLOCKED. 운영 승인 대기는 코드 미구현과 구별한다. 완료 선언은 F1~F7 각각 코드/합성/UI/운영 상태를 표시하고 F8은 제외라고 쓴다. 26/16의 기존 숫자를 신규 기능 통과 수로 재사용하지 않는다.
