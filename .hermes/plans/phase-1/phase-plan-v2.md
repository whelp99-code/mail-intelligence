# Phase 1: Kanban 보드 뷰 - Phase Plan v2

## 목표
메일을 칸반 보드 형태로 시각화하고, 드래그 앤 드롭으로 상태를 변경할 수 있는 뷰를 구현한다.

## Red Team 피드백 반영 요약

### Security Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| CSS 선택자 인젝션 | `CSS.escape()` 적용 |
| CSRF | 현재 단계에서는 로컬 전용 앱이므로 허용 (후속 Phase에서 검토) |
| escapeHtml 중복 | `utils.js` 모듈로 추출 |

### Architecture Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| window 전역 의존성 | ES Module import/export 사용 |
| app.js 클로저 구조 | shared state store 패턴 적용 |
| 리스트 뷰 복원 | `mailShell` 내부만 교체, 기존 컨테이너 보존 |
| escapeHtml 중복 | `src/utils.js` 신규 모듈 |

### Quality Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| 테스트 전략 | Vitest 도입 검토 (후속 Phase) |
| 에러 핸들링 | try-catch + 토스트 알림 |
| 접근성 | ARIA 역할, 키보드 대안 (버튼 기반 이동) |
| 성능 | 이벤트 위임 패턴 적용 |

### Operations Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| 드래그 fallback | 버튼 기반 "상태 변경" 메뉴 추가 |
| 에러 로깅 | console.error 최소 로깅 |
| 데이터 일관성 | 칸반→리스트 상태 동기화 |

### Requirements Review 피드백 (반영)
| 이슈 | 조치 |
|------|------|
| DOM 참조 끊김 | `mailShell` 내부만 교체하는 구조로 변경 |
| saveFeedback/selectMessage 실패 | optional chaining 가드 추가 |
| reasonCode 누락 | moveKanbanCard에서 reasonCode 명시 전달 |
| 리마인더 기능 | Phase 1에서 제거 (Phase 7에서 구현) |

---

## 범위 (v2 - 수정됨)
### 포함
- Kanban 4칼럼 UI (긴급/진행중/대기/완료)
- 메일 카드 컴포넌트 (sender, subject, 요약)
- 드래그 앤 드롭으로 메일 상태 변경
- **버튼 기반 "상태 변경" 메뉴 (드래그 fallback)**
- 상태 변경 시 feedback 자동 저장
- 리스트 뷰 ↔ 칸반 뷰 토글
- **에러 핸들링 + 토스트 알림**
- **`src/utils.js` 유틸리티 모듈 (escapeHtml 등)**

### 제외 (v2 - 명확화)
- 모바일 터치 드래그 (추후 Phase)
- 카드 정렬/필터링 (기존 리스트 뷰 활용)
- 실시간 동기화 (WebSocket)
- **리마인더 기능 (Phase 7에서 구현)**
- **테스트 프레임워크 도입 (별도 Phase)**

---

## 변경 파일 (v2 - 수정됨)
| 파일 | 변경 유형 | 설명 |
|------|-----------|------|
| `src/utils.js` | **신규** | 공통 유틸리티 (escapeHtml, CSS.escape 등) |
| `src/kanban.js` | **재작성** | Red Team 피드백 반영하여 전면 재작성 |
| `src/styles.css` | 수정 | Kanban 스타일 + 토스트 알림 스타일 |
| `src/app.js` | 수정 | optional chaining 가드, window 전역 노출 |
| `src/index.html` | 수정 | Kanban 토글 버튼, 토스트 컨테이너 |

---

## 구현 상세 (v2)

### 1. `src/utils.js` (신규)
```javascript
// 공통 유틸리티 모듈
export function escapeHtml(value) { ... }
export function safeQuerySelector(selector) { ... }
export function showToast(message, type) { ... }
```

### 2. `src/kanban.js` (재작성)
- **ES Module import/export** 패턴 적용
- **이벤트 위임** 패턴으로 성능 최적화
- **CSS.escape()** 적용으로 선택자 인젝션 방지
- **try-catch + 토스트** 에러 핸들링
- **버튼 기반 상태 변경 메뉴** (드래그 fallback)
- **리마인더 기능 제거** (Phase 7에서 구현)

### 3. `src/app.js` (수정)
- `selectMessage`, `saveFeedback`, `renderFilteredView` 내부에 **optional chaining 가드** 추가
- `window.selectMessage`, `window.saveFeedback`, `window.renderFilteredView` 전역 노출
- `currentMessages`, `currentResult`를 window에 명시 할당

### 4. `src/styles.css` (수정)
- Kanban 그리드, 카드, 헤더 스타일
- 토스트 알림 스타일
- 드래그 상태 스타일

### 5. `src/index.html` (수정)
- Kanban 토글 버튼 추가
- 토스트 컨테이너 추가

---

## 검증 기준 (v2)
- [ ] Kanban 뷰 토글 동작
- [ ] 4칼럼 정상 표시
- [ ] 카드 드래그 앤 드롭 동작
- [ ] **버튼 기반 상태 변경 메뉴 동작**
- [ ] 상태 변경 시 feedback 저장
- [ ] 리스트 뷰 복원 동작
- [ ] **에러 발생 시 토스트 알림 표시**
- [ ] **CSS.escape() 적용 확인**

---

## 위험 완화 (v2)
- **DOM 참조 끊김**: `mailShell` 내부만 교체하는 구조로 변경
- **window 전역 의존성**: ES Module import/export 사용
- **드래그 실패**: 버튼 기반 상태 변경 메뉴 제공
- **에러 핸들링**: try-catch + 토스트 알림

---

## 일정 (v2)
- Step 1~3: 계획 및 검토 (30분) ✅ 완료
- Step 4: 구현 (1시간)
- Step 5: 검증 (30분)
- Step 11: PR/Commit/Push (15분)
