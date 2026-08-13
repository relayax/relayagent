# @relay/relayjs

Relay FE SDK. 채팅 코어(하네스 호출 클라이언트)와 위젯.

위젯은 하네스와의 연결지점이라 구현이 기판과 함께 움직인다. 그래서 패키지 view 소유물이 아니라
기판 소유 자산이고, 소비 경로는 세 가지다.

## 1. npm 임포트 (커스텀 GUI, 콘솔)

```js
import { createChat } from "@relay/relayjs";

const chat = createChat({ pkg: "diary", slot: "kiosk" });
chat.on("message", (m) => render(m));      // { role: "user"|"bot"|"sys", text }
chat.on("busy", (b) => spinner(b));
await chat.send("오늘 하루 정리해줘");        // { reply } 또는 { error: { code, message } }
```

- 모든 호출은 throw 하지 않는다. 실패는 `{ error: { code, message } }` 로 돌아온다.
- busy 중의 send 는 버리지 않고 줄 세운다. 같은 slot 에 세션이 동시에 뜨면 충돌하기 때문.
- 화면 맥락은 `send(질문, { scene: 스냅샷 })` 으로 싣는다. 합성은 기판 몫이다 —
  세션 프롬프트에 서문으로 붙고, 말풍선과 이력에는 질문 원문만 남는다 (첨부와 같은 계약).
- 하네스 설정 표면: `chat.harness.models() / setModel() / setup() / info() / commands() / variants() / setVariant()`

위젯을 UI 째로 심으려면:

```js
import { mount } from "@relay/relayjs/widget";
mount({ pkg: "diary", mode: "inline", target: document.getElementById("chat") });
```

레포 안에서는 file: 의존성으로 쓴다: `"@relay/relayjs": "file:../../../../lib/relayjs"`

## 2. 기판 정적 서빙 (패키지 view)

기판이 이 디렉토리를 `/assets` 로 서빙한다. 패키지 view 문서에는 한 줄이면 된다:

```html
<script type="module" src="/assets/chat-widget.js"></script>
```

URL(`/pkg/<이름>/view/`)의 패키지로 우측하단 부유 위젯이 자동 마운트된다.
자동 마운트를 끄려면 로드 전에 `window.RELAY_CHAT_MANUAL = true`.

## 3. 구 경로 shim

`/pkg/system/view/chat-widget.js` 는 `/assets/chat-widget.js` 로 넘기는 호환 shim 이다.
새 코드는 /assets 경로를 쓴다.
