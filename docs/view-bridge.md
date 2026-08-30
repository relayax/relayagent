# 뷰-채팅 브리지 계약 (view bridge)

**같은 브라우저 문서 안**에서 패키지 view 화면과 채팅 위젯이 주고받는 인페이지 계약.
정본은 이 문서(`relayagent-oss/docs/view-bridge.md`)이고, 구현체는 둘이다 — OSS 부유
크롬(`chat/src/chat/main.tsx` autoFloat)과 relayos RelayProvider 크롬
(relayos `chat/src/agent.tsx`). 두 구현체는 이 문서에 맞춰 정렬되며, 어느 쪽의
현행 wire 도 정본이 아니다.

> **개정 이력 — 2026-08-29 (§5-17 거동 변경 · additive 아님).** 페이지 선언의 착지가
> **"페이지가 곧 대화"에서 "페이지는 좌표를 알려 줄 뿐"으로** 바뀌었다. 크롬은 이제 선언마다
> preview 탭을 밀지 않고 좌표만 위젯에 넘긴다(`declarePage`) — 탭과 활성 대화는 사람의
> 것이다. 어휘(`relay:scope` 이벤트·detail)는 한 바이트도 안 바뀌었고 뷰 쪽은 무변경이다.
> *왜 바꾸나: 종전 규칙은 사이드바로 화면을 옮기는 것만으로 보던 대화를 갈아치웠고, 그 대가가
> 가장 컸던 자리가 **위임**이다. 위임(a2a·서브에이전트)의 📬 배달 주소는 발신 슬롯 —
> 페이지가 아니라 대화 — 인데, 화면이 페이지를 따라가면 맡긴 일이 어디서 도는지 볼 자리가
> 사라진다. 두 규칙(배달은 대화로, 화면은 페이지로)이 정면으로 어긋났던 것이지 UX 취향의
> 문제가 아니었다. 짝이 되는 기판 개정은 client-protocol §2-6-a(`baseFor` 주입) 다 — 그게
> 없으면 위젯이 한 번에 한 패키지만 볼 수 있어 "탭을 안 뺏는다"가 성립하지 않는다.*
> **relayos 에 정렬할 코드는 없다 — 남는 것은 핀 하나다** [2026-08-29 실측]. §8-22-5 가 적어
> 둔 "서빙 번들의 정본은 OSS 릴리스 아티팩트"가 그 사이 종착까지 갔다: relayos 트리에는 크롬
> 소스(`agent.tsx`·`ChatChrome`·`useDeclaredScope`)가 더 이상 없고, `runner/oss/` 는
> **gitignore 된 전개 자리**다 — `deploy/release.sh` 가 `deploy/relayagent.lock` 의 핀으로
> `runner`·`chat-widget` 아티팩트를 받아 푼다(구 `vendor-relayagent.mjs` 는 2026-08-24 은퇴).
> 그러므로 이 개정이 relayos 박스에 닿는 절차는 **릴리스 컷 + lock 의 `releases.chat-widget`·
> `releases.runner` digest bump** 이고, 그전까지 relayos 는 옛 거동(선언이 preview 탭을 미는
> 판)을 그대로 돈다. 아래 §8·부록 A 의 `relayos 현행` 좌표(agent.tsx …)는 **그 수렴 이전의
> 역사 근거**로만 읽는다.

현재 계약 버전: **1** (초안). 이 축은 client-protocol(브라우저↔기판, HTTP —
[client-protocol.md](client-protocol.md))·하네스 봉투(기판↔어댑터 —
[harness-protocol.md](harness-protocol.md))와 **별개의 축**이다. client-protocol §1-3 이
"범위 밖"으로 남겨 둔 자리가 정확히 이 문서다.

> **인용 규약**: OSS 좌표(`chat/src/...`)는 현 트리 실측이다 — §8-22 의 ②③④ 컷
> (2026-08-24)이 착지해 OSS 가 전 조항의 정본 구현을 든다. relayos 좌표(relayos
> `chat/src/agent.tsx` 등)는 **동작 원본**이었고, 정렬 컷(§8-22-5 — 2026-08-24)에서
> 재벤더링 소비자로 수렴했다(client-protocol §9-47-4 와 같은 레일): agent.tsx 는 크롬만
> 소유하고 선언·발신 표면은 벤더 bridge 를 재수출한다.
> 표기: **[현행 v1]** = 이 계약이 정의하고 OSS 에 착지한 조항 · **[현행-위젯]** = 컷 전부터
> OSS 위젯에 있던 수신부(원출처 구 deployd 셸 중계).

## 1. 지위와 범위 — 세 역할

