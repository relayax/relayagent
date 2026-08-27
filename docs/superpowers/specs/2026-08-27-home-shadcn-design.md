# 홈 런처를 위젯 번들의 shadcn 화면으로 (2026-08-27)

## 배경
홈("/" 의 `#relay-home` — "무엇을 만들까요?" + 진행 중 카드)은 `runner/runtime/shell.ts` 의
`SHELL_JS` 가 innerHTML 과 손 CSS 로 그린다. 콘솔 뷰와 채팅 위젯은 shadcn 인데 홈만 아니다.
홈 문서는 이미 `/assets/chat-app.{js,css}` 를 로드한다.

## 결정
- 홈 런처를 위젯 번들(`chat/src`)의 React + shadcn 화면으로 옮긴다.
- 사이드바는 shell.ts 의 손 CSS 로 남는다 — 모든 패키지 문서에 주입되는 크롬이라 React 번들에
  의존시키지 않는다(외부 자산 0).
- 문구·동선은 바꾸지 않는다. 모양만 shadcn.

## 구성
1. `chat/src/chat/Home.tsx` — 질문+텍스트영역+시작 버튼, 예시 칩(+↻), 불러오기·스토어 행,
   "진행 중" 카드 격자(수정 중·새 판·오류인 설치본 + 초안), 빈 상태, 새 판 배너, 사용 안내
   Dialog(첫 방문 또는 `?guide=1`, localStorage `relay-guide-v2`).
2. `chat/src/chat/nav.ts` — `ShellNav` 타입 사본 + `/shell/nav` fetch.
3. `chat/src/chat/home-model.ts` — 순수 함수: 카드 선별(`todoOf`), 예시 묶음(`EXAMPLES`,
   `examplesAt(page)`). `chat/test/home-model.test.mjs` 가 검증.
4. `main.tsx boot()` — `#relay-home` 이 있으면 Home 렌더 후 `autoFloat()` (오른쪽 대화 패널).
5. 이벤트
   - 시작: `relay:chat-open {send}` dispatch (같은 번들 — 대기 루프 없음).
   - 사이드바 [새로 만들기] → `relay:home-ask` dispatch; Home 이 받아 텍스트영역 포커스.
     `/#new` 해시도 Home 이 처리.
   - 재조회: `relay:turn`(phase settled) · `relay:nav-refresh` · visibilitychange.
6. shell.ts — `renderHome`·`renderGuide`·`EXAMPLES`·`focusAsk`·홈 CSS 블록 삭제.
   `body:has(#relay-home)` 여백 규칙(치수 계약)은 남긴다. `homeDoc` 마크업 무변경.

## 검증
`npm run typecheck:widget` · `npm run test:widget` · `npm test` · `npm run build:widget` 후
4747 홈을 headless Chrome 으로 찍어 종전 화면과 비교.
