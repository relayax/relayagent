---
name: agent-chat
description: 에이전트 패키지에 대화 표면(채팅)을 붙일 때 읽는다. 채팅 화면 선언, 기판 위젯 마운트, 화면 안 컴포넌트형 채팅, React 바인딩, 화면 맥락 주입까지. 패키지에 채팅·대화창·말풍선·도우미가 필요하거나 view에서 에이전트와 대화해야 하면 채팅 UI를 만들기 전에 이 문서를 먼저 읽어라.
---

# 에이전트 채팅 붙이기

에이전트 패키지의 화면(view)에 대화 기능을 넣는 방법을 다룬다. 결론부터 말하면
**채팅 UI 를 처음부터 만들 일은 거의 없다.** 기판(relay 데몬)이 완성된 채팅 클라이언트를
모든 패키지에 제공하고, 이 문서는 그것을 상황에 맞게 꽂는 방법이다.

## 기판이 주는 것

기판은 두 모듈을 정적 자산으로 서빙한다. 어느 패키지 화면에서든 URL 로 바로 불러 쓴다.

| 모듈 | 무엇인가 | 언제 쓰나 |
|---|---|---|
| `/assets/chat-widget.js` | 완성된 채팅 UI. 세션 탭, 첨부(선택·드래그·붙여넣기), 진행 표시, 이력 복원, 모델 설정 포함 | 완성 UI 가 필요할 때 |
| `/assets/chat-core.js` | UI 없는 클라이언트. 전송 큐, 이력, 업로드, 세션 관리만 제공 | 화면을 직접 그릴 때 |

이 둘은 하네스(에이전트 CLI)와의 연결지점이라 기판과 함께 갱신된다(no-store 서빙).
기판의 대화 API 가 바뀌면 모듈도 같이 바뀌므로 화면이 깨지지 않는다. 직접 만든 채팅 UI 나
복사해 둔 사본에는 그 보장이 없다 — 조용히 어긋난다.

## 네 가지 시나리오

필요한 만큼만 내려가라. 위 시나리오로 충분하면 아래를 만들지 마라.

### 1. 대화만 있으면 된다 — 화면 없이

패키지가 대화형 도우미라 전용 화면이 필요 없는 경우. 매니페스트 선언으로 끝난다:

```yaml
surfaces:
  chat: { mode: direct, greeting: 무엇을 도와드릴까요? }
```

view 디렉토리 없이도 기판이 `/pkg/<이름>/view/` 에 전체 화면 대화를 만들어 준다.
greeting 은 빈 대화의 시작 인사말로 그려진다.

### 2. 화면이 있고, 대화는 보조 — 자동 마운트

대시보드나 목록 같은 화면이 주인공이고 대화는 곁에 떠 있으면 되는 경우. view 문서에 한 줄:

```html
<script type="module" src="/assets/chat-widget.js"></script>
```

URL 의 패키지로 우측 하단에 부유 위젯이 자동으로 마운트된다.

### 3. 대화가 화면 안의 영역 — inline 수동 마운트

레이아웃의 한 영역(사이드 패널, 하단 반쪽)이 대화여야 하는 경우. 자동 마운트를 끄고
원하는 자리에 직접 심는다:

```html
<script>window.RELAY_CHAT_MANUAL = true</script>
<div id="chat" style="height:520px"></div>
<script type="module">
  import { mount } from "/assets/chat-widget.js";
  const pkg = decodeURIComponent(location.pathname.match(/^\/pkg\/([^/]+)\/view/)[1]);
  mount({ pkg, mode: "inline", target: document.getElementById("chat") });
</script>
```

패키지 이름을 URL 에서 파싱하는 이유: 화면은 `/pkg/<설치이름>/view/` 로 서빙되는데
설치 이름은 설치 시점에 정해진다. 하드코딩하면 다른 이름으로 설치된 곳에서 깨진다.

### 4. 대화 UI 가 앱 디자인의 일부 — 코어 위에 직접 그리기

말풍선 하나, 한 줄 입력처럼 UI 자체가 앱 디자인에 녹아야 하는 경우에만. 코어는 화면이
없으므로 마음대로 그리되, 전송 큐·이력 복원·첨부는 기판 계약 그대로 쓴다:

```js
import { createChat } from "/assets/chat-core.js";
const chat = createChat({ pkg });
chat.on("message", (m) => render(m));   // { role: "user"|"bot"|"sys", text }
chat.on("busy", (b) => spinner(b));
await chat.send("질문");                 // { reply } 또는 { error: { code, message } }
```

전체 메서드·이벤트 표면은 [references/client-api.md](references/client-api.md) 에 있다.

## React 로 만든다면

시나리오 3·4 를 손으로 배선하지 말고 템플릿 [assets/relay-chat.tsx](assets/relay-chat.tsx) 를
view 소스에 복사하라. 세 가지가 들어 있다:

- `<RelayChat />` — 시나리오 3. 위젯을 inline 으로 심는 컴포넌트
- `RelayChatProvider` + `useRelayChat()` — 시나리오 4. 코어를 React 상태로 구독하는 headless 훅
- `pkgFromUrl()` — URL 에서 설치 이름 파싱

템플릿은 기판이 서빙하는 코어를 런타임에 불러오는 소비자일 뿐이라 복사해도 썩지 않는다
(아래 "사본" 이야기는 코어·위젯 자체에 대한 것이다). 단, `<RelayChat />` 을 쓰는 화면에
시나리오 2 의 자동 마운트 한 줄을 같이 넣으면 부유 위젯이 중복으로 뜬다 — 하나만 쓴다.

## 화면 맥락 주입 — "지금 보는 것"을 알고 답하게

사용자가 보고 있는 탭이나 선택된 항목을 에이전트가 알고 답해야 한다면, `send` 의 `scene`
옵션에 화면 스냅샷을 실어라:

```js
await chat.send(질문, { scene: `화면: ${현재탭}\n선택: ${선택항목.id}` });
```

합성은 기판 몫이다 — 세션 프롬프트에는 서문으로 붙고, 말풍선과 대화 이력에는 질문 원문만
남는다(첨부와 같은 계약). 스냅샷은 "지금 보이는 것"의 요약이면 충분하다. 앱 상태 전체를
직렬화하지 마라. 위젯을 심었어도 `mount()` 가 돌려주는 `client` 로 같은 호출을 할 수 있다.

맥락 주입 때문에 채팅 UI 를 재작성하는 것은 틀린 결론이다(2026-08 실측 — 빌더가 이 옵션을
몰라 위젯 전체를 다시 만들었다). 프롬프트를 손으로 합성해야 하는 특수한 경우에만 `display`
를 쓴다: `chat.send(맥락 + "\n" + 질문, { display: 질문 })`. 이력에 맥락이 섞여 남는 것이 차이다.

## 흔한 실수

- **npm 의존성으로 잡는다.** `@relay/relayjs` 는 npm 에 발행되지 않았고, `file:` 의존성은 기판
  레포 내부 전용이다. 정본 소비 경로는 런타임 URL(`/assets/...`) 임포트다. 번들러가 절대 URL 을
  자기 모듈로 해석하려 들면 script 태그로 로드하거나 React 템플릿의 우회를 쓰라.
- **사본을 뜬다.** 위젯·코어를 `public/` 에 복사하거나 빌드 산출물에 인라인하면 기판이 갱신될 때
  낡은 사본이 새 기판 API 와 어긋나 조용히 깨진다. 반드시 `/assets` URL 로 불러라.
- **설치 이름을 하드코딩한다.** 시나리오 3 처럼 `location.pathname` 에서 파싱하라.
- **위젯 내부 클래스로 스타일링한다.** 테마는 `--rc-accent`, `--rc-bg`, `--rc-ink`, `--rc-line`
  같은 `--rc-*` CSS 변수 재정의로 맞춘다. 내부 클래스(`.rw-*`)는 계약이 아니라 언제든 바뀐다.
- **에이전트가 여럿인데 착지를 안 정한다.** 대화는 기본으로 패키지 짧은 이름과 같은 에이전트에
  착지한다. 특정 서브에이전트와의 대화창이면 `mount({ agent })` / `createChat({ agent })` 로 명시한다.

## 완성 확인

발행 후 `/pkg/<이름>/view/` 를 열어 위젯이 뜨고 한 턴이 오가는지 확인한다. 세션 이력, 첨부,
진행 표시, 모델 설정은 위젯이 공짜로 준다 — 이 중 하나라도 직접 구현하고 있다면 잘못된 길로
들어선 신호다.