1. 이 계약의 참여자는 셋이다:
   - **뷰** — 패키지 화면(Next static export 등). 브리지의 **발신자**다.
   - **크롬** — 위젯을 도킹하는 셸의 소유자. 브리지의 **중계자**다. 실측: OSS 부유
     위젯(chat/main.tsx:110-263 autoFloat) · relayos ChatChrome(agent.tsx:360-635) ·
     `mountTabs` 를 직접 부르는 임의 임베더.
   - **위젯** — React 채팅 앱(ChatTabs/ChatApp). 브리지의 **수신자**다.
   *왜 역할이 셋인가: 위젯은 자기 마운트 타이밍도 패널 개폐도 모른다. 그걸 아는 쪽(크롬)이
   중계와 재시도를 소유해야 전달이 성립한다 — 뷰가 위젯에 직접 쏘면 마운트 전 발신이
   전부 유실된다.*
2. 이 계약은 **한 window 안**의 소통만 규정한다. HTTP 왕복(턴·세션·파일)은 전부
   client-protocol 소관이고, 뷰의 동사 호출(`/api/scripts`·MCP)은 verb 계약 소관이다.
3. **익명의 제3자 임베더 테스트.** 어떤 이벤트·필드도 relayos 만 쓸 수 있는 형태면 안 된다.
   org 의미(principal, 멤버, 라이선스)는 이 계약에 등장하지 않는다.
4. **스큐 전제 — 이 축에 클린 브레이크는 없다.** 뷰 번들은 설치 시점에 구운 산출물이고
   (CLAUDE.md "빌드 산출물 ②" — `out/` 는 동결된 화면), 위젯은 no-store 로 기판과 원자적으로
   움직인다(client-protocol §9-43). 즉 **구운 뷰 + 새 위젯** 조합이 구조적으로 상존한다.
   그래서 이 계약의 규율은 client-protocol 과 반대다: 어휘는 **additive 로만** 자라고,
   수신자는 미지 이벤트·미지 detail 필드를 **무시**하며(E_PROTOCOL 상당의 fail-loud 없음),
   전달 확인은 버전 협상이 아니라 **ack**(§4-10)로 한다.
   *왜: 버전 게이트를 세우면 뷰를 전부 재빌드하기 전까지 브리지가 죽는다. 이 축의 실패
   모드는 "옛 뷰가 새 기능을 모른다"뿐이어야 한다 — "옛 뷰 때문에 아무것도 안 된다"가
   아니라.*

## 2. 슬롯 좌표 — 조립 단일 지점

5. 대화 스레드 슬롯 문법은 `"main" | "agent-<name>[:<param>][~<id8>]"` 이고, 문법 정본은
   `chat/src/chat/routematch.ts`(스레드 패밀리·sibling·`paramTargets` — 서버
   parseAgentSlot 의 쌍둥이)다. **조립 지점은 @relay/chat 바인딩 층 하나다**(`slotFor` —
   [현행 v1] chat/src/bridge.tsx). 뷰 앱 코드와 크롬은 슬롯 문자열을 **손으로**
   조립하지 않는다 — `openChat` 의 `conversation` 에 실어 보낼 값은 바인딩 층이 준 것
   (`useAgentBinding().conversation` 등)뿐이다.
5-a. **`slotFor` 의 npm 표면 — 서브패스, 루트 아님.** 페이지 선언(§5) 대신 프로바이더 prop
   으로 대상을 못박는 크롬(고정 바인딩)은 `{agent, param}` 을 슬롯 문자열로 바꿔야 하고,
   그 변환의 합법적 통로는 `slotFor` 하나다. 그래서 `slotFor`·`AgentBinding` 은
   `@relay/chat/bridge` 서브패스로 공개한다 — 루트(`@relay/chat`)에는 두지 않는다.
   *왜 이 모양인가: 크롬은 §1-1 이 세는 세 역할 중 하나이고 그 자리에는 `mountTabs` 를 직접
   부르는 **임의 임베더**도 앉는다. 표면이 닫혀 있으면 그런 임베더는 패키지 내부 경로를 직접
   수입하거나(핀이 깨지면 같이 깨진다) 문자열을 손으로 붙이게 되는데, 후자가 바로 이 조항이
   금지하는 것이다 — 닫아 두는 쪽이 §2-5 를 어기게 만든다. 반대로 루트에 두면 뷰 앱 코드의
   자동완성에 뜬다: 앱의 슬롯 원천은 `useAgentBinding()` 뿐이어야 하므로(위) 루트는 비운다.
   서브패스는 "나는 크롬이다"라는 명시적 선언이고, `./client`(headless·react 무의존)와 같은
   결의 관객 분리다. `slotFor` 자체는 `{agent, param} → string` 순수 함수라 org 의미
   (principal·멤버·라이선스)가 없다 — §1-3 익명 제3자 임베더 테스트를 통과한다.*
6. 슬롯은 **씨앗 좌표**다. 첫 발화 때 `session.create` 가 기판 발급 불투명 id 로 민팅하고
   (client-protocol §5.3-22), 그 뒤 대화 정체성의 정본은 세션 메타(`agent`·`param`,
   §5.3-21)다. 브리지는 민팅 전 좌표만 나른다 — 민팅 후 재바인딩은 위젯 내부
   (`onSessionMinted`, ChatTabs.tsx:563-570)가 처리하며 브리지 표면에 나오지 않는다.

