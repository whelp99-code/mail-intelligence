# Attachments / Drive v1 — follow-up

Mail Intelligence v1.2.2 서비스 토큰 슬라이스는 아래만 제공한다.

- 저장된 첨부 메타데이터 목록
- 허용 형식·크기(10MB)의 바이트 다운로드
- 발송 초안의 `attachmentRefs` / `notes`
- 사람 승인 시 Graph에서 바이트를 구해 fileAttachment로 포함하는 최소 경로

아직 하지 않는 것:

- 전체 사서함 첨부 본문을 SQLite에 영속 저장
- OneDrive / SharePoint Drive 업로드·링크 소유
- 임의 로컬 파일을 서비스 토큰이 직접 첨부
- 인라인 이미지·winmail.dat·실행 파일 다운로드
- Tailnet 공개 다운로드 URL

다음 슬라이스 후보:

1. 승인된 첨부의 짧은 수명 서명 URL
2. Drive 후보 링크를 증거로만 기록 (Drive 소유권 없음)
3. 첨부 텍스트 추출은 기존 `attachment-summary` 계약 유지
