# Phase 2: 키보드 단축키 - Phase Plan v2

## Red Team 피드백 반영

### Security Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| 입력 필드 가드 | `isInputFocused()` 함수로 입력 필드 포커스 시 단축키 무시 |
| 회신 발송 확인 | 회신 모달만 열기 (바로 발송 아님) |

### Requirements Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| 입력 요소 비활성화 | `isInputFocused()` 가드 로직 추가 |
| 포커스 시각적 피드백 | `.keyboard-focused` 스타일 추가 |
| 도움말 키 | `?` 키로 도움말 패널 토글 |
| 접근성 | 향후 aria-live 영역 추가 예정 |

## 구현 완료
- `src/keyboard.js`: 키보드 단축키 로직
- `src/app.js`: 키보드 초기화
- `src/styles.css`: 도움말 패널 스타일

## 검증 기준
- [x] j/k로 메일 이동
- [x] e로 아카이브
- [x] r로 회신 모달
- [x] s로 상태 변경
- [x] /로 검색 포커스
- [x] ?로 도움말
- [x] Escape로 닫기
- [x] 입력 필드에서 단축키 무시
