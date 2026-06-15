# 보안: 토큰·키 로테이션 체크리스트

런타임 JSON이 git에 노출되었거나 공유된 경우 아래를 순서대로 수행합니다.

## Microsoft Entra / Graph

- [ ] Azure Portal → App registration → **새 client secret** 발급 후 `.env` / `data/runtime-config.json` 갱신
- [ ] 기존 client secret **만료(Revoke)**
- [ ] `refresh_token` 무효화: Entra에서 해당 사용자 **Sign out everywhere** 또는 앱 권한 제거 후 OAuth 재연결
- [ ] `data/runtime-config.json`, `data/accounts.json` 내 `accessToken` / `refreshToken` 필드 삭제 후 재로그인

## Gemini / 기타 AI 키

- [ ] Google AI Studio / 콘솔에서 **API key 재발급**
- [ ] `GEMINI_API_KEY` 및 runtime config의 `geminiApiKey` 교체

## OAuth PKCE state

- [ ] `data/oauth-states.json` 삭제 (진행 중 로그인만 영향)

## Git

- [ ] `git status`에 `data/*.json`, `.outlook-*` 없음 확인
- [ ] 과거 커밋에 시크릿 포함 시 `git filter-repo` 또는 secret scanning 후 키 로테이션

## Destructive API (Sprint 1+)

다음 엔드포인트는 AIOSv2 **승인 게이트** 경유만 허용합니다 (standalone 직접 호출은 로컬 dev만):

| Method | Path | actionType |
|--------|------|------------|
| POST | `/api/outlook/send` | `mail-send` |
| POST | `/api/outlook/read` | `mail-mark-read` |
| DELETE | `/api/outlook/config` | `mail-config-delete` |
