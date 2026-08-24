# 뷰-채팅 브리지 계약 (view bridge)

**같은 브라우저 문서 안**에서 패키지 view 화면과 채팅 위젯이 주고받는 인페이지 계약.
정본은 이 문서(`relayagent-oss/docs/view-bridge.md`)이고, 구현체는 둘이다 — OSS 부유
크롬(`lib/relayjs/src/chat/main.tsx` autoFloat)과 relayos RelayProvider 크롬
(relayos `lib/relayjs/src/agent.tsx`). 두 구현체는 이 문서에 맞춰 정렬되며, 어느 쪽의
현행 wire 도 정본이 아니다.

현재 계약 버전: **1** (초안). 이 축은 client-protocol(브라우저↔기판, HTTP —
[client-protocol.md](client-protocol.md))·하네스 봉투(기판↔어댑터 —
[harness-protocol.md](harness-protocol.md))와 **별개의 축**이다. client-protocol §1-3 이
"범위 밖"으로 남겨 둔 자리가 정확히 이 문서다.

> **인용 규약**: OSS 좌표(`lib/relayjs/src/...`)는 현 트리 실측이다 — §8-22 의 ②③④ 컷
> (2026-08-24)이 착지해 OSS 가 전 조항의 정본 구현을 든다. relayos 좌표(relayos
> `lib/relayjs/src/agent.tsx` 등)는 **동작 원본**이었고, 정렬 컷(§8-22-5)에서 재벤더링
> 소비자로 수렴한다(client-protocol §9-47-4 와 같은 레일).
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
   `lib/relayjs/src/chat/routematch.ts`(스레드 패밀리·sibling·`paramTargets` — 서버
   parseAgentSlot 의 쌍둥이)다. **조립 지점은 relayjs 바인딩 층 하나다**(`slotFor` —
   [현행-relayos] agent.tsx:29-33; 승격 후 OSS relayjs 가 같은 함수를 소유한다). 뷰 앱
   코드와 크롬은 슬롯 문자열을 조립하지 않는다 — `openChat` 의 `conversation` 에 실어
   보낼 값은 바인딩 층이 준 것(`useAgentBinding().conversation` 등)뿐이다.
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
| `scope.declare` | 뷰 → 크롬 | 페이지 정체성 선언 — "이 화면의 대화는 이것" |
| `scene.set` | 뷰 → 위젯 | 화면 맥락 서문 공급 — turn.send 의 `scene` 필드 |

`chat.prefill`/`chat.send` 는 wire 에서 `chat.open` 의 detail 필드로 실려 온다(§4-7) —
패널이 닫혀 있으면 열어야 꽂을 자리가 생기므로, 열기와 주입은 한 동사의 두 필드다.

## 4. wire — 이벤트 어휘