## 3. 동사 전량 (추상)

| 동사 | 방향 | 뜻 |
|---|---|---|
| `chat.open` | 뷰 → 크롬 | 패널 열기 + 대상 (인스턴스×대화) 탭 포커스 |
| `chat.prefill` | 뷰 → 크롬 → 위젯 | 컴포저 채움 — 사용자가 검토 후 전송 |
| `chat.send` | 뷰 → 크롬 → 위젯 | 자동 전송 — 컴포저 submit 과 같은 큐 의미론 |
| `scope.declare` | 뷰 → 크롬 | 페이지 정체성 선언 — "이 화면의 대화는 이것" (알림이지 명령이 아니다, §5-17) |
| `scene.set` | 뷰 → 위젯 | 화면 맥락 서문 공급 — turn.send 의 `scene` 필드 |
| `turn.signal` | 위젯 → 뷰 | 턴 수명주기 힌트 — "에이전트가 일을 시작했다/끝냈다" (§6-a, 유일한 역방향) |

`chat.prefill`/`chat.send` 는 wire 에서 `chat.open` 의 detail 필드로 실려 온다(§4-7) —
패널이 닫혀 있으면 열어야 꽂을 자리가 생기므로, 열기와 주입은 한 동사의 두 필드다.

## 4. wire — 이벤트 어휘

7. **[현행 v1]** `chat.open` = `CustomEvent("relay:chat-open", { detail })`,
   `detail: { instance?, conversation?, prefill?, send?, atts?, harness?, model? }`. 발신 공개 API 는
   `openChat(opts)` 하나다(정본: chat/src/bridge.tsx:59-63 · relayos 현행:
   agent.tsx:89-92 — 정렬 컷에서 재벤더링 수렴, §8-22-5). dispatch 실패(미배선 환경)는
   무시한다 — 브리지는 UX 어포던스이지 데이터 경로가 아니다.
8. 크롬의 `chat.open` 착지 — **대상 해석 규칙** (OSS: chat/main.tsx:217-237 · relayos:
   agent.tsx:168-189, 492-499):
   - 패널을 연다(닫혀 있었다면).
   - 명시 `instance` 는 그대로 존중한다 — `conversation` 이 있으면 그 대화, 없으면 그
     인스턴스의 열린 탭/씨앗으로 수렴(위젯 openReq 의 멱등 규칙, ChatTabs.tsx:703-731).
   - `conversation` 만 있는 호출(`instance` 생략)은 **크롬 자신의 좌표**(주입 instanceId)의
     그 대화다 — 단일 인스턴스 문서(패키지 view)의 자연형.
   - **대상 없는 `prefill`/`send`** 는 페이지가 선언한 슬롯(§5)으로 보낸다. 선언이 없으면
     대상 전환 없이 보던 탭에 꽂는다⋯ 가 아니라 **전환하지 않는다**(활성 탭 유지).
   - `instance` 해석은 크롬 자신의 좌표 지식으로 한다 — 주입 좌표(`__RELAY_CONTEXT`,
     client-protocol §2-6) 또는 기판이 자기 마운트를 아는 지식(relayos
     `instanceIdFromPath`). **뷰는 마운트 문법을 조립하지 않는다.**
   *왜 무선언이면 전환하지 않나: 아무 탭에나 꽂으면 그 글이 지금 활성인 — 대개 무관한 —
   에이전트에게 간다(agent.tsx:171-173 의 판정).*
   소비 실례: 스튜디오 오류 배너의 원클릭 "빌더에게"(prefill — agent.tsx:749-753), 지도
   "+ 패키지"(instance 열기).
8-a. **`atts`/`model` 은 `send` 의 동승 필드다**(2026-08-30 — 홈 "무엇을 만들까요?" 입력이
   사이드 챗 컴포저와 같은 세 가지 어포던스를 갖게 되면서). `prefill` 에는 뜻이 없다.
   - `atts: PendingAtt[]` — **스테이징을 마친** 첨부다. 인라인은 `dataUrl`, 사이드밴드는
     업로드가 끝난 참조(`path`). 전송 payload(`attToPayload`)로의 변환은 **받는 쪽이 한 번만**
     한다 — 보내는 쪽이 미리 바꾸면 이중 인코딩이 된다.
     *왜 File 을 싣지 않나: 크롬→위젯 구간이 postMessage 라 바이트를 나르는 자리가 아니다.
     업로드는 보내는 쪽이 끝내고, 이 이벤트는 그 결과만 나른다.*
   - `harness`/`model` — 착지한 위젯이 `harness.set` 으로 앉힌다. **모델 어휘는 하네스에
     딸리므로**(Claude·Codex·Gemini 의 모델 id 는 서로 남이다) 둘은 한 축이다: `harness` 가
     오면 `setHarnessAndModel`, 모델만 오면 `setModel`. 빈 값/생략은 기판이 쓰던 것 그대로.
     *적용 범위 주의 — 오버라이드가 앉는 자리는 대화가 아니라 **인스턴스 행**이다
     (`instances.list`, runtime.instanceRow). 사이드 챗의 모델 버튼과 같은 축이고, 대화
     하나만 갈아입히는 축은 이 계약에 없다. 홈에서 고른 모델은 그 인스턴스의 다른 대화에도
     걸린다.*
