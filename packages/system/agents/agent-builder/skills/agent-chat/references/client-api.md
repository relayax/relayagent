# 채팅 클라이언트 API

기판이 서빙하는 위젯 번들과, 그 아래의 클라이언트 SDK 두 층이다.

- `/assets/chat-app.js` — 완성 UI. `mount(el, opts)` · `mountTabs(el, opts)` 를 수출한다.
  런타임 URL 로 임포트한다(`import { mount } from "/assets/chat-app.js"`).
  `window.RelayChat = { mount, mountTabs }` 전역도 같이 선다 — ESM 을 못 쓰는 임베더용.
- `/assets/chat-app.css` — 그 UI 의 스타일. 같이 링크해야 한다.
- `@relay/relayjs` 의 `createChat` — UI 없는 클라이언트(headless). 자산이 아니라 **의존성**이다
  (기판 레포 안에서는 `file:`). 번들은 `createChat` 을 수출하지 않는다.

공통 계약: 모든 호출은 throw 하지 않는다. 실패는 `{ error: { code, message } }` 로 돌아온다.
같은 세션의 턴 직렬화는 **기판이 소유한다** — 클라이언트가 큐를 만들 필요가 없다.

## mount(el, 옵션) → { unmount(), setConversation(c), setTarget(id, c?) }

| 옵션 | 뜻 |
|---|---|
| `instanceId` | 대상 인스턴스. 생략 시 주입 좌표(`window.__RELAY_CONTEXT.instanceId` / `[data-relay-instance]`) |
| `conversation` | 이어 열 대화 스레드 — `"main"` \| `"agent-<name>[:<param>]"` |
| `title` | 헤더에 그릴 이름 |
| `principal` | 신원 표식(기본 `"local"`). 신원 해석의 정본은 서버다 |
| `onClose` | 접기 콜백. 주면 헤더에 접기 버튼이 생긴다 |

첫 인자가 **대상 엘리먼트**다. 구 판의 `mount({ pkg, mode, target })` 은 은퇴했다 —
`mode: "float"` 자리는 자동 마운트(스크립트 한 줄)가 대신한다.

## mountTabs(el, 옵션) → { unmount(), openTab(req) }

여러 (인스턴스 × 대화)를 탭으로 여는 셸. 옵션은 `mount` 와 같고 `onAllClosed` · `onCollapse`
가 더 있다. `openTab({ instanceId, conversationId?, title? })` 로 탭을 연다.

## 뷰-채팅 브리지 — openChat · AgentScope · setScene

같은 문서의 도킹 위젯(자동 부유 크롬)과 말하는 인페이지 표면. `@relay/relayjs` **루트
임포트**에서 온다 — 위젯 번들 자산이 아니라 의존성이다. 정본 계약은 기판 리포
`docs/view-bridge.md`.

- `openChat({ prefill?, send?, conversation?, instance? })` — 패널을 열고 대상 탭을
  포커스한다. `prefill` = 컴포저 채움(사용자가 검토 후 전송), `send` = 자동 전송(컴포저
  submit 과 같은 큐 의미론 — 턴 실행 중이면 큐잉). 대상 없는 prefill/send 는 페이지가
  선언한 슬롯(AgentScope)으로 가고, 선언이 없으면 대상 전환 없이 활성 탭에 꽂힌다.
  전달은 재시도-until-ack — 위젯 마운트 타이밍을 몰라도 유실되지 않는다.
- `<AgentScope agent param? targets?>` — "이 화면의 대화는 이것" 선언(투명 래퍼).
  중첩 = 안쪽 승, 형제 = 후승. 선언이 바뀔 때마다(SPA 이동 포함) 위젯이 그 대화를
  미리보기 탭으로 끌어온다. `targets` = 이 에이전트가 다룰 수 있는 작업 대상 전체 —
  채팅의 "대상 추가" 후보를 채운다(서버는 param 후보를 모른다 — 아는 쪽이 선언한다).
- `useAgentBinding()` → `{ agent?, param?, conversation }` — 현재 활성 선언과 슬롯
  문자열(읽기 전용). **슬롯 문자열을 손으로 조립하지 마라** — `openChat` 의
  `conversation` 에는 이 값만 싣는다.
- `setScene(text | null)` — 화면 맥락 스냅샷(latest-wins). 위젯의 이후 발화가
  `turn.send` 의 scene 서문으로 싣는다(합성은 기판 몫, 이력에는 발화 원문만 남는다).
  `null` = 해제. 화면 상태가 바뀔 때마다 밀어 둔다 — 발화가 뷰를 기다리지 않는다.

```tsx
import { AgentScope, openChat, setScene } from "@relay/relayjs";

<AgentScope agent="builder" param={pkgName} targets={allPkgs}>
  <Workbench />
</AgentScope>

// 오류 배너의 원클릭 "빌더에게":
openChat({ prefill: `다음 로드가 실패했어요. 고쳐주세요:\n${detail}` });

// 선택이 바뀔 때마다 화면 맥락 갱신:
setScene(`사용자가 보고 있는 화면: ${pkgName} 워크벤치, 선택된 항목 ${sel}`);
```

