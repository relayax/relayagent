# 클라이언트 전송 계약 (client protocol)

브라우저 클라이언트(코어 SDK·채팅 위젯)와 **기판의 문** 사이 HTTP 계약.
정본은 이 문서(`relayagent-oss/docs/client-protocol.md`)이고, 구현체는 둘이다 —
OSS 데몬(`runner/daemon.ts`)과 relayos deployd(`runtime/deployd/`). 두 구현체는 이 문서에
맞춰 정렬되며, 어느 쪽의 현행 wire 도 정본이 아니다.

> **개정 이력 — 2026-08-24 (계약 무변경, 구현 반쪽의 이음새).** OSS 구현체
> (`runner/runtime/wire.ts`)가 **계약 축 이음새 `ClientWireIO`** 를 냈다 — 계약이 규정하는
> 표면이 딛는 저장소(세션 목록·개설·메타·하네스 조회·설정 쓰기)와 좌표(세션 이음새)를 인자로
> 받는다. **이 개정은 wire 를 한 바이트도 바꾸지 않는다**: 동사·shape·코드·capability 어휘
> 전부 그대로이고, 미주입이면 1인 기판의 현행 동작이 꽂힌다. 정본 문서는 `docs/
> authority-interface.md` §10.2. *왜 계약 문서에 적나: §1-1 이 "구현체는 둘"이라고 선언한
>것의 종착이 바뀌었기 때문이다 — 아래 §1-1 참조.*
>
> **개정 이력 — 2026-08-18 (v1 초안 내 additive).** 두 번째 구현체(relayos)가 실사고로 얻은
> 개념을 계약으로 승격했다: 재전송 수렴(§5.1-12) · `settled` 이후 무이벤트(§6-36) ·
> delta 입자 비보장(§6-35) · 대화축 취소 `cancel-by-session`(§4·§7). protocol 정수는 **1 그대로**다
> — 기존 클라이언트가 깨지는 변경이 없고, 새 capability 는 미선언 기판에서 그냥 부재다.
> *왜 이 방향인가: 정본이 밖(OSS)이라는 것은 "구현체는 계약에 맞춘다"만 뜻하지 않는다.
> 구현체가 실사고로 배운 것이 계약에 없으면 그 지식은 지역 방언으로 남고, 다음 사람이
> "계약에 없으니 군더더기"라며 지운다. 잘 도는 개념은 지우는 게 아니라 올려야 한다.*

현재 계약 버전: **1** (초안). 이 정수는 하네스 봉투의 `info.protocol`(현재 3,
[harness-protocol.md](harness-protocol.md))과 **별개의 축**이다 — 하네스 축은
기판↔어댑터 사이를, 이 축은 브라우저↔기판 사이를 잰다. 하네스 protocol 이 4 가 되어도
이 계약이 자동으로 바뀌지 않고, 그 역도 같다.

> **인용 규약**: `runner/*.ts` 좌표는 현 트리 실측이다. 반면 `core.js`·`widget.js` 인용은
> **컷(2639dae)에서 삭제된 구 클라이언트**를 가리킨다 — 조항이 왜 이 모양인지를 설명하는
> 역사 근거로만 남겼고, 그 코드는 트리에 없다. 되살릴 일이 있으면 커밋에서 꺼낸다.
>
> 이 문서의 wire 표기에는 두 종류가 섞여 있다. **[현행]** 은 실제 파일에서 확인한
> 기존 엔드포인트(file:line 병기), **[현행 v1]** 은 이 계약이 새로 정의하고 §9 의 컷
> (2639dae)에서 OSS 데몬에 착지한 경로다 — 구현 정본은 `runner/runtime/wire.ts`.
> 아직 착지하지 않은 경로(§5.7 state · §5.8 push)만 **[신설]** 로 남는다.

## 1. 지위와 범위

1. **정본 = OSS.** 계약 문서는 relayagent-oss `docs/` 에 산다. relayos 는 소비자다
   (relayos-claude/docs/convergence.md:113 "계약 정본은 OSS docs/").
   *왜: 정본은 밖, 의존은 relayos→OSS 한 방향이라는 수렴 독트린의 배당이다.*
   **구현체 둘은 종착이 아니다 (2026-08-24 정정).** 처음 이 문서는 "정본 하나, 구현체 둘"을
   그대로 종착으로 적었다. 그런데 같은 계약에 구현이 둘이면 판정도 둘이고, 실사고 하나가
   한쪽에서만 고쳐지는 날이 온다(§5.2-20 의 가짜완료가 정확히 그런 경위로 relayos 에만
   있었다). 종착은 **구현 하나 + 기판별 이음새 구현**이다: OSS 구현체가 계약 축 이음새
   (`ClientWireIO` — authority-interface.md §10.2)를 내고, org 기판은 그 뒤에 자기 저장소를
   꽂는다. 그때 org 문에 남는 것은 인증·마운트·경계이지 계약의 두 번째 구현이 아니다.
   *왜 이것이 계약 조항인가: "익명의 제3자 임베더 테스트"(:2)는 계약의 **형**만이 아니라
   계약의 **구현체가 하나로 설 수 있는가**에도 걸린다. 임베더가 저장소를 꽂을 자리가 없으면
   임베더는 계약을 다시 구현하는 수밖에 없고, 그 순간 :2 는 문서에서만 참이 된다.*
2. **익명의 제3자 임베더 테스트.** 이 계약의 어떤 동사·필드도 relayos 만 쓸 수 있는
   형태면 안 된다. org 의미(principal 바인딩, 멤버, 라이선스)는 계약에 등장하지 않고,
   기판의 문 뒤에서 해석된다(convergence.md:123-125).
3. 계약의 소비자는 **브라우저 클라이언트**다: 코어 SDK 와 채팅 위젯(React 판 단일화 —
   번들은 OSS 릴리스 컷에 굽고 기판이 `/assets` 로 서빙한다, runner/daemon.ts:770-780).
   패키지 view 의 동사 호출(`/api/scripts`·MCP)은 이 문서의 범위 밖이다. 같은 문서 안에서
   view 화면과 위젯이 주고받는 인페이지 브리지도 범위 밖이다 — 정본은
   [view-bridge.md](view-bridge.md).
4. **권위 이음새와의 관계.** 이 계약은 문 앞의 전송만 규정한다. 문 뒤에서 "누구로서,
   무엇을, 어떤 자격으로"를 판정하는 권위 이음새는 별개 트랙이다
   (convergence.md:116-125 "OSS 선행 작업 3" 목록의 1번 — 권위 이음새 추출,
   정본 문서 [authority-interface.md](authority-interface.md)).

## 2. 계약이 규정하지 않는 것 — 인증과 좌표

5. **인증은 기판 소유다.** 계약은 자격의 운반 위치(쿠키/헤더/없음)를 규정하지 않는다.
   실측: OSS 데몬은 인증 헤더 0 — 127.0.0.1 바인딩 + Host 루프백 검사(DNS rebinding 방어)
   + 상태 변경 요청의 Origin 검사(CSRF)가 문이다(`runner/daemon.ts createApi`). 임베더는
   `createApi(…, opts.door)` 로 허용 Host·Origin 을 **선언**하고 listen 을 자기가 가져간다 —
   방어를 끄는 스위치가 아니라 집합을 넓히는 선언이다(authority-interface.md §10.3). relayos deployd 는 `relay_edge` 세션 쿠키를
   Bearer JWT 로 승격하고(runtime/deployd/api_turns.go:4, 66-67), 401 은 클라이언트가
   `POST /api/session/refresh` single-flight 후 1회 재시도한다
   (relayos chat/src/transport.ts:41-62). 두 방식 모두 이 계약 위에서 합법이다.
   *왜: 인증을 계약에 넣는 순간 1인 loopback 기판이 org 의 세션 기계를 강제로 지게 되고,
   그 반대면 org 가 무인증을 지게 된다 — 둘 다 임베더 테스트 위반이다.*
   단 하나의 계약 조항: 미인증 판정은 **HTTP 401 + `{error:{code,message}}`** 로
   온다(폴백·리다이렉트로 위장 금지). 복구 절차는 기판 소유.
6. **스코프 좌표는 base URL 주입이다.** 클라이언트는 두 좌표를 주입받는다:
   - **root** — 문의 뿌리. 열거 동사(§5.6)가 여기 산다.
   - **base** — 대화 스코프(패키지 하나/인스턴스 하나)의 뿌리. §5 의 모든 스코프 동사는
     `{base}` 상대 경로다.
   `/pkg/:pkg`(OSS, runner/runtime/wire.ts:898)나 `/i/<id>`(relayos,
   runtime/deployd/upload.go:152)는 **기판의 마운트 지점일 뿐 계약이 아니다**.
   클라이언트 코드에 마운트 문법이 새면 그 클라이언트는 계약 위반이다.
   *왜: 좌표를 경로 문법으로 계약에 넣으면 두 기판 중 하나는 영원히 URL 재작성 프록시를
   유지해야 한다. base 주입이면 기판이 마운트를 마음대로 바꾼다.*
   relayos 의 `X-Relay-Instance` 헤더(relayos chat/src/chat/transport.ts:257-262)는
   base 주입이 해결하는 문제의 기판 내부 구현으로 강등된다 — 계약 표면에서 제거.