7. **[현행 v1]** `chat.open` = `CustomEvent("relay:chat-open", { detail })`,
   `detail: { instance?, conversation?, prefill?, send? }`. 발신 공개 API 는
   `openChat(opts)` 하나다(정본: lib/relayjs/src/bridge.tsx:59-63 · relayos 현행:
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
9. **[현행-위젯]** `chat.prefill`/`chat.send` 의 크롬→위젯 구간 =
   `window.postMessage({ type: "relay:chat-prefill" | "relay:chat-send", text, nonce },
   origin)` — same-origin 검사 필수. 위젯은 수신 즉시 `ev.source` 로
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
    `useAgentBinding()` 이다(정본: lib/relayjs/src/bridge.tsx:131-169 · relayos 현행:
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
    (ActiveBindingCtx — agent.tsx:49, 459-460). OSS 는 뷰 번들(npm relayjs)과 위젯 번들
    (`/assets/chat-app.js`)이 분리라 context 가 못 건넌다. wire 로 두면 non-React 뷰도
    선언할 수 있다(임베더 테스트). relayos 크롬이 내부 context 를 유지하는 것은 같은 트리
    안의 합법적 구현이되, 선언 컴포넌트 자체는 OSS 정본을 소비한다(§8).*
17. 크롬의 착지 — **"페이지가 곧 대화"**: 선언 변화(SPA 이동 포함)마다 위젯에
    `openTab({ instanceId, conversationId, preview: true, targets })` 로 끌어온다.
    선언이 없으면 상위 좌표("main")로 같은 푸시를 한다 — 선언 없는 페이지를 건너뛰면
    대화가 직전에 보던 다른 에이전트 탭에서 계속된다(agent.tsx:191-210). 패널이 닫혀
    있으면 pending 으로 이월해 **열릴 때** 착지한다 — 같은 페이지에 머무는 동안 재발화하지
    않으므로 사용자가 손으로 고른 탭을 빼앗지 않는다.
    **preview 탭 의미론**: 페이지 이동이 연 탭은 미리보기다 — 동시에 한 자리만 존재하고
    (다음 이동이 재사용), 영속되지 않으며, 사람이 관여하는 순간(첫 발화·이름변경·드래그)
    고정 탭으로 승격한다(ChatTabs.tsx:47-49, 600-610). *왜: 이게 없으면 페이지를 순회만
    해도 말 걸어본 적 없는 빈 대화가 탭으로 쌓이고 새로고침마다 되살아난다.*
18. 위젯의 소비: preview 요청이 `pageSlot`/`pageTargets` 를 갱신하고(ChatTabs.tsx:721-724),
    그 좌표가 "지금 페이지에 맞추기" 피커·"+ 새 대화" 대상 판정·"대상 추가" 후보의
    정본이 된다(Chat.tsx:1435, 1518-1521). `targets` 는 "갈 수 있는 곳"의 선언이다 —
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

## 7. 성장 규율과 계약 밖 잔류

21. 이 문서의 이벤트·필드 어휘가 전부다. 새 이벤트, 새 detail 필드 = 이 문서의 개정이다.
    수신자는 미지 필드를 무시한다(§1-4). 폐기도 개정으로만 한다 — 코드에서 먼저 지우고
    문서가 따라가는 순서 금지.
    **계약 밖 잔류**: 위젯 번들 내부의 `relay-*`(하이픈) 이벤트(`relay-session-minted` ·
    `relay-turn-phase` · `relay-turn-usage` · `relay-overrides-changed`,
    runtime.ts:307, 1004, 1024, 1133)는 번들 내부 어휘다 — 뷰가 구독·발신하면 안 되고,
    이 계약의 개정 없이 바뀔 수 있다. 브리지 어휘는 전부 `relay:`(콜론) 접두다.

## 8. 착지 계획 — OSS 승격 순서

22. 순서 (client-protocol §9-47 과 같은 "정본 먼저, 컷은 한 번" 레일).
    ①~④ 는 **착지 완료**(2026-08-24 컷 — 부록 A 가 실측 좌표를 든다):
    1. ✅ 이 문서 확정 + client-protocol §1-3 에 상호 참조 한 줄.
    2. ✅ **OSS relayjs 공개 표면 승격**: `openChat()` · `<AgentScope>` · `useAgentBinding()`
       · `setScene()` — `lib/relayjs/src/bridge.tsx` 단일 모듈, AgentScope 는 context 가
       아니라 §5-16 의 `relay:scope` wire 로 구현(`slotFor` 조립 지점 동반 승격).
       `index.js`/`index.d.ts` 루트 수출 — headless 소비자는 `/client` 서브패스가 여전히
       react 무의존이다.
    3. ✅ **OSS 위젯 크롬 정합**: autoFloat 에 `relay:chat-open` 리스너(§4-8 해석 규칙) +
       prefill/send 재시도-until-ack 중계(§4-10) + `relay:scope` 착지(§5-17 preview
       openTab, 닫힘-이월 포함). 위젯 발화의 scene 동승(§6-19, runtime.ts). 위젯 번들
       재컷(`npm run build:widget`). main.tsx · ChatTabs.tsx 의 "relay:chat-open 착지"
       주석이 이 컷에서 비로소 사실이 됐다.
    4. ✅ 패키지 작성자 문서(`agent-chat/references/client-api.md`)에 브리지 항목 추가.
    5. **relayos 정렬**(잔여): AgentScope·openChat 는 OSS 재벤더링으로 수렴하고, agent.tsx
       는 크롬(도킹·중계)만 소유한다 — 크롬의 선언 수신은 내부 context 지름길에서
       `relay:scope` 착지로 옮긴다. 위젯 갱신은 재벤더링 — `chat/` 직접 편집 금지
       (client-protocol §9-47-4 규율 그대로).

## 부록 A — 이벤트 ↔ 현행 실측 전량 매핑

OSS 열은 §8-22 ②③ 컷(2026-08-24) 이후의 현 트리 실측이다. relayos 열은 정렬 컷(§8-22-5)
전의 현행 — 정렬 후에는 발신·선언이 OSS 재벤더링으로 수렴한다.

| 계약 이벤트 | OSS 실측 | relayos 실측 |
|---|---|---|
| `relay:chat-open` (발신) | `openChat` bridge.tsx:59-63 | `openChat` agent.tsx:89-92 · ScriptErrorBar agent.tsx:752 |
| `relay:chat-open` (착지) | autoFloat chat/main.tsx:217-237 | useChatDock agent.tsx:187 · ChatChrome agent.tsx:500 |
| `relay:chat-prefill`(+ack) | 수신 Chat.tsx:2152-2167 · 발신(재시도) chat/main.tsx:190-215, 235 | 발신(재시도) agent.tsx:480-497 |
| `relay:chat-send`(+ack) | 수신 Chat.tsx:2184-2199 · 발신(재시도) chat/main.tsx:190-215, 236 | 발신(재시도) agent.tsx:480-498 |
| `relay:scope` | 발신 bridge.tsx:92-102 · 착지 chat/main.tsx:243-262 | 부재 — context 로 대신(ActiveBindingCtx, 정렬 시 §8-22-5) |
| `relay:scope-request` | 발신 chat/main.tsx(autoFloat) · 응답 bridge.tsx | 부재 — 정렬 시 크롬이 발신(§5-16-a) |
| `relay:scene` | 발신 bridge.tsx:68-70 · 소비 chat/runtime.ts:899-909, 1295-1296 | 부재 |
| (openTab preview 푸시) | 수신 ChatTabs.tsx:703-731 · 발신 chat/main.tsx:243-262 | 발신 agent.tsx:200-210 |