9. **[현행-위젯]** `chat.prefill`/`chat.send` 의 크롬→위젯 구간 =
   `window.postMessage({ type: "relay:chat-prefill" | "relay:chat-send", text, nonce },
   origin)` — same-origin 검사 필수. `chat.send` 는 §4-8-a 의 `atts`/`harness`/`model` 을
   같은 메시지에 동승시킨다(있을 때만). 위젯은 수신 즉시 `ev.source` 로
   `{ type: "relay:chat-prefill-ack" | "relay:chat-send-ack" }` 를 회신한다
   (Chat.tsx:2152-2199).
10. **재시도-until-ack** — 크롬은 ack 수신까지 250ms 간격으로 같은 `nonce` 를 재전송하고,
    상한(32회 ≈ 8초) 후 포기한다(OSS: chat/main.tsx:190-215 · relayos: agent.tsx:471-491).
    위젯은 같은 `nonce` 재수신을 no-op 한다(Chat.tsx:2159-2161, 2192-2194) — 재클릭은 새
    nonce 라 다시 동작한다.
    *왜: 크롬은 React 위젯의 마운트 타이밍을 모른다 — 1회 발신은 마운트 전이면 유실이고,
    ack 없는 반복은 이중 주입이다. ack+nonce 가 유일하게 둘 다 닫는다.*
11. **활성 pane 단독 소비.** 탭 셸이 pane 여럿을 마운트하면 postMessage 브로드캐스트를
    전부 받는다 — 활성 pane 만 소비·ack 하고 비활성은 무시한다(Chat.tsx:2155, 2188).
12. *왜 open 은 CustomEvent 이고 prefill/send 구간은 postMessage 인가: open 의 수신자
    (크롬)는 리스너 등록이 곧 존재 증명인 상시 실재라 fire-and-forget 이 성립한다.
    prefill/send 의 최종 수신자(위젯 React 트리)는 타이밍 미상이라 회신 채널이 필요한데,
    postMessage 는 `ev.source` 로 회신처가 붙는다. 전송 수단이 둘인 게 아니라 구간이
    둘인 것이다 — 뷰가 부르는 표면은 `openChat` 하나다.*
13. `chat.send` 의 의미론: 컴포저 submit 과 **같은 큐 의미론**이다 — 턴 실행/드레인 중이면
    큐잉, 유휴면 즉시 전송(Chat.tsx:2173-2182). 같은 세션의 직렬화는 기판 소유
    (client-protocol §5.1-12)라 브리지가 순서를 보장하지 않는다. 렌더 방식(말풍선이냐
    전용 카드냐)은 위젯 소유다 — 계약이 아니다.

## 5. 페이지 선언 — scope.declare

14. **[현행 v1]** 선언 표면은 `<AgentScope agent param? targets?>` 와
    `useAgentBinding()` 이다(정본: chat/src/bridge.tsx:131-169 · relayos 현행:
    agent.tsx:878-951 — 정렬 컷에서 재벤더링 수렴). `agent=""` 는 미등록(조건부 바인딩
    관용형)이다.
15. 중첩 판정: 바인딩 스택에서 **max(id) 승**이다 — 마운트=리바인딩, 언마운트=바깥 복귀,
    형제 동시 마운트=후승(bridge.tsx:72-90 · relayos agent.tsx:35-51). *왜 max(id):
    effect 는 자식→부모(bottom-up)로 발화하므로 "배열 끝=활성"으로 잡으면 중첩에서 바깥이
    이겨 스펙과 반대가 된다. id 는 렌더 단계(top-down)에 배정되므로 max(id)가 '안쪽 승 +
    형제 후승'을 둘 다 만족한다.*
16. **[현행 v1]** 선언의 wire = `CustomEvent("relay:scope", { detail })`,
    `detail: { conversation: string | null, targets?: string[] }`. 바인딩 층이 활성 바인딩
    변화마다 dispatch 한다(발신 bridge.tsx:92-102 · 착지 chat/main.tsx:239-263) —
    `conversation` 은 §2-5 의 슬롯 문자열, `null` 은 선언 부재(전부 언마운트)다.
