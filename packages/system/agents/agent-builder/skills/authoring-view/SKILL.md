---
name: authoring-view
description: 패키지의 화면(surfaces.view)을 지을 때 읽는다. 무빌드 화면과 번들형 화면의 갈림, 화면이 동사를 부르는 법, 화면과 에이전트가 한 데이터를 함께 쓰는 왕복. 패키지에 화면·대시보드·워크벤치·목록이 필요하면 짓기 전에 이 문서를 먼저 읽어라. 대화 표면 자체는 agent-chat 이 다룬다.
---

# 화면 짓기

화면이 기판과 말하는 길은 셋뿐이다. 이 셋을 넘어가려 하면 대개 길을 잘못 든 것이다.

| 무엇 | 어떻게 | 방향 |
|---|---|---|
| **좌표** | `window.__RELAY_CONTEXT` (기판이 서빙 시점에 심는다) | 기판 → 화면 |
| **동사** | `POST {base}/script/<이름>` | 화면 → 기판 |
| **브리지** | `setScene` · `openChat` · `onAgentTurn` (`@relay/chat`) | 화면 ↔ 같은 문서의 위젯 |

## 두 형태 중 고르기

```yaml
surfaces:
  view:
    source: surfaces/view      # out 없음 = 무빌드. index.html 을 그대로 서빙한다
```

```yaml
surfaces:
  view:
    source: surfaces/view
    out: out                   # 있음 = 설치가 굽는다(Next 정적 산출)
```

**무빌드를 먼저 시도하라.** `index.html` 한 장에 인라인 CSS·스크립트면 충분한 화면이 아주
많다. 빌드가 없으면 설치가 빠르고, 의존성이 없고, 고칠 때 다시 굽지 않아도 된다.

번들형은 **React 상태가 실제로 필요할 때만** 쓴다 — 폼이 여럿이고 라우팅이 있고 브리지의
`AgentScope`·`useAgentBinding` 을 쓰는 화면. 이때 `next.config.mjs` 는 `output: "export"`,
`basePath` 는 `process.env.RELAY_BASE_PATH` 에서 읽는다. **직접 `npx next build` 하지 마라** —
접두사가 비어 구워져서 서빙된 화면이 자기 스타일시트를 404 받는다. 굽는 길은 하나다:

```sh
relay build <패키지>
```

## 좌표 — 파싱하지 말고 읽어라

```js
const ctx = window.__RELAY_CONTEXT;   // { base: "/pkg/<설치이름>", root, instanceId }
const base = ctx.base;
```

설치 이름은 설치 시점에 정해진다. 화면은 그것을 알 필요가 없고, 알려고 URL 을 파싱하면
다른 마운트에 서는 순간 깨진다.

## 동사 부르기 — 화면의 백엔드

`scripts/` 의 동사는 에이전트만의 것이 아니다. 화면도 같은 함수를 부른다.

```js
async function verb(name, input = {}) {
  const res = await fetch(`${base}/script/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(data?.error ?? `${res.status}`);
  return data.result;
}

const { offers } = await verb("workbook-list");
```

**동사를 화면용·에이전트용으로 나누지 마라.** 같은 동사를 둘이 부르는 것이 요점이다 —
사용자가 화면에서 저장한 것을 에이전트가 그대로 읽고, 그 반대도 성립한다. 저장 로직을
화면에 두면(fetch 로 남의 API 를 직접 두드리면) 에이전트는 그 데이터를 모른다.

## 한 바퀴 — 화면과 에이전트가 같은 것을 본다

워크벤치형 화면의 기본형이다. 셋을 배선하면 완성된다.

```
① setScene(지금 보는 것)        사용자가 무엇을 보는지 위젯에 밀어 둔다
② 사용자가 대화한다              에이전트가 동사로 데이터를 고친다
③ onAgentTurn(settled) → 재조회  화면이 바뀐 데이터를 다시 읽는다
```

```tsx
import { AgentScope, setScene, onAgentTurn } from "@relay/chat";

<AgentScope agent="coach" param={offerName}>   {/* 이 화면의 대화는 이것 */}
  <Workbench />
</AgentScope>

useEffect(() => { setScene(`오퍼 ${offerName}, 시트 ${sheet} 편집 중`); }, [offerName, sheet]);
useEffect(() => onAgentTurn((s) => { if (s.phase === "settled") void reload(); }), []);
```

`onAgentTurn` 의 payload 는 **재조회 트리거로만** 쓴다. 상태로 쓰면 이벤트 한 번 유실에
화면이 멈춘다 — 정본은 언제나 기판이고, 화면은 다시 물어보면 된다.

**무빌드 화면도 같은 왕복을 쓴다.** 브리지의 전달은 CustomEvent 라서 npm 임포트가 필요 없다 —
`@relay/chat` 은 그 위에 얹은 React 편의일 뿐이다. `index.html` 한 장이면 이렇게 쓴다:

```js
// 화면 → 위젯
window.dispatchEvent(new CustomEvent("relay:scene", { detail: { scene: `오퍼 "${offer}" 편집 중` } }));

// 위젯 → 화면
window.addEventListener("relay:turn", (e) => {
  if (e.detail?.phase === "settled") void reload();
});
```

이 배선을 넣기 전 offer-workbook 화면은 **6초마다 폴링**하고 있었다 — 코치가 답을 저장해도
최대 6초 뒤에야 진행률이 움직였다. 신호를 받으니 그 자리에서 따라오고, 폴링은 30초 그물로
물러났다(신호는 힌트지 보장이 아니다 — 다른 탭·채널에서 고친 것은 이 축에 오지 않는다).

## 데이터의 거처

화면이 만드는 것은 사람이 열 수 있는 파일이어야 한다. `services[].dir` 로 폴더를 선언하고,
동사가 그 안에 쓴다. `localStorage` 는 거처가 아니다 — 에이전트가 못 읽고, 사용자가 못 열고,
백업도 안 된다.

## 흔한 실수

- **`npx next build` 를 직접 돌린다.** 접두사가 빠져 서빙된 화면이 자기 청크를 404 받는다.
  빌드는 통과하므로 증상이 빌드 오류처럼 안 보인다. `relay build <패키지>` 만 쓴다.
- **고치고 다시 굽지 않는다.** `out` 을 선언한 화면은 기판이 **발행물**을 서빙한다.
  소스만 고치면 옛 화면이 계속 나간다. `npm run validate` 가 이 낡음을 판정한다.
- **URL 에서 설치 이름을 파싱한다.** 좌표는 주입된다.
- **화면이 자기 저장소를 갖는다.** 에이전트와 갈라진 데이터가 생긴다. 저장은 동사로.
- **화면만 있고 대화 진입이 없다.** 화면을 짓는 패키지는 위젯 배선을 기본으로 고려하라
  (agent-chat 시나리오 2 — 두 줄이면 된다).

## 완성 확인

발행 후 `/pkg/<이름>/view/` 를 연다. 셋을 확인하라:

1. 화면이 뜨고 스타일이 살아 있는가 (죽었으면 접두사 문제 — 다시 구웠는가)
2. 동사가 도는가 (버튼 하나 눌러 데이터가 바뀌는지)
3. 대화로 시킨 일이 **화면에 반영되는가** (반영이 안 되면 `onAgentTurn` 재조회가 빠졌다)
