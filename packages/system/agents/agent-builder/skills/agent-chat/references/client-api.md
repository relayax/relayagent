# 채팅 클라이언트 API

기판이 서빙하는 두 모듈. 둘 다 런타임 URL 로 임포트한다.

- `/assets/chat-widget.js` — UI 째 위젯. `mount()` 를 수출한다.
- `/assets/chat-core.js` — UI 없는 클라이언트. `createChat()` 을 수출한다.

공통 계약: 모든 호출은 throw 하지 않는다. 실패는 `{ error: { code, message } }` 로 돌아온다.
busy 중의 `send` 는 버리지 않고 줄 세운다 — 같은 slot 에 세션이 동시에 뜨면 충돌하기 때문이다.

## mount(옵션) → { client, root, remove() }

| 옵션 | 뜻 |
|---|---|
| `pkg` | 설치 이름. `location.pathname` 의 `/pkg/<이름>/view/` 에서 파싱한다 |
| `mode` | `"float"`(기본, 우측하단 부유) / `"inline"`(target 을 채우는 컴포넌트형) |
| `target` | inline 모드의 마운트 대상 엘리먼트 |
| `slot` | 시작 세션 슬롯 (기본 `"console"`) |
| `agent` | 대화가 착지할 에이전트 (기본: 패키지 짧은 이름과 같은 착지 에이전트) |

`client` 가 아래 ChatClient 다 — 위젯을 심고도 프로그램적으로 발화하거나 이벤트를 구독할 수 있다.
`remove()` 는 위젯과 문서 전역 리스너(붙여넣기·드래그)를 정리한다.

## createChat({ pkg, slot?, agent? }) → ChatClient

### 발화와 파일

- `send(text, opts?)` → `{ reply }` 또는 `{ error }`
  - `opts.scene` — 화면 맥락 스냅샷. 기판이 프롬프트 서문으로 합성하고 이력에는 원문만 남긴다
  - `opts.display` — 화면용 원문. text 에 손으로 맥락을 섞을 때만 쓴다 (기본은 scene)
  - `opts.attachments` — `[{ path, name? }]`. path 는 `upload` 가 돌려준 workspace 상대경로
  - `opts.agent` — 이 발화만 다른 에이전트로 착지
- `cancel()` — 진행 중 턴 중단
- `answer(id, answers)` — 봉투 `ask` 이벤트(에이전트의 질문)의 답 회송. `answers = [{ question, selected[] }]`
- `reset()` — 현재 슬롯 세션 초기화
- `upload(file, onProgress?)` → `{ path, size, name }` — 바이트를 사이드밴드로 올린다.
  원본 파일시스템 경로는 절대 싣지 않는다. 반환된 상대경로가 유일한 참조다
- `fileUrl(rel, dl?)` — 세션 파일의 URL (`dl: true` 면 다운로드 강제)

### 이벤트 — `on(ev, fn)` → 해제 함수

| 이벤트 | 인자 |
|---|---|
| `message` | `{ role: "user"\|"bot"\|"sys", text, files?, usage?, model? }` |
| `busy` | boolean — 큐가 빌 때까지 한 번만 켜진다 |
| `turn` | `{ remaining }` — 큐 항목이 실제 발사된 순간 |
| `progress` | 진행 이벤트 `{ event: delta\|tool\|file\|reply\|error, ... }` |
| `usage` | `{ usage: { input, output, context_window }, model }` |
| `session` / `reset` / `meta` / `history` | 슬롯 전환·초기화·메타 도착·이력 로드 |

### 세션 관리

`sessions.list()` / `open(slot)` / `create()` / `rename(slot, label)` / `remove(slot)` /
`archive(slot, on)` / `pin(slot, on)` — 기판의 세션 장부를 소비한다. 직접 저장소를 만들지 마라.

### 하네스 설정

`harness.models()` / `setModel(model)` / `setEffort(level)` / `variants(probe?)` / `setVariant(name)` /
`setup()` / `info()` / `commands()` / `connect(token)` / `login()` — 전부 기판 API 의 얇은 래퍼다.
일반 패키지 화면에서 쓸 일은 드물다. 모델·계정 설정 UI 는 콘솔과 위젯이 이미 갖고 있다.

### 메타

- `ready` — `Promise<ChatMeta>`. 첫 화면 그리기 전에 기다리면 인사말·에이전트 목록이 있다
- `meta()` → `{ found, display_name, greeting, model, effort, agents, agent }`
- `history` — 현재 슬롯의 메시지 배열 (로드는 자동)
- `slot` / `busy` — 현재 슬롯과 진행 여부 getter

## 테마 변수

위젯 색·글꼴은 전부 `--rc-*` 변수의 재정의로 맞춘다:

| 변수 | 자리 |
|---|---|
| `--rc-accent` | 주색 (진행 표시, 활성 상태) |
| `--rc-accent-strong` | 강조 텍스트·링크 |
| `--rc-accent-soft2` | 전송 버튼 |
| `--rc-bg` | 패널·말풍선 바탕 |
| `--rc-ground` | 바닥·탭 영역 |
| `--rc-ink` | 본문 텍스트 |
| `--rc-soft` / `--rc-faint` | 보조·희미한 텍스트 |
| `--rc-line` | 경계선 |
| `--rc-sans` | 글꼴 스택 |