16-a. **[현행 v1]** 부팅 레이스의 봉합 — `relay:scope-request`. 크롬은 자기 `relay:scope`
    리스너 등록 직후 `CustomEvent("relay:scope-request")` 를 1회 발신하고, 바인딩 층은
    현재 선언(부재면 `{conversation: null}`)을 **재방송**한다 — 발신 dedupe(§5-16)를
    우회한다(내용이 같아도 요청자에게는 첫 수신이다).
    *왜: 선언은 변화 때만 흐르는데 크롬(위젯 번들 — async 로드)과 뷰(하이드레이션)의 부팅
    순서는 비결정적이다 — 크롬이 늦으면 첫 선언을 놓치고 "페이지가 곧 대화"(§5-17)가 다음
    이동까지 죽는다. relayos 크롬 정렬 후에는 이 레이스가 구조적이기까지 하다(자식
    AgentScope 의 effect 가 뒤 형제 ChatChrome 의 effect 보다 먼저 발화한다). 요청-재방송이
    그 창을 닫는다. 바인딩 층 부재(브리지 미사용 뷰)면 응답이 없다 — 크롬의 기본 상태
    (선언 없음)와 일치하므로 레거시 뷰의 동작은 변하지 않는다.*
    *왜 wire 로 승격하나: relayos 는 크롬과 뷰가 한 React 트리라 context 로 건넜다
    (ActiveBindingCtx — agent.tsx:49, 459-460). OSS 는 뷰 번들(npm @relay/chat)과 위젯 번들
    (`/assets/chat-app.js`)이 분리라 context 가 못 건넌다. wire 로 두면 non-React 뷰도
    선언할 수 있다(임베더 테스트). relayos 크롬이 내부 context 를 유지하는 것은 같은 트리
    안의 합법적 구현이되, 선언 컴포넌트 자체는 OSS 정본을 소비한다(§8).*
17. 크롬의 착지 — **선언은 알림이지 명령이 아니다** [2026-08-29 개정]. 선언 변화(SPA 이동
    포함)마다 크롬은 위젯에 **좌표만** 넘긴다(`declarePage({ instanceId, conversationId,
    targets })` — 발신 chat/main.tsx autoFloat · 수신 ChatTabs.tsx declarePage). 선언이
    없으면 상위 좌표("main")로 같은 알림을 한다. 위젯이 아직 없으면 크롬이 들고 있다가
    마운트 때 넘긴다(latest-wins — 자리 하나).
    **탭과 활성 대화는 건드리지 않는다.** 페이지 이동은 탭을 열지도, 닫지도, 활성을 옮기지도
    않는다. 탭을 만드는 주체는 사람이다(보관함·"+ 새 대화"·칩·`chat.open`).
    **선언의 발신자가 뷰뿐인 것은 아니다** [2026-08-29]: 화면 없는 대화형 패키지의 문서
    (runner `view.ts` `chatFallbackDoc`)에는 `<AgentScope>` 를 쏠 뷰 번들이 없으므로, 그
    문서를 굽는 기판이 크롬 자리에서 `declarePage` 를 직접 부른다. 그 선언은 **인스턴스 축만**
    이다 — 그 문서는 "이 패키지의 대화 화면"이지 특정 슬롯의 페이지가 아니고, 대화까지 못박으면
    "+ 새 대화"가 보던 탭이 아니라 페이지 좌표에서 갈라진다. 슬롯 문자열을 기판이 조립하지
    않는다는 §2-5 도 이 선택으로 함께 지켜진다.
    *왜 종전 규칙("페이지가 곧 대화")을 버렸나: 배달과 화면의 주소가 어긋났다. 위임(a2a·
    서브에이전트)이 끝나면 결과는 **발신 슬롯**에 📬 로 앉는데(runner/runtime/tools.ts
    deliverOnSettle), 그 슬롯은 페이지가 아니라 대화다. 화면이 페이지를 따라가면 맡긴 일이
    도는 대화가 눈앞에서 사라지고 — 탭은 keep-alive 로 살아 있으나 활성이 아니다 — 사용자는
    "진행중인가요?"를 반복해 묻게 된다(Delegations.tsx 머리의 실사용 보고와 같은 공백).
    이 조항이 없으면 그 공백은 화면 하나를 더 만들어도 안 닫힌다: 원인이 표시가 아니라
    **좌표 주인**이기 때문이다.*
    **preview 탭 의미론은 남는다** — 다만 이제 그것을 만드는 것은 페이지 이동이 아니라
    빈 상태의 첫 마운트 시드뿐이다(ChatTabs.tsx:47-49, 저장된 탭이 없을 때의 useState 시드).
    미리보기는 동시에 한 자리만 존재하고, 영속되지 않으며, 사람이 관여하는 순간(첫 발화·
    이름변경·드래그) 고정 탭으로 승격한다.
