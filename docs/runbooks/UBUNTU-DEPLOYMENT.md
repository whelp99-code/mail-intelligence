# Mail Intelligence v1.2.0 Ubuntu 배포·실사용 런북

## 배포 기준

- 경로: `/home/jm/orca/projects/mail-intelligence`
- 서비스: 사용자 systemd `mail-intelligence.service`
- 애플리케이션 바인딩: `127.0.0.1:3010` 전용
- Tailnet 포트: 현재 Tailscale IPv4의 `3010/tcp`
- Tailnet 프록시: 사용자 systemd `mail-intelligence-tailnet.service`
- Tailnet 허용 원본: `100.64.0.0/10`
- 저장소: `data/mail-intelligence.sqlite`
- 백업: `data/backups/`
- 인증: HTTP Basic 사용자 `mailintelligence` + 서버의 0600 접근키
- Microsoft Graph: `Mail.Read`만 사용
- 외부 행동: 메일 발송·읽음 변경·이동·삭제·Data Plane 전송 모두 비활성

## 최초 배포 또는 재배포

```bash
cd /home/jm/orca/projects/mail-intelligence
bash scripts/deploy-user-service.sh
bash scripts/activate-tailnet-proxy.sh
```

배포 스크립트는 다음을 수행한다.

1. 데이터·백업 디렉터리를 0700으로 생성한다.
2. 접근키와 `data/runtime.env`를 0600으로 생성한다.
3. `npm ci`와 `npm run verify:v1.2.0`을 통과시킨다.
4. 사용자 systemd unit을 링크하고 부팅 자동 시작을 활성화한다.
5. `/api/health`가 성공할 때까지 확인한다.
6. Tailnet 프록시는 정확한 Tailscale IPv4 하나에만 바인딩한다.
7. 프록시는 Tailscale 주소 범위만 허용하고 `127.0.0.1:3010`으로 전달한다.

## 상태 확인

```bash
systemctl --user status mail-intelligence.service --no-pager
systemctl --user status mail-intelligence-tailnet.service --no-pager
journalctl --user -u mail-intelligence.service -n 100 --no-pager
journalctl --user -u mail-intelligence-tailnet.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/health
curl -fsS "http://$(tailscale ip -4 | head -n1):3010/api/health"
npm run memory:status
npm run memory:integrity
npm run verify:tailnet
```

## Mac에서 Tailnet으로 접속

Mac과 Ubuntu가 같은 Tailscale Tailnet에 연결되어 있으면 전용 포트로 접속한다.

```text
http://100.87.81.57:3010
```

현재 주소는 Ubuntu에서 다시 확인할 수 있다.

```bash
printf 'http://%s:3010\n' "$(tailscale ip -4 | head -n1)"
```

이 포트는 공인 인터넷에 공개하지 않는다. Node 애플리케이션은 계속 loopback에만 바인딩되고, 별도 TCP 프록시가 Tailscale IPv4와 `100.64.0.0/10` 원본만 허용한다. HTTP 구간은 Tailscale의 암호화된 Tailnet 내부에서만 사용한다.

Tailnet을 사용할 수 없는 긴급 운영 상황에서는 기존 SSH 터널을 사용한다.

```bash
ssh -N -L 3010:127.0.0.1:3010 jm@192.168.100.5
```

그때 브라우저 주소는 `http://127.0.0.1:3010`이다.

Basic 인증:

```text
사용자: mailintelligence
비밀번호: Ubuntu에서 아래 명령으로 확인
```

```bash
cat /home/jm/orca/projects/mail-intelligence/data/.mail-intelligence-access-key
```

## Outlook 실사용 연결

1. 브라우저의 `Outlook 연결 설정`을 연다.
2. Microsoft Entra App Registration의 Client ID를 입력한다.
3. Login Tenant를 선택한다.
4. Redirect URI가 아래 주소와 일치하는지 확인한다.

```text
http://127.0.0.1:3010/auth/callback
```

5. Delegated permission은 `User.Read`, `Mail.Read`만 허용한다.
6. `Outlook으로 로그인`을 누르고 동의한다.
7. `Delta 동기화`를 실행한다.
8. 메일 수·폴더 수·작업 상태·경고 수를 확인한다.

최초 OAuth 연결은 SSH 터널과 loopback Redirect URI를 사용한다. Tailnet IP의 일반 HTTP 주소를 Microsoft Entra Redirect URI로 등록하지 않는다. OAuth 연결 후 일상 조회와 정밀 탐색은 Tailnet 주소에서 수행할 수 있다.

OAuth Token과 Refresh Token은 접근키가 설정된 경우 로컬 키로 암호화되어 `data/`에 저장된다. 공개 설정 파일에는 평문 Secret을 쓰지 않는다.

## 실사용 검증 체크리스트

```text
[ ] 로그인 성공
[ ] 전체 폴더 탐색
[ ] 초기 Delta 동기화
[ ] 서버 재시작 후 로그인 유지
[ ] 두 번째 Delta 동기화에서 중복 없음
[ ] 신규 메일 반영
[ ] 읽음/이동/삭제 상태 반영
[ ] 한글 DB 검색
[ ] 사용자 분류 보정 재시작 후 유지
[ ] 검증 백업 생성
[ ] SQLite integrity PASS
[ ] 메일 원본 변경 0건
```

## 재시작·중지

```bash
systemctl --user restart mail-intelligence.service
systemctl --user restart mail-intelligence-tailnet.service
systemctl --user stop mail-intelligence.service
systemctl --user stop mail-intelligence-tailnet.service
systemctl --user start mail-intelligence.service
systemctl --user start mail-intelligence-tailnet.service
```

## 백업

```bash
cd /home/jm/orca/projects/mail-intelligence
npm run memory:backup
```

복원은 웹 API로 제공하지 않는다. 서비스를 중지한 후 로컬 운영자 CLI로만 실행한다. 자세한 절차는 `PERSISTENT-MAIL-MEMORY.md`를 따른다.

## 안전 제한

- Node 애플리케이션의 `0.0.0.0` 또는 공인 인터페이스 바인딩 금지
- Tailnet 프록시는 정확한 Tailscale IPv4와 `100.64.0.0/10`만 허용
- Tailscale Funnel, 공인 IP NAT, 인터넷 공개 방화벽 규칙 금지
- Nginx·Caddy를 이용한 공인 외부 공개 금지
- `Mail.Send`, `Mail.ReadWrite` 권한 추가 금지
- `MAIL_INTELLIGENCE_ACTIONS_APPROVED=1` 설정 금지
- 실제 메일 발송·이동·삭제 테스트 금지