6-a. **[현행 v1] 여러 인스턴스를 한 화면에서 보려면 `baseFor` 주입이 필요하다.**
   클라이언트가 자기 문서의 인스턴스 **말고 다른 인스턴스**의 스코프 동사를 부르려면 그
   인스턴스의 base 를 알아야 하는데, §2-6 이 금지한 것이 정확히 그 조립이다. 그래서 주입
   좌표에 함수 하나를 더 둔다: `window.__RELAY_CONTEXT.baseFor = (instanceId) => base | null`.
   조립은 기판이 한다 — OSS 실측은 `baseFor:function(i){return "/pkg/"+encodeURIComponent(i)}`
   (runner/runtime/shell.ts `BASE_FOR_JS`, 주입 지점은 `viewContextTag`·`homeDoc` 둘).
   미주입이면 클라이언트는 자기 인스턴스만 안다 — 종전 동작 그대로이므로 **additive** 다.
   *왜 함수인가: 지도(id→base)를 통째로 주입하면 설치 목록이 문서에 굳어, 주입 뒤에 깔린
   패키지가 영영 미상으로 남는다. 열거의 정본은 §5.6 이고 주소 해석은 지연되어야 한다.*
   *왜 계약에 올리나: 이게 없는 동안 "전 인스턴스 대화함"(§5.6 을 딛는 화면)은 이름만
   그랬고 실제로는 현재 인스턴스 것만 냈다 — 열거는 되는데 그 인스턴스의 문을 두드릴 주소가
   없어 빈 목록으로 접혔다(OSS 실측, 2026-08-29). 계약이 열거 동사를 root 에 둔 이상
   그 결과를 쓸 수 있게 하는 주입도 계약이어야 한다.*

## 3. 개막과 판정 — capabilities 문

7. **[현행 v1]** `GET {base}/capabilities` → `{protocol: 1, capabilities: [...]}`.
   클라이언트는 이 호출로 개막한다.
   *왜: 클린 브레이크(§9)에는 "지금 붙은 문이 몇 세대인가"를 묻는 자리가 필요하다.
   구 기판(이 경로 404)이나 protocol 불일치는 클라이언트가 `E_PROTOCOL` 로 판정하고
   실패를 그린다 — 구 wire 로 폴백하지 않는다(fail-loud).*
8. `capabilities` 는 §7 의 닫힌 어휘다. **미구현 기판은 해당 항목을 목록에서 뺀다** —
   선언해 놓고 501 을 내는 것은 위반이다.
   *왜: 하네스 `info.capabilities` 와 동형의 규율이다(harness-protocol.md:99-102
   "declared-but-dead capability is a broken screen").*
   미선언 capability 의 동사를 클라이언트가 호출하면 서버는 `404 + {error:{code,message}}`
   로 답한다 — 코드는 기판 소유 어휘다. 올바른 클라이언트는 개막에서 이미 부재를 알므로
   이 호출 자체가 클라이언트 결함이고, 화면이 분기할 일이 없어 계약 소유 코드로 승격하지
   않는다.

## 4. 동사 전량 (추상)

| 축 | 동사 | capability |
|---|---|---|
| 턴 | `turn.send` · `turn.stream` · `turn.attach` · `turn.interrupt` · `turn.respond` | — |
| 턴(진행 중) | `turn.steer` | steer |
| 턴(대화축) | `turn.cancel` | cancel-by-session |
| 세션 | `session.list` · `session.open` · `session.create` · `session.rename` · `session.archive` · `session.pin` · `session.remove` · `session.reset` | — |
| 이력 | `history.get` | — |
| 파일 | `file.upload`(단일 동사) · `file.download` | upload-progress |
| 하네스 | `harness.info` · `harness.models` · `harness.commands` · `harness.variants` · `harness.set`(model/effort/harness) | harness-info · harness-models · harness-commands · effort · harness-variants |
| 열거 | `instances.list` | enumerate |
| 표면 상태 | `state.get` · `state.set` | state |
| push | `push.subscribe` | push |

`session.open` 은 wire 동사가 아니다 — `history.get` + (busy 면) `turn.attach` 의
클라이언트 합성이다.

## 5. wire 표기

### 5.0 공통 규약 — 봉투

9. **클라이언트는 절대 throw 하지 않는다.** 모든 호출의 실패는
   `{error: {code, message}}` 봉투로 돌아온다 — 구 코어의 계약을 그대로 유지한다
   (relayagent-oss chat/src/core.js:2, 4-20).
10. 서버 에러는 **HTTP 상태코드 + `{error:{code,message}}` JSON 본문**이다.
    `code` 는 `E_` 접두 문자열. 계약이 소유하는 코드는 넷뿐이고 —
    `E_PROTOCOL`(§3) · `E_DISCONNECTED`(§5.2) · `E_NO_TURN`(§5.1) ·
    `E_NETWORK`(클라이언트 발행) — 나머지 코드 어휘는 기판 소유다. 클라이언트는
    JSON 아닌 본문·`error` 없는 본문을 `E_HTTP_<status>` 로 합성한다(core.js:12-14 현행).
    *왜: 코드 전역 어휘를 계약이 다 쥐면 기판마다 다른 실패(자격 결핍, 라이선스,
    상한)를 표현할 자리가 없다. 화면이 분기해야 하는 코드만 계약이 쥔다.*
11. 요청 본문은 `application/json`(파일 바이트 제외, §5.4). GET 의 인자는 쿼리 스칼라만.

### 5.1 턴 — 비블로킹 시작 + SSE

12. **[현행 v1]** `turn.send` = `POST {base}/turns`
    요청: `{session, message, agent?, attachments?: [{path, name?}], scene?}`
    응답: `202 {turn, session}` — **턴 종결을 붙들지 않는다.**
    *왜: 구 OSS `/chat` 은 턴이 끝날 때까지 단일 POST 를 붙드는 블로킹 계약이었다
    (구 wire — 삭제됨, 컷 2639dae; core.js:129 "폴링인 이유: /chat 은 종결까지 붙드는 단일
    POST"). 프록시 타임아웃·새로고침·모바일 백그라운드에 전부 취약하고, 진행은
    사이드밴드 폴링으로 때웠다. 시작과 관찰을 분리하면 관찰은 몇 번이든 다시 연다.*
    - `attachments[].path` 는 `file.upload`(§5.4)가 돌려준 불투명 참조다.
    - `scene` 은 화면 맥락 서문 — 합성은 기판 몫, 이력에는 원문만 남는다
      (core.js:160-161 · runner/runtime/wire.ts:255 의 의미 유지).
    - 같은 세션에 진행 중 턴이 있으면 기판이 **직렬화(큐잉)** 한다 — 클라이언트 큐
      (core.js:116-127)는 은퇴한다. 순서는 도착순. **wire 밖에서 열린 턴**(도구 위임·트리거 —
      §5.1-14 의 입양 턴)도 같은 줄이다: 그 턴이 도는 동안 도착한 turn.send 는 실패가 아니라
      그 뒤에 선다(2026-08-28 정정 — 사슬이 wire 턴끼리만 서서 위임 탭의 발화가 전부 §8-42-a
      문지기 오류로 종결하던 실사고).
      *왜: 직렬화를 클라이언트가 하면 화면 두 개가 같은 세션에 붙는 순간 깨진다.
      기판만이 세션의 유일한 직렬화 지점이다.*
    - **재전송 수렴 — 직렬화의 짝 조항.** 진행 중 턴과 **같은 발화**가 다시 도착하면 기판은
      새 턴을 만들지 않고 **진행 중 턴의 id 를 그대로 돌려준다**(202). 큐에 이미 같은 발화가
      있으면 두 번 담지 않는다. 빈 발화도 같다.
      *왜: 이것이 없으면 §5.2-20 의 절단 판정이 사고로 되돌아온다 — 스트림이 한 번 끊겨
      `E_DISCONNECTED` 가 뜨면 사용자는 같은 말을 다시 보낸다. 그때 기판이 순진하게 두 번째
      턴을 만들면 두 턴이 같은 대화를 동시에 재개하려다 하네스 세션 락에서 충돌해
      (relayos 실측: `Session ID already in use`) **둘 다** 미완료로 끝난다. 사용자가 본 것은
      "같은 질문이 두 번, 둘 다 실패"다. 직렬화만으로는 이 창이 안 닫힌다 — 큐가 중복을
      성실히 실행하기 때문이다. 수렴이 그 자리를 닫는다(relayos, 2026-07).*
    - **진행 중 턴 취소는 대화축으로도 열려 있다** — capability `cancel-by-session`
      (§7)을 선언한 기판은 `POST {base}/turns/cancel` `{session}` → `{ok, turn?}` 을 받는다.
      *왜: `turn.interrupt`(§5.1-15)는 턴 id 를 쥔 화면의 동사다. 그런데 채널 어댑터(슬랙·
      디스코드)처럼 **턴 id 를 들고 다니지 않는 소비자**가 실재한다 — 그들에게 남은 길은
      `history.get` 으로 busy+turn 을 얻고 interrupt 를 치는 2왕복인데, 그 사이에 턴이
      바뀌면 엉뚱한 턴을 끊는다. 대화축 취소는 그 경주를 기판 안으로 넣는다. 필수가 아닌
      이유는 1인 loopback 기판엔 그런 소비자가 없어서다.*
13. **[현행 v1]** `turn.stream` = `GET {base}/turns/<id>/stream` (SSE, §5.2).
    send 직후 여는 관찰 창. 이미 종결된 턴이면 장부 재생 후 즉시 settled·EOF.
14. **[현행 v1]** `turn.attach` = `GET {base}/turns/attach?session=<id>` (SSE).
    그 세션의 **진행 중 턴**에 재접속한다 — 이벤트 장부를 처음부터 재생하고 라이브로
    이어진다. 진행 중 턴이 없으면 `404 {error:{code:"E_NO_TURN"}}`.
    *왜: 새로고침한 화면이 진행 중 도구 카드·delta 를 복원하는 유일한 길이다. 구 OSS 는
    이 자리를 history.busy 3초 폴링으로 때웠다(core.js:253-270).*
    **필수 동사다 — capability 게이트 없음.** §5.2-20 의 절단 복구와 §5.3-24 의 새로고침
    복구가 전부 이 동사로 수렴하고 폴링 폴백은 금지(§5.8)이므로, attach 없는 기판은 복구
    경로가 0 이 된다. 이벤트 장부 보관도 전 기판 의무인데, `turn.stream` 의 종결 턴
    재생(§5.1-13)이 이미 같은 장부를 요구하므로 attach 가 얹는 추가 비용은 사실상 없다.
    OSS 데몬은 컷 2639dae 에서 장부 보관과 함께 착지했다
    (client-wire.ts:564-578 · 턴 장부 148-238).
15. **[현행 v1]** `turn.interrupt` = `POST {base}/turns/<id>/interrupt` → `{ok}`.
    봉투 cancel 제어(harness-protocol.md:75)로 전달된다.
16. **[현행 v1]** `turn.respond` = `POST {base}/turns/<id>/respond`
    요청: `{ask, answers: [{question, selected[]}]}` → `{ok}`.
    봉투 `ask` 이벤트(harness-protocol.md:65)의 회송. 빈 `answers` = 사용자 취소.

16-a. **[신설]** `turn.steer` = `POST {base}/turns/<id>/steer` — capability `steer`.
    요청: `{prompt}` → `{ok}`. 봉투 `steer` 제어(harness-protocol.md §Control)로 전달되고,
    **진행 중 턴에 사용자 발화를 얹을 뿐 턴을 열지 않는다** — `reply` 는 여전히 하나이고,
    그 하나가 얹힌 발화까지 포함해 정산한다.
    - `ok:false` = **얹을 턴이 없다**(그 사이 종결됐거나 아직 시작 전인 큐 턴). 이때 발화를
      버리면 안 된다 — 클라이언트는 `turn.send` 로 **새 턴을 보내 폴백한다**.
      *왜 기판이 판정하는가: 이 경주는 기판만 볼 수 있다(진행 명부가 프로세스 지역이다).
      어댑터가 대신 큐잉하면 같은 말이 두 번 간다 — 어댑터의 큐와 클라이언트의 폴백이
      각자 한 번씩 보낸다. 판정을 한 곳에 두는 것이 중복을 없애는 유일한 방법이다.*
    - 얹힌 발화는 **이력에 사용자 메시지로 즉시 앉는다** — 정산을 기다리지 않는다(§5.1-12 의
      `appendUser` 와 같은 규율: "물음은 지금, 답은 끝나고"). 기다리면 그 사이 죽은 기판에서
      사용자가 한 말만 통째로 사라진다.
    - 미선언 기판(capability `steer` 부재)에서 이 동사는 404 다(§3-8). 클라이언트는 개막에서
      이미 부재를 알므로 **큐 의미론으로 떨어진다**: 발화를 들고 있다가 턴이 끝나면 보낸다.
      *왜 폴백을 계약이 규정하는가: 두 경로 모두 "사용자가 턴 중에 친 말은 잃지 않는다" 를
      지켜야 화면이 기판을 몰라도 된다. 하네스가 고르는 것은 **언제 전달되는가** 하나뿐이고,
      무엇이 보장되는가는 하네스가 고르지 않는다.*

경로 명명은 relayos 현행(`/api/turns*`, api_turns.go:154-186)에 가장 가깝다 — deployd
정렬(§9)의 diff 를 최소화하기 위해서다. 단 relayos 의 "GET /turns/stream 쿼리로 턴을
시작"하는 이중 시작 경로(chat/transport.ts:67-74 — 무첨부는 GET 단독 시작, 첨부는
POST 2단)는 계약에 들이지 않는다: **시작은 POST /turns 하나다.**
*왜: 시작 경로가 둘이면 멱등성·재시도·큐잉 규칙을 두 번 정의해야 하고, GET 에 프롬프트가
실리는 순간 로그·프록시에 발화가 샌다.*