18. 위젯의 소비 — **기준과 안내 둘**. `declarePage` 가 `pageSlot`/`pageTargets` 를 갱신하고:
    - **기준**: "지금 페이지에 맞추기" 피커·"+ 새 대화" 대상 판정·"대상 추가" 후보의 정본이 된다.
    - **안내** [2026-08-29]: 그 인스턴스가 내놓는 말 상대 중 **아직 탭으로 안 연 것**을 한 줄로
      늘어놓는다(ChatTabs.tsx `PageAgents` — 도킹 전용). 목록의 원천은 열거 행의 `agents[]`
      (client-protocol §5.6-32)이고, 선언된 상대는 선언 좌표 그대로(page 가 실은 param 포함),
      나머지는 param 없는 씨앗 좌표로 연다. 여는 것은 사람의 클릭이다.
    *왜 안내가 필요한가: §5-17 이 자동 개설을 거둔 뒤 선언에 남는 쓸모가 이것이다 — 화면을
    옮겼을 때 "여기서 누구와 말할 수 있는가"는 여전히 그 화면만 아는 지식이고, 사이드바도
    보관함도 그 답을 갖고 있지 않다(보관함은 **대화**를 세는 자리라 말 걸어본 적 없는 상대가
    서지 않는다 — ChatTabs.tsx `loadPickerRows` 주석, 2026-08-28 사용자 지적). 열어 주는 것과
    알려 주는 것을 가른 자리다.* `targets` 는 "갈 수 있는 곳"의 선언이다 —
    param 은 서버에서 임의 스레드 키라 후보의 일반해가 없고, 아는 쪽(뷰)이 선언하는 것이
    정본이다(agent.tsx:22-26). 대화 이력 열거는 "가 본 곳"만 알지만 이건 "갈 수 있는
    곳"을 안다.

## 6. 화면 맥락 — scene.set

19. **[현행 v1]** `scene.set` = `CustomEvent("relay:scene", { detail: { scene: string | null } })`.
    latest-wins — 위젯은 마지막 수신값을 들고 있다가 **이후 발화들**의
    `turn.send.scene`(client-protocol §5.1-12)에 싣는다(다음 갱신·해제까지 유지 —
    화면 맥락은 그 화면을 보는 동안 계속 참이다). `null` = 해제. 뷰는 화면 상태가
    바뀔 때마다(선택 변경, 페이지 이동) 밀어 둔다(발신 bridge.tsx:68-70 ·
    소비 chat/runtime.ts:899-909, 1295-1296).
    *왜 push 인가: 발화 시점 pull(요청-응답 왕복)은 전송을 뷰의 응답 타이밍에 인질
    잡는다 — 뷰가 죽어 있으면 발화가 못 나간다. 최신값을 미리 밀어 두면 발화는 기다리지
    않고, 낡은 scene 은 힌트라 해도 무해하다.*
20. scene 은 힌트다 — 프롬프트 합성은 기판 몫이고 이력에는 발화 원문만 남는다(§5.1-12
    그대로). 구 위젯(이 조항 이전 번들)이 scene 을 싣지 않는 것은 계약 위반이 아니다 —
    스큐 규율(§1-4)의 적용례다.

## 6-a. 턴 신호 — turn.signal (역방향)

20-a. **[현행 v1]** `turn.signal` = `CustomEvent("relay:turn", { detail })`,
    `detail: { phase: "started" | "settled", ok?, agent?, param?, conversation? }`.
    **계약의 유일한 역방향 동사다** — 발신자는 위젯(같은 문서에서 턴을 시작·관찰하는 유일한
    참여자, 발신 chat/runtime.ts signalTurn), 수신자는 뷰(수신 표면 `onAgentTurn()` —
    bridge.tsx). `phase` 는 client-protocol §6-36 수명주기 이벤트의 투영이고, `ok` 는
    settled 에만 실린다. `agent`·`param` 은 대화 정체성 메타(client-protocol §5.3-21)다 —
    **매칭은 메타로 한다**, `conversation`(위젯 내부 대화 좌표)은 불투명 표시용이고 뷰가
    파싱·비교하면 안 된다(슬롯 문자열은 클라이언트 계약이 아니다).
    *왜 위젯이 직발신인가(크롬 무경유): 턴 관찰은 위젯 소유이고, 수신자(뷰)는 문서 그
    자체라 마운트 후엔 상시 실재다 — chat.open 의 fire-and-forget 이 성립한 것과 같은
    근거(§4-12). 마운트 전 유실은 아래 힌트 시맨틱이 무해하게 만든다.*
20-b. **힌트 시맨틱 — 수신자 규율.** 이 이벤트는 ack 없는 fire-and-forget 이고, 뷰는
    detail 을 **상태로 쓰지 않는다** — 재조회(pull)의 트리거로만 쓴다. 정본은 언제나
    기판이다(draft-read·history 등 — relayos "이벤트는 힌트, SoT=DB" 판정과 같은 결).
    이 소비 형태만이 세 구멍을 전부 닫는다: ① 뷰 하이드레이션 전 발화 유실(뷰는 마운트
    시 어차피 pull 한다) ② 재생 중복 — attach·종결 턴 replay 가 같은 started/settled 를
    다시 발화한다(재조회는 멱등) ③ 구 위젯(이 조항 이전 번들)의 무발신(힌트 부재 = 그냥
    현행 UX, 스큐 규율 §1-4).
