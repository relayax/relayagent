---
name: agent-chat
description: 에이전트 패키지에 대화 표면(채팅)을 붙일 때 읽는다. 채팅 화면 선언, 기판 위젯 마운트, 화면 안 컴포넌트형 채팅, 화면 맥락 주입, 커스텀 채팅 UI가 필요해 보이는 순간의 판단 기준. 패키지에 채팅·대화창·말풍선·도우미가 필요하거나 view에서 에이전트와 대화해야 하면 채팅 UI를 만들기 전에 이 스킬을 먼저 읽어라.
---

# 에이전트 채팅 붙이기

채팅 위젯은 하네스와의 연결지점이라 구현이 기판과 함께 움직인다. 패키지 view 소유물이 아니라
기판 소유 자산이고, 기판이 `/assets` 로 직접 서빙한다. **채팅 UI 를 직접 만들지 마라.**
세션 탭, 첨부(파일선택·드래그·붙여넣기), 진행 표시, 이력 복원, 모델 설정이 전부 공짜로 오고,
기판 API 가 바뀌면 위젯도 같이 바뀐다. 직접 만든 사본은 그 순간부터 조용히 어긋난다.

## 결정 사다리

싼 것부터. 위 단계로 충분하면 아래로 내려가지 마라.

1. **전용 화면이 필요 없다** — 매니페스트 선언 하나면 끝이다:
   ```yaml
   surfaces:
     chat: { mode: direct, greeting: 무엇을 도와드릴까요? }
   ```
   view 없이도 기판이 `/pkg/<이름>/view/` 에 전체 화면 대화를 만들어 준다. view 를 만들지 마라.
   greeting 은 빈 대화의 시작 인사말로 화면에 그려진다.

2. **화면이 있고, 대화는 곁에 있으면 된다** — view 문서에 한 줄:
   ```html
   <script type="module" src="/assets/chat-widget.js"></script>
   ```
   URL 의 패키지로 우측하단 부유 위젯이 자동 마운트된다.

3. **대화가 화면 안의 컴포넌트여야 한다** — 자동 마운트를 끄고 inline 으로 직접 심는다:
   ```html
   <script>window.RELAY_CHAT_MANUAL = true</script>
   <div id="chat" style="height:520px"></div>
   <script type="module">
     import { mount } from "/assets/chat-widget.js";
     const pkg = decodeURIComponent(location.pathname.match(/^\/pkg\/([^/]+)\/view/)[1]);
     mount({ pkg, mode: "inline", target: document.getElementById("chat") });
   </script>
   ```

4. **UI 자체를 앱 디자인에 녹여야 한다** (말풍선 하나, 한 줄 입력 같은 도우미) — 위젯 대신
   코어를 쓴다. UI 없는 클라이언트라 화면은 자유이고, 전송 큐·이력 복원·첨부는 기판 계약 그대로다:
   ```js
   import { createChat } from "/assets/chat-core.js";
   const chat = createChat({ pkg });
   chat.on("message", (m) => render(m));   // { role: "user"|"bot"|"sys", text }
   chat.on("busy", (b) => spinner(b));
   await chat.send("질문");                 // { reply } 또는 { error: { code, message } }
   ```

어느 단계에서든 "화면 맥락을 주입해야 하니까"는 사다리를 건너뛸 이유가 못 된다 — 바로 아래 레시피가 있다.

## React view 라면

3·4단을 손으로 배선하지 말고 이 스킬의 템플릿 [assets/relay-chat.tsx](assets/relay-chat.tsx) 를
view 소스에 복사하라. `<RelayChat />` 이 3단(inline 위젯), `RelayChatProvider` + `useRelayChat()` 이
4단(커스텀 UI)이다. 템플릿은 기판이 서빙하는 코어를 런타임에 불러오는 계약 소비자라 복사해도
썩지 않는다 — 사본 금지는 코어·위젯 자체에 대한 것이다. `<RelayChat />` 을 쓰는 화면에는
2단의 자동 마운트 한 줄을 같이 넣지 마라. 부유 위젯이 중복으로 뜬다.

## 화면 맥락 주입

`send` 의 `scene` 옵션이 화면 스냅샷을 세션에 실어 보낸다. 합성은 기판 몫이다 —
세션 프롬프트에는 서문으로 붙고, 말풍선과 이력에는 질문 원문만 남는다 (첨부와 같은 계약):

```js
await chat.send(질문, { scene: `화면: ${현재탭}\n선택: ${선택항목.id}` });
```

스냅샷은 "지금 보이는 것"의 요약이면 충분하다 — 앱 상태 전체를 직렬화하지 마라.
위젯을 심었어도 `mount()` 가 돌려주는 `client` 로 같은 호출을 할 수 있다.
맥락 주입 때문에 채팅 UI 를 재작성하는 것은 틀린 결론이다 (2026-08 실측 — 빌더가 이 옵션을
몰라 위젯 전체를 다시 만들었다). 손으로 합성해야 할 특수한 경우에만 `display` 를 쓴다:
`chat.send(맥락 + "\n" + 질문, { display: 질문 })` — 이력에 맥락이 섞여 남는 것이 차이다.

## 함정 (실측)

- **npm 의존성으로 잡지 마라.** `@relay/relayjs` 는 npm 에 발행되지 않았다. `file:` 의존성은
  기판 레포 내부 전용이다. 패키지 view 의 정본 소비 경로는 런타임 URL(`/assets/...`) 임포트다.
  프레임워크 컴포넌트 안에서 `import("/assets/...")` 를 쓰면 번들러가 절대 URL 을 자기 모듈로
  해석하려 든다 — script 태그로 로드하거나 번들러의 external/ignore 표시를 쓰라.
- **사본을 뜨지 마라.** 위젯을 `public/` 에 복사하거나 빌드 산출물에 인라인하면 기판이 갱신될 때
  낡은 사본이 새 기판 API 와 어긋나 조용히 깨진다. 기판이 no-store 로 서빙하는 이유가 그것이다.
- **설치 이름을 하드코딩하지 마라.** 화면은 `/pkg/<설치이름>/view/` 아래로 서빙되고 설치 이름은
  설치 시점에 정해진다. 위 3단 레시피처럼 `location.pathname` 에서 파싱하라.
- **테마는 CSS 변수로 맞춘다.** `--rc-accent`, `--rc-bg`, `--rc-ink`, `--rc-line` 등 `--rc-*`
  변수를 재정의하면 위젯이 화면의 색·글꼴을 따라온다. 위젯 내부 클래스(`.rw-*`)를 셀렉터로
  잡지 마라 — 내부 구조는 계약이 아니다.
- **에이전트가 여럿이면 착지를 정하라.** 기본은 패키지 짧은 이름과 같은 착지 에이전트다.
  특정 서브에이전트와의 대화창이면 `mount({ agent })` / `createChat({ agent })` 로 명시한다.

## 검증

발행 후 `/pkg/<이름>/view/` 를 열어 위젯이 뜨고 한 턴이 오가는지 확인하라. 세션 이력·첨부·
진행 표시·모델 설정은 기판 장부 소관이라 위젯이 공짜로 준다 — 이 중 하나라도 재구현하고 있다면
그것이 잘못의 신호다.

코어와 위젯의 전체 표면(세션 관리, 하네스 설정, 업로드, 취소, 이벤트, 테마 변수 전체)은
[references/client-api.md](references/client-api.md) 에 있다.
