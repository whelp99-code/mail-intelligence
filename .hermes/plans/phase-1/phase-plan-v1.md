# Phase 1: Kanban 보드 뷰 - Phase Plan v1

## 목표
메일을 칸반 보드 형태로 시각화하고, 드래그 앤 드롭으로 상태를 변경할 수 있는 뷰를 구현한다.

## 범위
### 포함
- Kanban 4칼럼 UI (긴급/진행중/대기/완료)
- 메일 카드 컴포넌트 (sender, subject, 요약)
- 드래그 앤 드롭으로 메일 상태 변경
- 상태 변경 시 feedback 자동 저장
- 리스트 뷰 ↔ 칸반 뷰 토글

### 제외
- 모바일 터치 드래그 (추후 Phase)
- 카드 정렬/필터링 (기존 리스트 뷰 활용)
- 실시간 동기화 (WebSocket)

## 변경 파일
| 파일 | 변경 유형 | 설명 |
|------|-----------|------|
| `src/kanban.js` | 신규 | Kanban 보드 로직 |
| `src/styles.css` | 수정 | Kanban 스타일 추가 |
| `src/app.js` | 수정 | Kanban 토글, 전역 함수 노출 |
| `src/index.html` | 수정 | Kanban 토글 버튼 추가 |

## 구현 상세
1. `src/kanban.js`: Kanban 보드 렌더링, 드래그 앤 드롭, 카드 컴포넌트
2. `src/styles.css`: Kanban 그리드, 카드, 헤더, 드래그 상태 스타일
3. `src/app.js`: `window.selectMessage`, `window.saveFeedback`, `window.renderFilteredView` 전역 노출
4. `src/index.html`: Kanban 토글 버튼 추가

## 검증 기준
- [ ] Kanban 뷰 토글 동작
- [ ] 4칼럼 정상 표시
- [ ] 카드 드래그 앤 드롭 동작
- [ ] 상태 변경 시 feedback 저장
- [ ] 리스트 뷰 복원 동작

## 위험 완화
- 기존 리스트 뷰 로직 보존 (renderFilteredView 전역 노출)
- 드래그 앤 드롭 실패 시 fallback (클릭으로 상태 변경)

## 일정
- Step 1~3: 계획 및 검토 (30분)
- Step 4: 구현 (1시간)
- Step 5: 검증 (30분)
- Step 11: PR/Commit/Push (15분)