### 5.2 SSE 프레이밍

17. 서버 헤더: `content-type: text/event-stream` · `cache-control: no-cache` ·
    `x-accel-buffering: no` (api_turns.go:135-137 현행 규약의 승격).
18. **이벤트 하나 = SSE 메시지 하나.** 봉투 이벤트(§6)는 JSON 한 덩이로 `data:` 라인에
    실린다. `event:`/`id:`/`retry:` 필드는 쓰지 않는다 — 의미는 전부 data JSON 안에 있다
    (relayos 파서와 동일 규칙: chat/transport.ts:207-210 "event:/id:/retry:/주석은 무시").
    *왜: 의미를 SSE 필드에 나누면 파서가 둘이 된다. data 단일 축이면 JSONL 장부(재생·
    attach)와 라이브 스트림이 같은 어휘를 쓴다.*
19. **하트비트**: 서버는 이벤트 공백이 15초를 넘기 전에 주석 라인(`:hb`)을 흘린다.
    클라이언트는 주석을 버린다.
    *왜: 중간 프록시의 idle timeout 이 조용한 절단을 만든다. 절단은 §5.2-20 의 판정으로
    드러나야지, 하트비트 부재로 위장되면 안 된다.*
20. **종결 판정 — 가짜완료 금지.** 스트림의 정상 종결은 `turn/settled` 수명주기 이벤트
    (§6) 수신 후의 EOF 다. **settled 없이 EOF 가 오면 클라이언트는 `E_DISCONNECTED` 로
    판정한다 — 성공으로 위장하지 않는다.** 서버 턴은 계속 실행 중이므로 화면은
    "미완료·재접속 가능"을 그리고 `turn.attach` 로 복귀한다.
    *왜: relayos 실사고의 직수입이다 — 이른 result 프레임을 종결로 오판해 위젯이 빈
    '완료'로 마감하고 서버 턴은 계속 돌았다(chat/transport.ts:285-297, 2026-07-16).
    종결 마커를 프레이밍 수준의 전용 이벤트로 승격하면 "결과처럼 생긴 중간 프레임"
    문제가 원천 소거된다.*
20-a. **관찰 다중화 — capability `observe`, 옵셔널.** 기판이 선언하면 클라이언트는 관찰을
    SSE **한 줄기**로 다중화한다: `GET {base}/observe?id=<관찰자 id>` 가 줄기를 열고
    (첫 이벤트 `{event:"observe", status:"ready", id}`), `POST {base}/observe/<id>/sessions
    {add?: [session], remove?: [session]}` 가 구독을 편집한다. 세션 구독은 §5.1-14 attach 와
    같은 골격이다 — `{event:"observe", status:"session", session, turns:[id…]}` 로 관찰 창
    (진행·대기 턴)을 알리고, 각 턴의 장부를 재생한 뒤 라이브를 잇는다. 구독 뒤에 서는 턴은
    `{event:"observe", status:"turn", session, turn}` 으로 알린다. 줄기의 모든 이벤트 줄에는
    `turn`·`session` 이 덧붙는다(§6 어휘에 additive — 소비자는 그 열쇠로 나눈다). 창 밖의 턴
    (이미 종결)은 여전히 `turn.stream`(§5.1-13)의 장부 재생이 답한다. 줄기 자체의 절단은
    §5.2-20 과 같다 — 실린 관찰 전부가 `E_DISCONNECTED` 이고 재접속이 새 줄기를 연다.
    관찰자 id 는 클라이언트 발급 불투명 문자열(`[A-Za-z0-9-]{1,80}`), 같은 id 의 재접속은
    이전 줄기를 대체한다. 미선언 기판(구 기판·relayos)에서는 아래 예산 조항의 직접 SSE 로
    떨어진다. `turn.stream`·`turn.attach` 의 추상 동사와 핸들 계약은 두 길에서 같다 —
    소비자는 어느 길인지 모른다(OSS 2026-08-27 신설, runner/runtime/wire.ts).

**커넥션 예산 — 계약 조항이다.** 브라우저의 HTTP/1.1 origin 당 커넥션 예산(6개)을 SSE
상시 점유가 소진하면 마지막 슬롯을 두고 fetch 와 SSE 재접속이 경주하고, SSE 가 이기는
순간 모든 호출이 무기한 큐잉된다 — relayos 실사고(2026-07-16, 탭 5개 SSE 상시 점유 →
새로고침 fetch 수 분간 미도달, relayos chat/src/transport.ts:310-312 주석). 그래서:
① `push.subscribe`(§5.8)는 **페이지당 공유 커넥션 1개**, ② 턴 스트림(`turn.stream`)은
턴 진행 중에만 열고, ③ `turn.attach` 는 신규 커넥션 추가가 아니라 기존 관찰의 **대체
접속**이다. ④ 대체의 단위는 **세션**이다 — stream/attach 는 같은 세션의 이전 관찰만 닫고
다른 세션의 관찰은 건드리지 않는다(탭 셸은 세션마다 관찰을 연다 — 전역 슬롯 하나로 접으면
두 세션이 서로를 번갈아 끊고 재접속이 그 순환을 돌린다, 2026-08-27 실사고). ⑤ capability
`observe`(20-a)를 선언한 기판에서는 관찰 전부가 줄기 하나에 실리므로 관찰이 예산을 먹지
않는다. 미선언 기판에서만 직접 SSE 를 열고, 그때는 인스턴스당 동시 관찰을 3개로 접는다
(push 1 + unary fetch 몫 2): 초과분의 attach 는 슬롯이 빌 때까지 대기하고, 새 턴의 stream 은
가장 오래된 관찰을 양보시킨다(양보된 쪽은 §5.2-20 절단 복구의 attach 로 대기열에 선다).
loopback 기판에도 동일 적용된다 — 예산은 서버가 아니라 브라우저 origin 기준이다.