## createChat({ base, root?, instance?, agent?, session? }) → Chat

좌표는 주입에서 온다 — `base` 는 대화 스코프의 뿌리(`window.__RELAY_CONTEXT.base`),
`root` 는 인스턴스 열거의 뿌리다. 마운트 문법을 직접 조립하지 마라.

### 발화와 파일

- `send(text, opts?)` → `{ reply }` 또는 `{ error }`
  - `opts.scene` — 화면 맥락 스냅샷. 기판이 프롬프트 서문으로 합성하고 이력에는 원문만 남긴다
  - `opts.display` — 화면용 원문. text 에 손으로 맥락을 섞을 때만 쓴다 (기본은 scene)
  - `opts.attachments` — `[{ path, name? }]`. path 는 `upload` 가 돌려준 stage 상대경로
  - `opts.agent` — 이 발화만 다른 에이전트로 착지
- `cancel()` — 진행 중 턴 중단 (`turn.interrupt`)
- `answer(id, answers)` — 봉투 `ask` 이벤트의 답 회송. `answers = [{ question, selected[] }]`
- `reset()` — 현재 세션의 하네스 대화 포인터만 끊는다 (이력은 남는다)
- `upload(file, onProgress?)` → `{ path, size, name }` — 바이트를 사이드밴드로 올린다.
  원본 파일시스템 경로는 절대 싣지 않는다. 반환된 상대경로가 유일한 참조다
- `fileUrl(rel, dl?)` — 세션 파일의 URL (`dl: true` 면 다운로드 강제)
- `close()` — 열린 스트림·구독 정리
- `refresh()` — 서버 상태로 따라잡기(이력·진행 턴 재부착)

### 이벤트 — `on(ev, fn)` → 해제 함수

| 이벤트 | 인자 |
|---|---|
| `message` | `{ role: "user"\|"bot"\|"sys", text, files?, usage?, context?, model? }` |
| `busy` | boolean |
| `turn` | 턴 개설 |
| `progress` | 봉투 이벤트 원본 `{ event: delta\|tool\|usage\|task\|ask\|file\|reply\|error, ... }` |
| `parts` | 진행 중 턴의 파트 스냅샷(리듀서 상태) |
| `usage` | 종결 집계 |
| `session` / `reset` / `meta` / `history` | 세션 전환·초기화·메타 도착·이력 로드 |
| `error` | 계약 판정·push 실패의 fail-loud 표면 |

### 세션 관리

`sessions.list()` / `open(id)` / `create()` / `rename(id, label)` / `remove(id)` /
`archive(id, on)` / `pin(id, on)` — 기판의 세션 장부를 소비한다. 직접 저장소를 만들지 마라.
**세션 id 는 기판이 발급하는 불투명 문자열이다** — 클라이언트가 짓지 않는다.

### 하네스 설정

`harness.info()` / `models()` / `commands()` / `setModel(m)` / `setEffort(l)` — 전부 얇은
래퍼다. 기판이 `capabilities` 로 선언하지 않은 동사는 호출 즉시 `E_UNSUPPORTED` 로 돌아온다
(선언 없이 되는 척하지 않는다). 모델·계정 설정 UI 는 콘솔과 위젯이 이미 갖고 있다.

### 메타

- `ready` — `Promise<ChatMeta>`. 첫 화면 그리기 전에 기다리면 인사말·에이전트 목록이 있다
- `meta()` → `{ found, display_name, greeting, model, effort, agents, agent }`
- `history` — 현재 세션의 메시지 배열 (로드는 자동)
- `session` / `busy` / `capabilities` / `protocol` — getter

## 계약을 직접 말할 때

SDK 없이 왕복하려면 전송 계약 v1(`docs/client-protocol.md`)을 그대로 쓴다:

```
POST {base}/turns   {message, session, attachments?}   → 202 {turn, session}
GET  {base}/turns/<turn>/stream                        → SSE
```

SSE 의 `data:` 한 줄이 봉투 이벤트 JSON 하나다. 종결은 `reply`/`error` 정확히 하나이고,
스트림의 마지막은 `{event:"turn",status:"settled",ok}` 다 — settled 없이 끊긴 스트림은
종결이 아니라 절단이므로 빈 답으로 위장하지 마라.

## 테마 변수

위젯 색·글꼴은 전부 `--rc-*` 변수의 재정의로 맞춘다:

| 변수 | 자리 |
|---|---|
| `--rc-accent` / `--rc-accent-strong` / `--rc-accent-soft` | 주색·강조·연한 강조 |
| `--rc-bg` / `--rc-panel` / `--rc-surface` / `--rc-ground` | 바탕 층 |
| `--rc-ink` / `--rc-fg` / `--rc-fg-dim` / `--rc-soft` / `--rc-faint` | 본문·보조 텍스트 |
| `--rc-line` / `--rc-line-soft` / `--rc-border` / `--rc-border-soft` | 경계선 |
| `--rc-ok` / `--rc-err` / `--rc-danger` | 판정 색 |
| `--rc-sans` / `--rc-mono` / `--rc-radius` | 글꼴·모서리 |