20-c. **경계 — 같은 문서의 턴만.** 다른 탭·채널(슬랙 등)·CLI·위임 서브세션
    (agent_dispatch)이 일으킨 활동은 이 축에 오지 않는다 — 그건 기판 push
    (client-protocol §5.8 `push.subscribe`)의 소관이고, 크롬이 그 커넥션을 소유해 이
    어휘로 재방송하는 승격은 push 착지와 함께 별도 개정으로 온다(§8-22-6). 이 축의
    임무는 지배 루프 하나다: 사용자가 지금 보는 화면에서 시킨 일이 끝났을 때, 그 화면이
    스스로 신선해지는 것.

## 7. 성장 규율과 계약 밖 잔류

21. 이 문서의 이벤트·필드 어휘가 전부다. 새 이벤트, 새 detail 필드 = 이 문서의 개정이다.
    수신자는 미지 필드를 무시한다(§1-4). 폐기도 개정으로만 한다 — 코드에서 먼저 지우고
    문서가 따라가는 순서 금지.
    **계약 밖 잔류**: 위젯 번들 내부의 `relay-*`(하이픈) 이벤트(`relay-session-minted` ·
    `relay-turn-phase` · `relay-turn-usage` · `relay-overrides-changed`,
    runtime.ts:307, 1004, 1024, 1133)는 번들 내부 어휘다 — 뷰가 구독·발신하면 안 되고,
    이 계약의 개정 없이 바뀔 수 있다. 브리지 어휘는 전부 `relay:`(콜론) 접두다.
    `relay-turn-phase`(스폰 내레이션 — 전송→첫 이벤트 구간의 스테이지)와 §6-a 의
    `relay:turn`(수명주기)은 입자가 다른 별개 축이다 — 전자는 내부 잔류, 후자가 계약이다.
21-a. **계약 밖 잔류 ② — 로그아웃 동기화(`src/auth-sync.ts`).** `relay-auth`
    BroadcastChannel + `relay-auth-logout` storage 키로 "어느 뷰가 로그아웃했다"를 같은
    브라우징 컨텍스트에 중계한다. 소비자는 위젯 번들 내부(Chat.tsx AccountMenu·useAuthWatch)
    뿐이고, **npm 표면(exports)에는 열지 않는다.** *왜 §2-5-a 와 결론이 갈리나: 인증은 이
    계약에도 client-protocol 에도 없는 기판 소유 축이고(client-protocol §2-5), 이 모듈의
    동작은 신원을 전제한다 — 발신자(로그아웃 메뉴)는 principal 을 주입한 기판에서만 렌더되고,
    `installAuthWatch()` 는 실패 시 `/login` 으로 **경로를 못박아** 이동한다. 무신원 loopback
    기판(OSS 기본)에는 발신자도 그 라우트도 없어 감시가 잠잔다. 즉 `slotFor` 와 달리 이건
    org 형태의 자리다: 지금 모양 그대로 공개하면 마운트 문법 하나(`/login`)와 신원 전제
    하나를 npm 계약에 굳히게 되고, §1-3 익명 제3자 임베더 테스트를 통과하지 못한다. 뒤에
    임의 임베더가 이 축을 요구하면 리디렉트 대상을 인자로 받는 중립 표면으로 **재설계해서**
    열 일이지, 지금 함수를 그대로 내보낼 일이 아니다.*

## 8. 착지 계획 — OSS 승격 순서