### 5.3 세션과 이력

21. **[현행 v1]** `session.list` = `GET {base}/sessions`
    → `{sessions: [{session, label, updated, archived, pinned, agent?, param?, origin?,
    busy?, lastEvent?, lastAlive?, parent?, parentInstance?}]}`.
    `agent`·`param`(additive, 2026-08-20) = 이 대화의 정체성 — 위임(agent_dispatch)이 만든
    세션처럼 착지 에이전트가 아닌 대화가 밝힌다. `param` 은 org param 축의 쌍둥이("빌더인데
    무엇의 빌더인가") — slug 목록(`[a-z0-9-]` csv, 쉼표 무공백)일 때만 목록으로 해석하고,
    그 밖의 임의 스레드 키는 쉼표를 품어도 통짜 대상 하나다(routematch `paramTargets` 와
    동형 — org "param = 임의 스레드 키" 계약 보존, 2026-08-21 slug 한정 문언 교정).
    클라이언트는 이 값으로 대화의
    에이전트·대상 칩을 세우고 turn.send 의 `agent` 기본값으로 쓴다. 없으면 착지 — 종전 그대로.
    *왜 행에 싣나: 화면의 스레드 문법(`agent-<이름>:~<id>`)은 `:` `~` 를 쓰는데 기판 발급
    세션 id 는 그 문자를 실을 수 없는 기판이 있다(OSS 는 디렉토리명이다). 이름에 정체성을
    싣는 규약은 그래서 이식 불가였고, 메타가 정본이 된다.*
    `origin`(additive, 2026-08-28) = **사람이 연 대화가 아닌, 기계가 판 슬롯**임을 밝힌다 —
    `"dispatch"`(서브에이전트 위임 `agent_dispatch`) · `"mission"`(a2a 미션 수신). 사람이 연
    대화는 이 필드가 없다. 판정 자체는 슬롯 문법(`sub-…`·`mission-…`)이지만 그건 기판 내부
    어휘라(:22 — 세션 id 는 불투명) 클라이언트가 접두를 스니핑하면 안 되고, 판정 정본은
    runner/protocol.ts `slotOrigin` 한 벌이다. 화면은 이 축으로 위임 세션을 사람의 대화와
    같은 무게로 늘어놓는 대신 인스턴스 아래 접는다(보관함 피커 — 2026-08-28).
    `busy`·`lastEvent`·`lastAlive`·`parent`(additive, 2026-08-29) = **이 대화가 지금 살아
    있는가**. 종전에 이 목록은 디스크만 읽었고 생존은 기판 메모리에만 있어서, 30분째 도는
    위임과 죽은 위임이 행에서 똑같이 생겼다 — 위임을 접어 둔 화면에는 그 차이를 말할 자리가
    아예 없었다. `busy` = 진행 중 턴이 있다(없으면 미상이 아니라 **안 돌고 있음**이다 — 기판은
    자기 상주를 전부 안다). `lastEvent` = 마지막 하네스 활동 시각(epoch ms)으로, `updated`
    (이력 mtime)와 **다른 축이다**: `updated` 는 턴이 끝나야 늘고 `lastEvent` 는 도구 하나가
    도는 중에도 는다. `lastAlive` = 봉투 박동(harness `alive`)의 마지막 시각 — `lastEvent` 는
    오래됐는데 `lastAlive` 가 방금이면 "오래 걸리는 중"이고, 둘 다 오래됐으면 "멈춤"이다.
    화면은 그 둘을 다르게 말해야 한다: 스피너 하나로 접으면 동결이 진행으로 보인다.
    `parent` = 이 대화를 판 부모 대화의 슬롯. `parentInstance`(additive, 2026-08-30) = 그
    슬롯이 사는 인스턴스 — **없으면 이 행과 같은 인스턴스다**(서브에이전트 위임은 늘 같은
    자리에 서므로 종전 행은 그대로 읽힌다). a2a 미션(`origin:"mission"`)의 부모는 다른
    인스턴스의 대화라 슬롯 하나로는 못 가리켰고, 그래서 종전에는 이 형에 `parent` 를 아예 안
    실었다 — 다른 앱에 맡긴 일이 30분을 도는 동안 발신 대화에는 그것을 말할 자리가 없었다
    (실측 2026-08-30: 조사 미션 둘이 도는데 화면은 조용했다). 좌표를 하나 더 주면 같은 짝지음이
    인스턴스를 건너 그대로 선다: 클라이언트는 `instances.list`(§5.6-32) × `session.list` 로
    훑고, `parent` 가 내 슬롯이고 `parentInstance ?? 그 행이 온 인스턴스` 가 내 인스턴스인
    행만 내가 판 위임이다. 상주 없는 대화에는 생존 축이 통째로 빠진다(없음 = 안 돌고 있음).
    정렬: 고정 우선, 그 안에서 최근순(runner/runtime/wire.ts:459 현행 유지). 라벨 우선순위
    (사용자 label > auto-label > 첫 발화, client-wire.ts:437-449)는 기판 내부 규칙이다 —
    클라이언트는 `label` 을 그대로 그린다.
22. **[현행 v1]** `session.create` = `POST {base}/sessions` → `{session}`.
    **세션 id 는 기판이 발급하는 불투명 문자열이다.** 클라이언트 로컬 발급
    (core.js:315-324 `"c-" + Date.now()`)은 은퇴한다.
    *왜: id 발급을 클라이언트가 하면 형식(`SLOT_RE`, protocol.ts:72)이 사실상 클라이언트
    계약이 되고, org 기판의 영속 규칙("새 대화 즉시 영속 — 빈 대화 증발 방지",
    api_turns.go:195-196)을 표현할 자리가 없다.*
    요청 본문(additive, 2026-08-21)으로 대화 바인딩 `{agent?, param?}` 을 실을 수 있다 —
    화면 스레드 문법의 param 축(`:`)은 기판 발급 id 에 실을 수 없으므로(:21 의 왜) 민팅
    순간이 바인딩이 wire 에 닿는 유일한 자리다. 기판의 판정: `agent` 는 agents[] 선언 밖이면
    `E_BAD_AGENT` 400, `agent` 없는 `param` 은 `E_BAD_PARAM` 400 — param 은 "무엇의
    <agent>인가"라 홀로 설 수 없다. 통과한 바인딩은 세션 정체성으로 기록되어 :21 의 행
    메타(`agent`·`param`)로 되돌아오고, 기판은 대화의 페르소나 문맥에 "현재 작업 대상"으로
    반영한다(org 쌍둥이 — relayos `runtime/turn/claudedir.go` 의 param 주입. 목록이면 펴서
    알린다 — 단수 표현은 목록을 하나의 이름으로 오해하게 한다).
    `draft: true`(additive, 2026-08-26)를 함께 실으면 세션이 **작업 사본 트리 위에** 선다 —
    고친 에이전트를 적용 전에 써보는 대화다(페르소나·스킬·커맨드·동사가 전부 작업 사본에서
    오고, 장부·도는 판은 그대로). 작업 사본이 없으면 `E_NO_DRAFT` 400. 행 메타에 `draft: true`
    로 되돌아오며, 작업 사본의 문(`/draft/<pkg>/view/`)이 심는 `__RELAY_CONTEXT.draft` 를
    본 위젯만 이 값을 싣고, 그 문에서는 작업 사본 세션만 목록·이어받기 대상이다(두 판의 대화를
    섞지 않는다).
23. **[현행 v1]** 세션 부속 동사 — 전부 `POST {base}/sessions/<id>/<op>`:
    | op | 요청 | 응답 |
    |---|---|---|
    | `rename` | `{label}` (빈 문자열 = 자동 라벨로 복귀) | `{ok}` |
    | `archive` | `{archived: bool}` | `{ok, archived}` |
    | `pin` | `{pinned: bool}` | `{ok, pinned}` |
    | `delete` | `{}` | `{ok}` |
    | `reset` | `{}` — 이력은 두고 하네스 대화 포인터만 끊는다 (client-wire.ts:703-707 의미 유지) | `{ok}` |
    표의 `delete` 는 §4 의 추상 동사 `session.remove` 에 대응한다 — wire op 명만 다르다
    (부록 A 매핑과 동일).
    archive/pin 은 이력을 지우지 않고 목록의 자리만 옮긴다(client-wire.ts:681-689 의미 유지).
24. **[현행 v1]** `history.get` = `GET {base}/sessions/<id>/history`
    → `{messages: [{role, text, files?, usage?, context?, model?}], busy, turn?}`.
    `busy=true` 면 `turn` 에 진행 중 턴 id 가 실린다.
    *왜: 새로고침 복구가 폴링 없이 한 왕복으로 끝나야 한다 — busy+turn 을 보고 곧장
    `turn.attach` 로 간다. 구 OSS 는 busy 만 주고(구 wire — 삭제됨, 컷 2639dae) 클라이언트가 3초
    폴링으로 종결을 기다렸다(core.js:253-270).*
    `role` 어휘: `user` · `bot` · `sys` (core.js:280-288 현행 유지).

### 5.4 파일 — upload 단일 동사

25. `file.upload` = `POST {base}/upload?name=<파일명>` — **본문이 곧 바이트다**
    (raw 스트림, JSON/base64/multipart 비경유). 응답: `{path, size, name}`.
    [현행 v1: OSS runner/runtime/wire.ts:712-757 · core.js:207-238. relayos 는 3벌로 흩어진 현행
    (`/api/uploads/<script>` transport.ts:100-127 · `/api/fs/upload` transport.ts:174-262 ·
    `<base>/u/_attachments` chat/runtime.ts:771-806 + upload.go:152-156)을 채팅 첨부에
    한해 이 단일 동사로 접는다 — §9.]
    *왜 raw 사이드밴드: base64 JSON 동봉은 팽창+전량 버퍼링+상한 충돌이다(relayos
    transport.ts:101-104 의 판정과 동일). 왜 단일 동사: 같은 "바이트를 올린다"가 세 문법
    이면 위젯이 기판을 안다 — 임베더 테스트 위반.*
    - 반환 `path` 는 **불투명 참조**다. 클라이언트는 파싱·조립하지 않고
      `turn.send.attachments[].path` 와 `file.download` 에만 되돌려준다(§8).
    - 원본 파일시스템 경로는 절대 싣지 않는다(core.js:207-208 현행 규율 유지).
26. **[현행 v1]** **업로드 프로브**: `X-Upload-Probe: 1` + `X-Upload-Size: <bytes>` 헤더의
    무본문 POST 는 바이트 전송 없이 인가·상한을 선판정한다(2xx = 통과).
    relayos 쌍둥이 계약(transport.ts:106-108, 129-148)의 승격 — OSS 데몬 구현은
    client-wire.ts:718-724.
    *왜: 스트림 중 조기 거절은 브라우저에 '네트워크 오류'로만 보인다 — 거절 사유가
    문장으로 오려면 바이트 전에 물어야 한다.*
27. `file.download` = `GET {base}/file/<path>` (+`?dl=1` 로 attachment 처분),
    `HEAD` 는 실재 프로브. [현행 v1: runner/runtime/wire.ts:758-780.]
28. 업로드 진행률은 클라이언트 소관(XHR progress)이다. capability `upload-progress` 는
    "기판의 업로드 경로가 전 구간 스트리밍이라 진행 이벤트가 실제 전송을 반영한다"는
    서버측 선언이다 — 전량 버퍼링 기판은 뺀다.

### 5.5 하네스 — 동사별 capability 게이트

29. `harness.info` = `GET {base}/harness/info` → `{ok, value: {name, provider, protocol,
    verbs, capabilities}}` · `harness.models` = `GET {base}/harness/models` →
    `{ok, value: [...]}` · `harness.commands` = `GET {base}/harness/commands` →
    `{ok, value: [{name, description?, tty?}]}`.
    [현행 v1: runner/runtime/wire.ts:783-807. commands 는 패키지 커맨드 + 하네스 네이티브
    커맨드의 병합(client-wire.ts:800-803) — 병합은 기판 몫이다.]
    조회 동사 셋은 각각 동명 capability(`harness-info` · `harness-models` ·
    `harness-commands`, §7) 뒤에 있다 — 하나로 묶지 않는다.
    `harness.models` 는 `?variant=<name>`(§5.5-30-a 의 이름)으로 활성이 아닌 선언 변형의
    카탈로그도 답한다 — 조회일 뿐 전환이 아니다. 선언 밖 이름은 400 `E_BAD_REQUEST`.
    *왜: 모델 피커가 공급자에 호버만 해도 그 모델 목록을 보여주려면, 전환하지 않고 묻는
    문이 있어야 한다(2026-08-26).*
    *왜 동사 단위인가: 셋을 한 capability 로 묶으면 부분 구현 기판(현행 relayos:
    models·commands ○, info ×)이 §3-8 규율("선언해 놓고 501 은 위반") 아래 합법적으로
    선언할 방법이 없다. 하네스 어휘의 additive 성장(harness-protocol.md:8-9)과도 결이
    맞다 — 새 조회 동사는 새 capability 로 온다.*
30. `harness.set` = `POST {base}/model` — `{model?}` 과/또는 `{effort?}`
    → `{ok, model, effort, known}`. `known: false` 는 경고가 아니라 판정 정보다 —
    저장은 되고, 세션에서 어댑터가 거부하면 그 턴이 실패한다(client-wire.ts:819-827 현행 의미).
    `effort` 필드는 capability `effort` 뒤에 있다(하네스 `effort` capability 의 투영,
    harness-protocol.md:100).
30-a. `harness.variants` = `GET {base}/harness/variants` → `{ok, value: {active, variants:
    [{name, provider?}]}}` · 전환은 §5.5-30 과 **같은 문**이다: `POST {base}/model` 의
    `{harness?}`. 둘 다 capability `harness-variants` 뒤에 있다.
    *왜 설정 문에 있나: 변형 선택은 자격 행위가 아니라 **설정**이다 — 매니페스트가 후보를
    선언하고(BOM: `harness.variants[]`), 장부가 활성 하나를 든다. `model`·`effort` 와 같은
    레코드의 같은 성질의 필드이고(runner/supply/ledger.ts PkgRecord), 선언 밖 이름은 거부된다
    (installer.ts setHarness). 이것을 자격 관리와 한 덩어리로 묶으면, 선언된 후보 중 하나를
    고르는 일까지 계약 밖으로 밀려 화면이 기판마다 갈린다.*
    변형을 바꾸면 기판이 **모델 오버라이드를 지운다** — 모델 어휘는 하네스 소속이라 이전
    어댑터의 모델명이 새 어댑터로 넘어가면 무의미한 인자가 된다(setHarness 의 현행 의미).
    응답의 `known` 은 §5.5-30 그대로 새 하네스 기준으로 판정된다.
    `{harness}` 를 실은 응답은 `ready: {ok, note}` 를 함께 싣는다 — 전환이 어차피 그 변형의
    setup 을 돌리므로(installer.setHarness) 판정이 이미 손에 있다. 전환 자체는 성공하고
    (`ok: true`), `ready.ok=false` 는 다음 턴이 실패한다는 예고다(`known: false` 와 같은 결).
    *왜 버리지 않나: 준비 안 된 하네스로 바꾼 사람에게 아무 말도 안 하면 "왜 안 되지"가
    다음 턴까지 남는다. 후보 **전수** 프로브는 여전히 이 문의 소관이 아니다 — 그건 프로세스
    N개 스폰이고, 기판 소유 콘솔에 이미 그 표면이 있다.*
31. 하네스 **자격** 동사(connect·login 중계 — runner/daemon.ts:943-1018)는 이 계약 밖이다.
    1인 기판의 콘솔 전용 표면이며, org 기판에서 자격은 문이 아니라 권위(fleet)의 소관이다.
    *왜: 최종사용자 채팅 문에 자격 관리가 섞이면 org 기판이 그 동사들을 401 로 도배해야
    한다 — 게이트할 것과 존재하지 않아야 할 것의 구분이다. 이 선은 **자격 행위와 설정** 사이에
    긋는다(2026-08-19 정정 — 종전에는 variants 전환까지 여기 묶여 있었는데, 그것은 설정이라
    §5.5-30-a 로 옮겼다. 기판이 원치 않으면 capability 를 선언하지 않으면 된다).*
    계약 밖이되 방향은 있다 — 결정 G(2026-08-16): 현행 login 중계의 pty 출력 700ms 폴링
    (runner/daemon.ts:918-920 · core.js:393)은 기판 소유 표면에서 SSE 스트림으로 현대화하고,
    relayos 가 실사고로 검증한 무폴링 구조화 플로(begin → 코드 붙여넣기 → complete —
    relayos chat/src/claude-login.tsx:12-15 의 교훈)는 **하네스 어댑터 capability
    어휘의 additive 확장**으로 표현한다(어댑터가 선언하면 구조화 플로, 아니면 pty 스트림).
    자격 브로커 축(누가 OAuth 를 수행하나)은 이 계약이 아니라 권위 이음새 소관이다 —
    [authority-interface.md](authority-interface.md) §3.2.

30-b. **[신설]** `harness.remote` = `GET|POST {base}/harness/remote` — capability `remote`.
    POST 요청: `{enabled}` → `{ok, running, pid, variant, since}`. 어댑터의 `remote` 동사
    (harness-protocol.md §Verbs)를 작업 무대 위에 상주시키거나 내린다. 켜짐은 장부에 남아
    데몬 재기동을 넘긴다. 미선언 하네스는 404 `E_NO_REMOTE`(§3-8 — 없는 문).

### 5.6 열거 — capability `enumerate`, root 소속

32. **[현행 v1]** `instances.list` = `GET {root}/instances` → `{instances: [{
    id, display_name, icon?, greeting?, agents: [string],
    agent: string|null, model?, effort?}]}`.
    - `id` 는 base 마운트의 키다 — 클라이언트는 이 id 로 base URL 을 얻는 기판 제공
      함수를 쓴다(§2).
    - `agent` 는 **착지 에이전트 판정 결과**다. 서버가 판정해서 싣는다(§8).
    - `greeting` 은 **착지 에이전트의 인사말**이다 — 매니페스트 `agents[].greeting`,
      판정은 서버(`manifest.landingGreeting`). 새 대화는 정의상 착지에 떨어지므로
      빈 대화의 첫 줄은 착지의 것이다. 구 `chat?: {greeting?}` 중첩의 자리 —
      `surfaces.chat` 축이 은퇴하면서 행 레벨 필드로 평평해졌다(2026-08-24).
    - OSS 는 `/registry`(runner/daemon.ts:502)의 데이터로 이 동사에 응답한다 — manifest
      전량 노출이 아니라 위 닫힌 shape 로 좁혀서. relayos 는 portal/nav 상당이 같은 동사
      뒤에서 응답한다(승인된 예외 1건 — 상세 경로 미확인, 정렬 시 확정).
    *왜 닫힌 shape: 구 코어는 `/registry` 의 manifest 를 클라이언트에서 파헤쳐 메타를
    조립했다(core.js:49-70). 그 순간 manifest 스키마가 몰래 클라이언트 계약이 된다.*

### 5.7 표면 상태 — capability `state`, 옵셔널

33. **[신설]** `state.get` = `GET {base}/state` → `{state: <JSON>}` ·
    `state.set` = `POST {base}/state` `{state: <JSON>}` → `{ok}`.
    상태의 내용은 기판 소유 불투명 JSON 이다. relayos 의 `host.state` 상당
    (view-alignment.md:70 — "표면 상태 | host.state.get/set(/api/host) | 없음(대응물
    부재)"; 상세 shape 미확인). OSS 데몬은 미구현 — capabilities 에서 뺀다.

### 5.8 push — capability `push`, 옵셔널

34. **[신설]** `push.subscribe` = `GET {base}/events` (SSE). 턴 밖의 협업·자발 이벤트
    창이다: 백그라운드 task 가 유휴 중 완료해 만든 자발 턴(reply `origin:"task"`,
    harness-protocol.md:88-92), 다른 화면·채널이 일으킨 턴 종결 등. 이벤트 shape 는
    §6 봉투와 동형(`data:` JSON, `{event, ...}`).
    [relayos 현행 상당: `EventSource /api/events` — transport.ts:275-355 ·
    chat/transport.ts:368-392. OSS 현행은 3초 유휴 폴링(core.js:73-114) — 은퇴하고,
    push 미구현 기판에서 클라이언트는 다음 사용자 행위 시점의 `history.get` 으로
    따라잡는다. 폴링 폴백은 금지다.]
    실패 시맨틱은 fail-loud 다: 미배선·연속 접속 실패는 침묵 no-op 이 아니라 클라이언트
    `error` 이벤트(no-throw 봉투)로 표면화한다 — relayos 현행의 영구 침묵 강등(dead 래치,
    transport.ts:279-280 "영구 no-op (fail-open)")은 계약 위반이라 승격하지 않는다.
    승격되는 패턴은 셋뿐이다: 공유 커넥션 1개(§5.2 커넥션 예산)·백오프 재접속·visibility
    해제(document.hidden 시 커넥션 반납).
    *왜 옵셔널: push 는 품질이지 정합의 조건이 아니다 — 정본은 기판의 이력이고
    (core.js:74-76 "자발 턴은 기판이 이력에 앉힌다"), push 는 힌트다
    (relayos transport.ts:313 "이벤트는 힌트(SoT=DB)"와 같은 판정).*

## 6. 이벤트 어휘 — 하네스 봉투 protocol 3 재사용

35. `turn.stream`/`turn.attach` 에 실리는 이벤트는 **하네스 봉투 protocol 3 의 어휘를
    그대로 재사용한다**: `delta` · `tool` · `usage` · `task` · `ask` · `steer` · `file` ·
    `limit` · `reply` · `error` — 필드 포함 전부 harness-protocol.md §Events 가 정본이다.
    프레이밍만 JSONL(stdout)→SSE(§5.2)로 바뀐다.
    *왜: 어댑터가 만든 이벤트를 기판이 번역 없이 나른다 — 번역기가 없으면 번역 드리프트도
    없다. 구 OSS 폴링 응답의 `events[]` 도 이미 이 봉투 원본이었다(구 wire — 삭제됨, 컷 2639dae).*
    이 재사용에는 명시 판정 둘이 딸린다:
    - **delta 입자는 계약이 아니다.** 기판은 연속한 `delta` 를 합쳐 보낼 수 있다
      (harness-protocol.md §Delta coalescing — 순서·연결 보존, 비-delta 이벤트를 넘어선 병합
      금지). 클라이언트는 토큰 단위 도착을 가정하지 않는다: 화면은 도착한 조각을 이어 붙일
      뿐이고, "한 글자씩 흐르는가"는 기판·하네스 조합의 성질이지 계약이 주는 보장이 아니다.
      *왜: 전송 한 홉이 비싼 기판(이벤트마다 네트워크 POST)에서는 토큰 입자가 그대로
      어댑터 stdout 의 backpressure 가 된다 — 보고하려던 턴을 보고가 멈춰 세운다.*
    - **툴 인자 스트리밍 손실 — v1 수용.** 봉투 `tool` 이벤트의 `args` 는 ≤2KB·`detail` 은
      요약이라(harness-protocol.md:59-60) stream-json 의 `input_json_delta` 급 인자 실시간
      전개가 없다. v1 은 이 손실을 **수용**한다 — 툴 카드는 시작·대상·종결 요약으로
      그린다. 실시간 전개가 필요해지면 봉투(하네스 축) 개정이 선행이다 — 이 계약이 임의로
      필드를 늘리지 않는다.
    - **`tool.label` — 기판이 붙이는 유일한 필드.** 어댑터는 자기 CLI 의 도구가 아닌 것(우리
      문의 동사 `orders-sync` 같은 슬러그)이 무엇을 하는지 모른다. 그 뜻을 아는 쪽은 자기
      `tools/list` 를 서는 기판이므로, 기판이 장부·스트림에 닿기 전에 짧은 이름을 붙인다.
      정본은 하네스 축이다(harness-protocol.md §Events) — 이 계약이 스스로 늘린 필드가 아니라
      봉투에 선언된 것을 읽을 뿐이다. 없으면 클라이언트는 종전 표시로 떨어진다(없음이 정상이다:
      기판이 서지 않는 도구에는 붙지 않는다).
    - **리플레이 원천 — 봉투 이벤트 장부는 전 기판 의무다.** `turn.stream` 의 종결 턴
      재생(§5.1-13)과 `turn.attach` 의 처음부터 재생(§5.1-14)은 턴 단위 이벤트 장부를
      전제한다. 기판은 봉투 이벤트를 턴 단위로 영속해야 한다(OSS 데몬: 턴 단위 장부
      `turns/<turnId>.jsonl` — client-wire.ts:148-238). 장부 없이 텍스트 이력만으로 격하
      구현하는 것은 위반이다.
36. 클라이언트 수명주기 이벤트 — **닫힌 목록, 이 둘뿐**:
    | 이벤트 | 필드 | 의미 |
    |---|---|---|
    | `turn` | `status: "started"`, `turn`, `session` | 스트림의 첫 이벤트. 관찰이 어느 턴에 붙었는지의 에코 — attach 재생에서도 맨 앞에 온다 |
    | `turn` | `status: "settled"`, `turn`, `ok` | 스트림의 마지막 이벤트. 이후 서버가 스트림을 닫는다. §5.2-20 의 종결 판정 근거 |
    *왜 최소인가: 봉투의 `reply`/`error` 가 이미 턴의 의미적 종결이다
    (harness-protocol.md:68 "Exactly one of reply/error settles a turn"). 수명주기
    이벤트는 의미가 아니라 **프레이밍**(끊김 대 종결의 판별)만 담당한다 — 의미를
    중복하면 두 종결이 어긋나는 날이 온다.*
    **`settled` 뒤로는 어떤 이벤트도 없다 — 장부 재생에서도 같다.** 어댑터가 종결 뒤에도
    출력을 흘리는 경우(기판이 어댑터보다 먼저 정산한 턴)가 실재하는데, 그 잔여를 관찰
    스트림에 실으면 클라이언트는 "끝났다고 했는데 계속 오는" 스트림을 보게 되고 §5.2-20 의
    종결 판정이 무의미해진다. 기판은 종결 이후 도착분을 **관찰 스트림에서 버린다**. 장부에
    남기는 것은 자유이되(포렌식), **재생은 `settled` 에서 끊어야 한다** — 종결 뒤 줄이 남은
    장부를 그대로 재생하면 같은 위반이 재부착에서 재현된다(relayos 실측, 2026-08).
37. 같은 protocol 정수 안에서 클라이언트는 미지의 `event` 값을 렌더하지 않되
    `E_PROTOCOL` 로 승격하지도 않는다(불투명 진행으로 취급).
    *왜: 하네스 축은 additive 로 성장한다(harness-protocol.md:8-9). 하네스 protocol 4 의
    새 이벤트가 문을 통과할 때 클라이언트 축의 버전을 인질로 잡으면 두 축 분리(서문)가
    무너진다.*

## 7. capabilities 닫힌 어휘

| capability | 뜻 | 게이트되는 동사 | 현행 실측 |
|---|---|---|---|
| `push` | 턴 밖 SSE 이벤트 창 | `push.subscribe` | relayos ○ (/api/events) · OSS × |
| `state` | 표면 상태 보관 | `state.get/set` | relayos ○ (host.state 상당) · OSS × |
| `enumerate` | 인스턴스 열거 | `instances.list` | 양쪽 신설 (OSS 는 /registry 재포장) |
| `harness-info` | 하네스 신원·capabilities 조회 | `harness.info` | OSS ○ (client-wire.ts:783-807) · relayos × (현행 대응물 부재 — 정렬 시 신설 또는 미선언) |
| `harness-models` | 모델 카탈로그 조회 | `harness.models` | OSS ○ (client-wire.ts:783-807) · relayos ○ (/api/llm/models, api_turns.go:317) |
| `harness-variants` | 하네스 변형 조회·전환 | `harness.variants` · `harness.set({harness})` | OSS ○ (client-wire.ts) · relayos ○ (2026-08-20 — §5.5-31 의 "선택은 설정" 정정을 따라 my-llm 레코드가 장부: 선언 BOM 게이트·전환 시 model clear·ready 동봉) |
| `harness-commands` | 커맨드 목록 조회 | `harness.commands` | OSS ○ (client-wire.ts:783-807, 800-803) · relayos ○ (/api/instances/commands, api_turns.go:271) |
| `effort` | effort 설정 수용 | `harness.set` 의 `effort` 필드 | 하네스 어댑터 capability `effort` 의 투영 |
| `upload-progress` | 업로드 전 구간 스트리밍(진행률이 실제를 반영) | (서빙 방식 선언 — 동사 없음) | 양쪽 스트리밍 (client-wire.ts:735-752 · upload.go) |
| `observe` | 관찰 다중화 — 세션 여러 개의 턴 스트림을 SSE 한 줄기로(§5.2-20-a) | `GET /observe` · `POST /observe/<id>/sessions` (추상 동사 `turn.stream/attach` 의 운반 방식 — 소비자 표면 변화 없음) | OSS ○ (2026-08-27, runner/runtime/wire.ts) · relayos × (미선언 → 직접 SSE + 인스턴스당 3 상한) |
| `steer` | 진행 중 턴에 사용자 발화 얹기 | `turn.steer` | 하네스 어댑터 capability `steer` 의 투영 — claude-code ○ · codex/kimi/pi ×(`serve` 자체가 없어 얹을 프로세스가 없다) |
| `cancel-by-session` | 턴 id 없이 대화축으로 진행 턴 취소 | `turn.cancel` | relayos ○ (채널 어댑터가 소비 — POST /turns/cancel) · OSS × (턴 id 를 쥔 화면뿐) |

38. 이 표가 어휘의 전부다. 새 capability = 이 문서의 개정이다. `turn.attach` 는 이 표에
    없다 — capability 가 아니라 필수 동사다(§5.1-14: 복구 경로의 유일한 정본이고, 장부
    보관은 stream 재생이 이미 전 기판에 요구한다).
    *왜 닫힌 어휘인가: 열린 어휘는 기판별 사투리를 부른다 — "우리 기판만 아는 능력"이
    자라기 시작하면 위젯이 기판을 안다(임베더 테스트 위반). 하네스 capabilities 와 같은
    규율이다(harness-protocol.md:99-100).*

## 8. 승격되는 문자열 상수 어휘 — 서버 정본, 클라이언트 재구현 금지

여기 오는 것들은 지금까지 코드 양쪽에 흩어져 하드코딩으로 살아온 문자열 계약이다.
이 계약이 상수 어휘로 승격하며, **정본은 항상 서버(기판) 쪽**이고 클라이언트는 명세된
소비만 한다.

39. **a2a 위임 마커** — `[미션 수신: <mission>[ ← <consumer>]]` + 개행, 위임 프롬프트의
    첫 줄. ` ← <consumer>` 부분은 **옵셔널**이다 — consumer 미상 위임은
    `[미션 수신: <mission>]` 형으로 온다(생산 정본: runner/protocol.ts:12-14
    `a2aMissionMarker` — 무-consumer 분기는 protocol.ts:13, 호출부 api.ts:311;
    consumer 는 dispatch 의 옵셔널 인자다 api.ts:304). 소비: 위젯이 발신자 카드로 렌더
    (chat/src/widget.js:1276-1277 의 정규식 — ← 그룹을 옵셔널로 매칭). v1 판정:
    마커 문법은 이 조항이 정본이고, 클라이언트는 여기 명세된 형태(옵셔널 분기 포함)만
    매칭한다 — 자체 변형 정규식 금지.
    *왜 아직 문자열인가: 마커는 이력 원문에 살아야 한다(이력 = 프롬프트 원문 원장).
    구조 필드로 옮기면 이력 스키마 개정이 필요하다 — 그건 이 계약의 범위 밖이므로 v1 은
    문자열을 고정하는 데서 멈춘다.*
40. **`uploads/` 접두** — 업로드 착지 참조의 접두. 정본: runner/protocol.ts:21-22
    (`UPLOADS_DIR`/`UPLOADS_PREFIX`), 호출부 client-wire.ts:728, 751.
    기판 내부 소비: 아웃바운드 파일 스캔에서 인바운드 무대 제외(runner/runtime/harness.ts:402-416).
    v1 판정: 이 접두는 **기판 내부 어휘**로 강등된다 — 클라이언트에게 `path` 는 불투명
    참조다(§5.4-25). 클라이언트가 `uploads/` 를 검사·조립하는 코드는 계약 위반.
41. **툴 이름 문법** — `a2a__<pkg>__<mission>` · `edge__<pkg>__<tool>`
    (`dir__<서비스>__<연산>` 접두는 2026-08-28 은퇴 — 폴더는 세션 도구가 아니라 동사가 감싼다)
    (정본: runner/protocol.ts 접두 상수 · 생산 함수 · 집행 파서;
    호출부: 생산 api.ts:352, 357 · 집행 api.ts:392-403) · `mcp__<name>__*`
    (harness-protocol.md:43). 소비: 위젯의 도구 카드 라벨링(widget.js:1510-1515).
    v1 판정: 세 접두와 `__` 구분자는 계약 상수다. 클라이언트는 **표시 목적의 분해**만
    허용되고, 이름 조립·권한 추론은 금지다(집행 판정은 서버 스코프 게이트가 정본 —
    api.ts:365-366).
42. **착지 에이전트 판정** — 정본: runner/supply/manifest.ts:441-448 (`default: true` 명시 선언
    > "패키지 짧은 이름과 같은 에이전트" 관례). 구 코어는 이 판정을 클라이언트에서
    재구현했다(core.js:54-66 — 주석 스스로 "기판 landingAgentName 과 같은 판정").
    v1 판정: 재구현 금지 — `instances.list` 응답의 `agent` 필드(§5.6-32)가 판정 결과를
    나르고, 클라이언트는 그것을 그대로 쓴다.
    *왜: "같은 판정 두 벌"은 한쪽만 고쳐지는 날 소리 없이 갈라진다 — manifest 평면의
    쌍둥이 경로 규율과 같은 이유다.*

42-a. **세션 문지기 문장** — `이 대화는 아직 이전 요청을 처리하는 중입니다. 끝나면 이어서 말씀해
    주세요 (급하면 진행 표시의 중지를 누르세요)`. 정본: runner/runtime/harness.ts runSession 의
    `live` 슬롯 검사 — 같은 슬롯에 하네스 프로세스가 살아 있으면 그 발화를 **받지 않고** 이 문장으로
    거절한다(봉투 `error` 로 종결). §5.1-12 의 직렬화가 정상이면 wire 턴은 여기 닿지 않는다 —
    닿는 것은 wire 밖 경로끼리의 충돌(배달 재시도 등)뿐이다. 소비: 위젯은 이 문장을 알아보고
    재전송 버튼 대신 "앞선 요청이 끝난 뒤 다시 보내 주세요"를 세운다(chat/src/chat/runtime.ts
    BUSY_GUARD_RE) — 재전송은 같은 문지기에 또 부딪힌다(실측 2026-08-28: 1초에 3번).
    v1 판정: 문장은 서버 정본, 클라이언트는 앞부분("이전 요청을 처리하는 중")만 매칭한다.

## 9. 클린 브레이크 — 호환 창 없음

43. **호환 창을 두지 않는다.** 위젯은 `cache-control: no-store` 로 서빙되어
    (runner/daemon.ts:777-778) 기판과 원자적으로 함께 움직인다 — 낡은 클라이언트가 새 문에
    붙는 조합이 구조적으로 없다. 구/신 wire 병존 기간, 세대 혼합, 과도기 변환기 모두 금지.
    *왜: 과도기 변환기는 영구 코드가 된다. 위젯-기판 원자성이 공짜로 주는 클린 브레이크를
    쓰지 않을 이유가 없다.*
44. **버전 판정은 fail-loud** — §3-7. 신 클라이언트가 구 기판을 만나면(capabilities 404)
    `E_PROTOCOL` 을 그린다. 폴백 없음.
45. **제거되는 구 wire — OSS 데몬** (전부 runner/daemon.ts):
    | 구 경로 | 실측 | 대체 |
    |---|---|---|
    | `POST /pkg/:pkg/chat` (블로킹) | 구(삭제됨 — 컷 2639dae) | `POST {base}/turns` + stream |
    | `GET /pkg/:pkg/session/:slot/events` (900ms/3s 폴링) | 구(삭제됨 — 컷 2639dae) | `turn.stream` / `turn.attach` / `push` |
    | `POST /pkg/:pkg/session/:slot/cancel` | 구(삭제됨 — 컷 2639dae) | `POST {base}/turns/<id>/interrupt` |
    | `POST /pkg/:pkg/session/:slot/answer` | 구(삭제됨 — 컷 2639dae) | `POST {base}/turns/<id>/respond` |
    | history.busy 3초 감시 폴링 | 구(삭제됨 — 컷 2639dae) | `history.get` 의 `turn` + attach |
    | 클라이언트 slot 발급 | 구(삭제됨 — 컷 2639dae) | `POST {base}/sessions` |
    | `/registry` 의 클라이언트 manifest 파싱 | 구(삭제됨 — 컷 2639dae) | `instances.list` 닫힌 shape |
    | `instances.list` 의 `chat?: {greeting?}` | 구(삭제됨 — 2026-08-24) | 행 레벨 `greeting?` — 매니페스트 `surfaces.chat` 은퇴, 인사말은 `agents[].greeting` |
    세션 부속(`label`·`archive`·`pin`·`delete`·`history`·`sessions`)과 파일
    (`upload`·`file`)·하네스 조회는 경로 재편만 있고 의미는 승격 유지다.
46. **폐기·정렬되는 현 wire — relayos**:
    | 현행 | 실측 | 처분 |
    |---|---|---|
    | GET `/api/turns/stream` 쿼리 단독 시작 | chat/transport.ts:67-74 | 시작은 `POST /turns` 단일로 — stream 은 관찰 전용 |
    | `POST /api/turns/active` | chat/transport.ts:75-76 | `history.get` 의 `busy`/`turn` 으로 흡수 |
    | 업로드 3벌 (`/api/uploads/<script>` · `/api/fs/upload` · `<base>/u/_attachments?access_token=`) | transport.ts:100-172, 174-262 · runtime.ts:771-806 · upload.go:152-156 | 채팅 첨부는 `file.upload` 단일 동사. 스크립트 사이드밴드·워크스페이스 fs 는 채팅 계약 밖 잔류 |
    | `X-Relay-Instance` 헤더 계약 | chat/transport.ts:257-262 | base URL 주입으로 강등(§2-6) |
    | `conversations`/`sessions` 이원 어휘 (4축 키 POST body) | api_turns.go:188-268 | `session` 단일 어휘 + 불투명 세션 id — 4축 키는 deployd/control 내부 매핑으로 |
    | planHttpCall 매핑표 자체 | chat/transport.ts:63-138 | 위젯 React 판이 이 계약의 wire 를 직접 말한다 — 브리지 method 명 어휘 은퇴 (재작성은 OSS 승격 후 OSS 트리에서, §9-47-2) |
47. **마이그레이션 순서** (전송은 무상태 — 세션·이력 데이터는 손대지 않으므로 migrate
    도구가 필요 없다):
    1. 이 문서를 OSS `docs/client-protocol.md` 로 확정.
    2. **React 위젯 소스 OSS 승격**: relayos `chat/src/chat/` 를 OSS 로 승격하고
       (relay-ui V1 과 같은 승격 레일), **OSS 트리에서** planHttpCall
       (chat/transport.ts:63-138)을 이 계약의 wire 로 재작성한다 — 브리지 method 명
       어휘는 여기서 은퇴.
       *왜 이 단계가 컷보다 먼저인가: 소스 승격 없이는 3의 OSS 컷이 번들을 구울 원료가
       없고, 재작성 없이는 구 deployd wire 를 말하는 위젯이 신 OSS 데몬에 동봉된다.*
    3. OSS 한 컷: runner/daemon.ts 에 신 wire 구현(`turn.attach` + 이벤트 장부 재생 포함,
       §5.1-13/14) + 2의 신 transport 를 담은 React 위젯 번들 동봉(`/assets` 다중 파일
       서빙 확장) + 구 wire 삭제 — **같은 커밋**. 위젯 no-store 원자성이 이 컷을
       안전하게 만든다. **클라이언트 프로토콜 버전 1 은 이 컷부터 발효된다** —
       capabilities 가 `{protocol: 1}` 을 답한다.
    4. relayos 정렬 컷: deployd 를 **같은 버전 1 계약**의 org 구현체로 정렬(해체는 후속
       트랙 — 확정 결정 C)하고, 위젯은 **OSS 릴리스 아티팩트의 번들을 재벤더링해
       소비**한다(확정 결정 B). relayos 트리의 `chat/` 직접 편집은 이 컷부터 **금지**다 —
       고칠 일은 OSS 커밋 → pin bump (convergence.md 불변 1 "정본은 밖, 무패치").
       **4-a. 두 번째 구현체의 소거 (2026-08-24 추가).** 4 는 착지했고(relayos
       `deploy/images/deployd/api_contract.go`), 그 정렬만으로는 구현이 여전히 둘이다.
       소거의 선행 조건은 OSS 의 계약 축 이음새였고 그것이 이 컷에서 섰다(`ClientWireIO`).
       남은 것은 org 쪽 작업이다: 임베디드 데몬에 이음새 구현(control 저장소)을 꽂고,
       문에는 인증·마운트·경계만 남긴다. 계약 문서가 요구하는 것은 하나뿐이다 — **소거
       뒤에도 같은 판정기를 지날 것**(아래 5).
    5. conformance: `relay harness-check` 상당의 client-check 를 후속으로 — 두 구현체가
       같은 판정기를 지나야 "정본 하나, 구현체 둘"이 문서 밖에서도 참이 된다.

## 부록 A — 신 동사 ↔ 구 OSS wire ↔ 현 relayos wire 전량 매핑

| 신 동사 (v1 wire) | 구 OSS wire | 현 relayos wire |
|---|---|---|
| `capabilities` — GET `{base}/capabilities` | 부재 | 부재 |
| `turn.send` — POST `{base}/turns` | POST `/pkg/:pkg/chat` 블로킹 — 삭제됨(컷 2639dae) | POST `/api/turns` (api_turns.go:164) + GET `/api/turns/stream` 단독 시작 (chat/transport.ts:69) |
| `turn.stream` — GET `{base}/turns/<id>/stream` | GET `/session/:slot/events?from=` 900ms 폴링 — 삭제됨(컷 2639dae) | GET `/api/turns/stream` SSE (api_turns.go:154) |
| `turn.attach` — GET `{base}/turns/attach?session=` | 부재 — history.busy 3s 폴링 (core.js:253) | GET `/api/turns/attach` SSE (api_turns.go:157) |
| `turn.interrupt` — POST `{base}/turns/<id>/interrupt` | POST `/session/:slot/cancel` — 삭제됨(컷 2639dae) | POST `/api/turns/<id>/interrupt` (api_turns.go:182) |
| `turn.respond` — POST `{base}/turns/<id>/respond` | POST `/session/:slot/answer` — 삭제됨(컷 2639dae) | POST `/api/turns/<id>/respond` (api_turns.go:180) |
| (흡수: history.busy/turn) | GET `/session/:slot/history` 의 `busy` — 삭제됨(컷 2639dae) | POST `/api/turns/active` (chat/transport.ts:75) |
| `session.list` — GET `{base}/sessions` | GET `/pkg/:pkg/sessions` — 삭제됨(컷 2639dae) | GET `/api/conversations` (api_turns.go:222) |
| `session.create` — POST `{base}/sessions` | 클라이언트 로컬 발급 (core.js:319) | POST `/api/sessions/uuid` (api_turns.go:196) |
| `session.rename` — POST `{base}/sessions/<id>/rename` | POST `/session/:slot/label` — 삭제됨(컷 2639dae) | POST `/api/conversations/rename` (api_turns.go:198) |
| `session.archive` — POST `{base}/sessions/<id>/archive` | POST `/session/:slot/archive` — 삭제됨(컷 2639dae) | 부재(미확인) |
| `session.pin` — POST `{base}/sessions/<id>/pin` | POST `/session/:slot/pin` — 삭제됨(컷 2639dae) | 부재(미확인) |
| `session.remove` — POST `{base}/sessions/<id>/delete` | POST `/session/:slot/delete` — 삭제됨(컷 2639dae) | POST `/api/conversations/delete` (api_turns.go:199) |
| `session.reset` — POST `{base}/sessions/<id>/reset` | POST `/pkg/:pkg/session/reset` — 삭제됨(컷 2639dae) | POST `/api/sessions/reset` (api_turns.go:190) |
| `history.get` — GET `{base}/sessions/<id>/history` | GET `/session/:slot/history` — 삭제됨(컷 2639dae) | GET `/api/conversations/messages` (api_turns.go:206) |
| `file.upload` — POST `{base}/upload?name=` (+프로브) | POST `/pkg/:pkg/upload?name=` — 삭제됨(컷 2639dae) | 3벌: `/api/uploads/<script>` (transport.ts:127) · `/api/fs/upload` (transport.ts:221) · `<base>/u/_attachments?access_token=` (runtime.ts:804 · upload.go:156) |
| `file.download` — GET/HEAD `{base}/file/<path>` | GET/HEAD `/pkg/:pkg/file/<path>` — 삭제됨(컷 2639dae) | `/api/fs/download` (transport.ts:188 — deployd 등록은 api.go 판, api_turns.go:377 주석) |
| `harness.info` — GET `{base}/harness/info` | GET `/pkg/:pkg/harness/info` — 삭제됨(컷 2639dae) | 부재 (현행 대응물 없음 — 정렬 컷에서 deployd control 중계로 신설하거나 `harness-info` 미선언, §7) |
| `harness.models` — GET `{base}/harness/models` | GET `/pkg/:pkg/harness/models` — 삭제됨(컷 2639dae) | GET `/api/llm/models` org 전역 카탈로그 (api_turns.go:317) |
| `harness.commands` — GET `{base}/harness/commands` | GET `/pkg/:pkg/harness/commands` — 삭제됨(컷 2639dae) | GET `/api/instances/commands` (api_turns.go:271) |
| `harness.set` — POST `{base}/model` | POST `/pkg/:pkg/model` — 삭제됨(컷 2639dae) | POST `/api/sessions/effort`·`/model` (api_turns.go:191,193) · `/api/instances/my-llm` (api_turns.go:339) |
| `instances.list` — GET `{root}/instances` | GET `/registry` manifest 전량 (api.ts:574 · core.js:49) | portal/nav 상당 (경로 미확인 — 정렬 시 확정) + `/api/instances/agents` @ 피커 (api_turns.go:294) |
| `state.get/set` — GET/POST `{base}/state` | 부재 | `host.state` 상당 `/api/host` (view-alignment.md:70 — 상세 미확인) |
| `push.subscribe` — GET `{base}/events` | 부재 — 3s 유휴 폴링 (core.js:91) | `EventSource /api/events` (transport.ts:336 · chat/transport.ts:383) |

계약 밖 잔류(매핑하지 않음): OSS 설치·스토어·draft·grants·MCP 문(runner/daemon.ts 의
나머지), relayos 스크립트 동사문(`/api/scripts`)·워크스페이스 fs(`/api/fs/*` 일반)·
`/api/settings/chat-limits`(api_turns.go:308 — org 전역 정책, 계약 승격은 후속 판단)·
`/api/triggers/mine`(api_turns.go:326)·fs.watch(api_turns.go:364).