22. 순서 (client-protocol §9-47 과 같은 "정본 먼저, 컷은 한 번" 레일).
    ①~④ 는 **착지 완료**(2026-08-24 컷 — 부록 A 가 실측 좌표를 든다):
    1. ✅ 이 문서 확정 + client-protocol §1-3 에 상호 참조 한 줄.
    2. ✅ **OSS @relay/chat 공개 표면 승격**: `openChat()` · `<AgentScope>` · `useAgentBinding()`
       · `setScene()` — `chat/src/bridge.tsx` 단일 모듈, AgentScope 는 context 가
       아니라 §5-16 의 `relay:scope` wire 로 구현(`slotFor` 조립 지점 동반 승격).
       `index.js`/`index.d.ts` 루트 수출 — headless 소비자는 `/client` 서브패스가 여전히
       react 무의존이다. `slotFor`·`AgentBinding` 은 루트가 아니라 `./bridge` 서브패스로
       열렸다(§2-5-a — 관객 분리).
    3. ✅ **OSS 위젯 크롬 정합**: autoFloat 에 `relay:chat-open` 리스너(§4-8 해석 규칙) +
       prefill/send 재시도-until-ack 중계(§4-10) + `relay:scope` 착지(§5-17 preview
       openTab, 닫힘-이월 포함). 위젯 발화의 scene 동승(§6-19, runtime.ts). 위젯 번들
       재컷(`npm run build:widget`). main.tsx · ChatTabs.tsx 의 "relay:chat-open 착지"
       주석이 이 컷에서 비로소 사실이 됐다.
    4. ✅ 패키지 작성자 문서(`agent-chat/references/client-api.md`)에 브리지 항목 추가.
    5. ✅ **relayos 정렬**(2026-08-24): AgentScope·openChat·setScene·slotFor 는 OSS
       재벤더링(chat 사이트 — bridge.tsx 동승)으로 수렴했고, agent.tsx 는 크롬(도킹·중계·
       착지)만 소유한다 — 선언 수신은 내부 context 지름길이 아니라 `relay:scope` 착지
       (agent.tsx useDeclaredScope, 마운트 시 `relay:scope-request` 발신 §5-16-a 포함)다.
       relayos index.ts 는 bridge 심볼을 재수출만 한다. 위젯 갱신은 재벤더링 — `chat/`
       직접 편집 금지(client-protocol §9-47-4 규율 그대로). **relayos 서빙 번들의 정본은
       OSS 릴리스 아티팩트**(relayagent.lock releases.chat-widget)라, 위젯 쪽 새 어휘가
       박스에 닿는 것은 릴리스 digest bump 와 함께다 — 소스 사이트 핀은 dev 반복·org
       수입(bridge)용으로 먼저 간다.
    6. ✅ **역방향 첫 동사 — turn.signal**(2026-08-24 후속 컷, §6-a): 위젯 발신
       (runtime.ts signalTurn) + 뷰 수신 표면 `onAgentTurn()`(bridge.tsx — index 루트
       수출 동반). 첫 소비자는 시스템 콘솔 스튜디오(settled → draft 재조회 + 작업 중 칩).
       (잔여) 크롬의 기판 push 재방송 승격 — client-protocol §5.8 `push.subscribe` 의
       OSS 착지와 함께 별도 개정: 다른 탭·채널·위임 발 활동이 같은 `relay:turn` 어휘로
       들어오고, 발신 주체가 위젯 단독에서 크롬 동승으로 넓어진다(§6-a-20-c).

## 부록 A — 이벤트 ↔ 현행 실측 전량 매핑

OSS 열은 §8-22 ②③ 컷(2026-08-24) 이후의 현 트리 실측이다. relayos 열은 정렬 컷(§8-22-5)
이후의 현행 — 발신·선언은 벤더 bridge(OSS 재벤더링 사본)로 수렴했고, relayos 소유는
크롬(agent.tsx)의 착지·중계뿐이다. 줄 번호 대신 심볼로 적는다(벤더 사본은 핀마다 이동).

| 계약 이벤트 | OSS 실측 | relayos 실측 |
|---|---|---|
| `relay:chat-open` (발신) | `openChat` bridge.tsx:59-63 | 벤더 bridge(index.ts 재수출) · 소비 실례 ScriptErrorBar sendToBuilder(agent.tsx) |
| `relay:chat-open` (착지) | autoFloat chat/main.tsx:217-237 | useChatDock onOpen · ChatChrome onOpen(agent.tsx) |
| `relay:chat-prefill`(+ack) | 수신 Chat.tsx:2152-2167 · 발신(재시도) chat/main.tsx:190-215, 235 | 발신(재시도) ChatChrome relay(agent.tsx) · 수신은 벤더 chat/Chat.tsx |
| `relay:chat-send`(+ack) | 수신 Chat.tsx:2184-2199 · 발신(재시도) chat/main.tsx:190-215, 236 | 발신(재시도) ChatChrome relay(agent.tsx) · 수신은 벤더 chat/Chat.tsx |
| `relay:scope` | 발신 bridge.tsx:92-102 · 착지 chat/main.tsx:243-262 | 발신 벤더 bridge · 착지 useDeclaredScope(agent.tsx) |
| `relay:scope-request` | 발신 chat/main.tsx(autoFloat) · 응답 bridge.tsx | 발신 useDeclaredScope(agent.tsx) · 응답 벤더 bridge |
| `relay:scene` | 발신 bridge.tsx:68-70 · 소비 chat/runtime.ts:899-909, 1295-1296 | 발신·소비 전부 벤더 사본(bridge·chat/runtime) |
| `relay:turn` | 발신 chat/runtime.ts(signalTurn — makeAdapter onEvent) · 수신 bridge.tsx onAgentTurn · 소비 studio/page.tsx | 발신·수신 전부 벤더 사본 — 서빙 번들 반영은 릴리스 digest bump 와 함께(§8-22-5) |
| (declarePage 좌표 푸시, §5-17) | 수신 ChatTabs.tsx declarePage · 발신 chat/main.tsx autoFloat pushPage · 화면 없는 패키지 문서는 view.ts `chatFallbackDoc` 이 직접 | 릴리스 소비 — 핀 bump 와 함께 |
| (선언의 안내 소비, §5-18) | ChatTabs.tsx `PageAgents` × runtime.ts `agentsOfInstance` | 릴리스 소비 — 핀 bump 와 함께 |
