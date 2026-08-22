# 권위 이음새 (Authority interface) — 초안

기판(`runner/`)의 실행 반쪽과 권위 반쪽 사이의 유일한 인터페이스 계약.
정본 위치는 `relayagent-oss/docs/authority-interface.md`. 계약의 코드 반쪽은
`runner/authority-contract.ts`(의존성 0 독립 파일 — 임베더가 벤더링하는 아티팩트),
1인 기판 구현은 `runner/authority.ts` 의 `localAuthority` 다. 배경 문서:
relayos-claude/docs/convergence.md §"runner의 두 반쪽" 및 §"OSS 선행 작업 3" 의 1번
("권위 이음새 추출")이 이 문서의 정의다.

> 상태: **§8 2단계 착지(2026-08-17).** §3 의 8개 동사는 현행 코드에 계약으로 존재하고,
> §4 의 확장 중 셋(audit · recordGrant/removeGrant · approveInstall)은 §9 의 확정과 함께
> `authority-contract.ts` 에 타입으로, `authority.ts` 에 로컬 래퍼로 착지했으며
> (`AuthorityGrant.components` 추가 포함), 이음새 밖 직결 소비는 전부 이음새 뒤로
> 이사했다. 동기 계약에 박혀 이사가 시그니처 연쇄를 일으키는 지점만 `§8-2 잔여` 주석으로
> 남는다(§8-2 게이트 참조). §4.4(세션 스코프)는 **편입하지 않기로 확정**. 남은 것은
> §8 3단계(control-ts 어댑터)다.

## 1. 목적

1. **runner 는 두 반쪽이다.** 실행 반쪽(스폰·빌드·세션·하네스)과 권위 반쪽(신원·장부·
   vault·설치 관문). 모든 소비 — 동사 실행, edge, a2a, 채널, 도구 — 는 한 질문으로
   환원된다: **"누구로서, 무엇을, 어떤 자격으로."** 이 문서는 그 질문의 문(門)을 메서드
   단위 계약으로 고정한다. *왜: 질문이 여러 문으로 흩어지면 같은 질문에 두 경로가 다른
   답을 내는 비대칭이 생긴다 — 현행 코드가 이미 이 원칙을 명문화했다
   (`runner/authority.ts:1-12` 머리 주석, `runner/api.ts:330` "인가 판정은 권위 이음새를
   지난다").*
2. **1인 기판은 로컬 구현, 조직은 원격 구현.** 1인 기판은 로컬 장부(`~/.relay/ledger.json`)·
   vault(Keychain/파일)·OS 사용자가 답한다(`localAuthority`, `runner/authority.ts:20-33`).
   조직 기판은 같은 인터페이스의 control-ts 어댑터가 원격으로 답한다. *왜: 권위 백엔드만
   갈아 끼우면 runner 본체가 개인과 조직에서 동일 바이너리로 돈다 — 이것이 "임베드 가능
   모드"의 진짜 내용이다.*
3. **"OS 의 runner 는 없다."** runner 는 하나(OSS 정본)이고, 조직 소유의 runner 인접
   코드는 이 인터페이스의 control-ts 구현 하나뿐이다 (convergence.md §"runner의 두 반쪽").
   *왜: 어댑터 이외의 runner 인접 코드가 생기는 순간 포크가 시작되고, upstream-first
   규율(무패치 벤더링)이 무너진다.*
4. **익명의 제3자 임베더 테스트.** 이 인터페이스는 relayos 를 모른다. principal 이 문자열
   하나인 것, 자격이 (스코프 → 값)인 것, 인가가 (consumer, provider, 능력) 장부인 것 —
   어느 답도 특정 조직 기판의 형상을 요구하지 않는다(`authority-contract.ts:1-3` 머리
   주석). org 의미(member, 라이선스, principal 바인딩)는 전부 **어댑터 구현의 내부**다.
   *왜: relayos 만 쓸 수 있는 훅은 "OSS 가 relayos 를 알게 하는 변경 금지" 위반이다.*

## 2. 계약의 형태 규칙

1. **계약 파일은 자기 완결이다.** `authority-contract.ts` 는 runner 내부 형(`Ledger` 등)을
   import 하지 않는다. *왜: 계약이 runner 형을 끌어오면 임베더가 runner 전체를 알아야
   한다 — 벤더링 단위가 파일 하나여야 어댑터가 얇게 유지된다.*
2. **비동기가 기본이다.** 원격 권위는 판정·자격이 네트워크 왕복이다. `principal()` 과
   `packageToken()` 만 동기다 — 실행 문맥에 이미 앉아 있는 값(env·장부)이라 왕복이
   없다(`authority-contract.ts:14-16`). *왜: 로컬이 동기라는 이유로 이음새를 동기로
   굳히면 원격 구현이 불가능해져 이음새가 장식이 된다.*
3. **grant 는 선언을 초과할 수 없다.** 인터페이스의 어떤 동사도 manifest 가 선언하지
   않은 능력을 활성화하지 못한다. 판정의 자리는 구현마다 다르되(§4.2) 불변식은 같다.
   *왜: 선언은 신청, 결재는 활성화 — 이 순서가 뒤집히면 장부가 만능 열쇠가 된다.*

## 3. 현행 표면 — 8개 동사 (`authority-contract.ts:17-33`)

각 동사의 로컬 구현 위치와 control-ts 원격 대응물. control-ts 열은
`relayos-claude/control-ts/ARCHITECTURE.md` 기준이며, 어댑터는 아직 존재하지 않는다 —
"대응물"은 어댑터가 감쌀 기존 도메인 기계를 가리킨다.

### 3.1 신원

| 동사 | 계약 | 로컬 구현 | control-ts 대응물 |
|---|---|---|---|
| `principal(): string` | 누구로서 — 이 소비를 감싸는 principal. 1인 기판은 항상 소유자 하나 | `state.ts:165` `PRINCIPAL = os.userInfo().username` | GoTrue JWT → `AuthService`/`convergePrincipal` (ARCHITECTURE.md §0 "인증 = GoTrue JWT", §7 API 토큰 항목). 좌표 = member |
| `packageToken(pkg): string` | 실행 단위(패키지)의 신원 토큰 발급 | `state.ts:99-101` `pkgToken` — 장부 secret HMAC-SHA256 40자 | `RELAY_INSTANCE_TOKEN` mint (ARCHITECTURE.md "몸의 자격 = 신원 기반 pull" — pkg-server 와 동일 mint, 결정적/무 exp) |
| `packageForToken(token): Promise<string \| null>` | 신원 토큰 해석. 실패는 `null` — fail-closed 는 호출부 소관 | `state.ts:103-106` `tokenToPkg`. 소비처: MCP 문 게이트 `api.ts:847-854` (`토큰 불일치` = 401) | `token.controller` — 좌표 (RELAY_INSTANCE_TOKEN, principal) (ARCHITECTURE.md §0) |

- *왜 토큰 해석 실패가 `null` 인가:* 이음새는 사실만 답하고("이 토큰의 주인은 없다"),
  거부의 형태(401·오류 봉투)는 문마다 다르다. 판정을 이음새에 넣으면 HTTP 어휘가 계약에
  스민다.
- *왜 principal 이 문자열 하나인가:* 1인 기판의 principal 은 OS 사용자, 조직의 principal 은
  member 해석 결과 — 어느 쪽도 상대의 구조를 요구하지 않는 최소 공통형이다. 아웃바운드
  호출에는 기판이 `x-relay-principal`/`x-relay-agent` 로 싣는다(`scripts.ts:96-114`,
  docs/verb-contract.md §Identity on outbound calls). 저작자 코드는 신원에 손이 없다.

### 3.2 자격

| 동사 | 계약 | 로컬 구현 | control-ts 대응물 |
|---|---|---|---|
| `credential(scope): Promise<string \| null>` | 어떤 자격으로 — 스코프 좌표의 자격 값, **요청 시점 발급**. 없으면 `null` | `vault.ts:36-42` `vaultGet` (Keychain, 0600 파일 폴백). 좌표 문법 `<pkg>/<service>` = `vault.ts:53` `credKey` | `POST /connections/token:issue` · `/llm/token:issue` — 요청 시점 발급, 좌표 (인스턴스 신원 토큰, principal) (ARCHITECTURE.md §0) |
| `setCredential(scope, value): Promise<void>` | 자격 기록 | `vault.ts:26-34` `vaultSet` | `ConnectionService.vaultScope` — 자격 좌표 = (커넥터, principal), 공용 술어 `connectorScope(pkg)` (ARCHITECTURE.md §7 "자격 좌표" 항목) |

1. **자격은 요청 시점 pull 이다. env 상주 금지.** *왜: 상주가 없어야 회전·revoke 가 다음
   호출부터 즉시 선다(`scripts.ts:173` 주석). control-ts 쪽도 같은 결론에 독립적으로
   도달했다 — "edge 자격을 몸 env 로 배달하지 않는 것은 불변"(ARCHITECTURE.md §7).*
2. **회전(rotate)은 계약 동사가 아니라 `credential()` 의 의미론이다.** `credential()` 은
   "지금 유효한 자격"을 답할 의무가 있고, 그것을 어떻게 유지하는가는 구현 소관이다 —
   로컬은 OAuth 번들을 만료 60초 전에 자동 회전하고(`oauth.ts:155` `oauthHeader`), 원격은
   token:issue 가 매번 단기 토큰을 발급한다. *왜: rotate 를 별도 동사로 노출하면 호출부가
   회전 시점을 판단하게 되고, 잊은 호출부가 만료 토큰을 쓴다.*
3. **단기 토큰 발급 지향, 장기 비밀 내려보내기 금지.** 원격 구현은 장기 비밀(리프레시
   토큰, 봇 마스터 토큰)을 절대 이음새 밖으로 내리지 않는다 — 답은 항상 지금 쓸 수 있는
   단기 자격이다. *왜: federation 전 3수칙의 하나(convergence.md §순서)다. 저신뢰 worker
   에 장기 비밀이 내려가는 순간 회수가 불가능해진다.*
4. **이음새 밖 소비의 이사 — §8 2단계로 착지(2026-08-17).** scripts.ts(커넥터 자격
   선발급)·oauth.ts(번들 읽기·회전 저장)·session.ts(LLM 자격)·relay.ts(스토어 키·서명
   키·커넥터 토큰)·api.ts(스토어 키·채널 자격)는 전부 `authority.credential`/
   `setCredential` 을 지난다. 동기 계약에 박혀 이사가 시그니처 연쇄를 일으키는 지점만
   vault 직독으로 남고 `§8-2 잔여` 주석을 동반한다: `installer.ts` `llmEnv`(동기 하네스
   동사 체인)·`connectHarnessToken`, `pack.ts` 서명 키(동기 pack 계약), run.ts
   `RunnerIO.credential`(스폰 전 선발급 동기 계약 — 원격 권위의 선발급은 임베더 소유).
5. **자격 브로커는 구현 내부다 — runner 에 provider 브로커 하드코딩 금지** (결정 G,
   2026-08-16). 조직 기판의 LLM OAuth 브로커(control 자체 PKCE 구현)는 `credential()`
   원격 구현의 내부 기계이고, 1인 기판의 답은 vault + 하네스 어댑터 `login` 동사다
   (`auth.kind: oauth` 는 기판이 값을 보지도 저장하지도 않는다 — `installer.ts:455-472`).
   *왜: 하네스 중립은 불가침이다(OSS CLAUDE.md 규율 5 — runner 에 vendor 하드코딩 금지).
   브로커를 이음새 뒤(구현 내부)에 두면 조직은 자기 provider 를 최적화하고 OSS 는 중립을
   지킨다. connect 경로의 "나은 매커니즘 따라가기"에서 wire 층(pty 폴링→SSE·구조화
   begin/complete 플로)은 client-protocol §5.5-31 과 하네스 어휘 확장의 몫이고, 브로커
   층은 이 자리다.*

### 3.3 grant 조회

| 동사 | 계약 | 로컬 구현 | control-ts 대응물 |
|---|---|---|---|
| `grants(): Promise<AuthorityGrant[]>` | 인가 장부 전체 | `authority.ts:27` → `ledger.grants` (`state.ts:67-80`) | Edge 행 (ARCHITECTURE.md §0 "인가 경계 = Edge 행 단위") |
| `grantForTool(consumer, provider, tool)` | consumer 가 provider 의 tool 을 소비할 인가. 없으면 `null` | `authority.ts:28-29`. 소비처: edge 소비 게이트 `api.ts:329-332` (`E_NO_GRANT`) | 활성 Edge 행 판정 (`transport: mcp`, `status: active` — pending 은 어떤 런타임 배선에도 비노출) |
| `grantForMission(consumer, provider, mission)` | a2a 위임 인가. 없으면 `null` | `authority.ts:30-31`. 소비처: a2a 게이트 `api.ts:363-364` | a2a = 활성 Edge 게이트 (`transport: a2a`, ARCHITECTURE.md §7 edge-cutover 항목) |

- *왜 tool/mission 이 별도 동사인가:* grant 한 줄은 tools · mission · components 중 정확히
  하나의 형이고(`installer.ts:634-635`), 소비 지점도 다르다(도구 호출 vs 세션 스폰).
  하나의 `check(연산)` 로 뭉치면 형 판별이 호출부로 새어 나간다.
- **3형은 계약 타입에 전부 실린다 — 착지됨(2026-08-16).** 구 `AuthorityGrant` 는
  `tools?`·`mission?` 만 갖고 components 형이 없어, 로컬 장부의 `Grant`(`state.ts:67-73`)가
  표현하는 행을 계약이 표현하지 못하는 간극이 있었다. §8 1단계에서 `components?: boolean`
  을 추가해 해소 — `grants()` 가 components 행을 답할 수 있고, §4.2 의 결재 문이 3형
  모두에 대해 유일한 문으로 성립한다.
- *왜 판정 결과가 boolean 이 아니라 grant 행인가:* 소비 집행이 행의 내용(tools 목록 등)을
  다시 볼 수 있어야 하고, 감사가 "어느 결재로 통과했나"를 기록할 수 있어야 한다.

## 4. 확장 표면 — 계약 편입 제안 4축

다음 네 판정은 권위 판정이면서 이음새 밖에 살았다. **2026-08-16 확정**: 셋(4.1 감사 ·
4.2 결재 문 · 4.3 설치 관문)은 계약에 편입되어 타입·로컬 래퍼가 착지했고(§8 1단계),
4.4(세션 스코프)는 편입하지 않는다(§9).

### 4.1 감사 append

```ts
/** append-only. 판정·결재·소비의 원장 — 권위가 소유한다 */
audit(kind: string, data: Record<string, unknown>): Promise<void>;
```

| | 로컬 구현 | control-ts 대응물 |
|---|---|---|
| 현행 | 로컬 구현 `state.ts` `logLine` — `~/.relay/logs/<kind>.jsonl` append. 소비처는 §8 2단계로 `authority.audit` 를 지난다(login.ts · tick.ts · session.ts · run.ts localIO). 동기 파이프라인 잔여만 `logLine` 직결로 남는다(`§8-2 잔여` 표기: build.ts · pack.ts · registry.ts) | `domains/audit` (순수 Postgres 레코드 — ARCHITECTURE.md §5). 결재 기록 관례: grant 발급/회수가 audit 원장에 앉는다 (§7 capability 위임 항목 "발급/회수는 audit 원장(grant.create/grant.revoke)") |

- *왜 권위 반쪽 소속인가:* "누가 무엇을 결재했고 누가 무엇을 소비했나"의 원장은 판정의
  근거이자 산출물이다. 실행 반쪽에 남기면 조직 감사가 박스별 파일에 흩어진다 —
  "패키지가 하면 누가 심판하나" 테스트의 감사 축이다.
- **append 실패의 의미론 — 2계열 확정(2026-08-16, §9-2).** 결재 계열(§4.2·§4.3 의 동반
  기록)은 본 행위 전에 성공해야 하고 실패가 행위를 막는다 — 결재는 드물고 중요하며, 원장
  없는 결재는 무효다. 소비 계열(동사 실행 등 빈번 기록)은 행위를 뒤집지 않되 실패를 조용히
  삼키지 않는다(호출부 fail-loud 표면화) — 조직의 가용성이 감사 DB 순단에 인질 잡히지
  않는다. 빠진 기록은 해시체인이 드러낸다.

### 4.2 grant 기록 (결재 문)

```ts
/** 장부에 들어가는 유일한 문. "결재는 선언을 초과할 수 없다" 판정을 구현이 소유한다 */
recordGrant(g: AuthorityGrant): Promise<void>;
removeGrant(g: AuthorityGrant): Promise<void>;
```

| | 로컬 구현 | control-ts 대응물 |
|---|---|---|
| 현행 | `installer.ts:629-668` `addGrant` — "장부에 들어가는 유일한 문. 스크립트, HTTP, CLI 가 전부 여기를 지난다". 선언 캡 판정 `installer.ts:637-656`: consumer manifest 의 `edges` 선언과 대조해 미선언 edge·캡 초과 mission/tools/components 를 fail-loud. 진입점: HTTP `POST /grants`(`api.ts:824-828`) · host 브리지 `grant`(`api.ts:215-218`) · components 자동 결재(`installer.ts:622-626`) | `EdgeService` 신청 레일 request/approve/reject (ARCHITECTURE.md §7 edge-cutover — `status{pending,active}`, pending 은 런타임 비노출). 관리평면 위임 grant 는 별도 축: `domains/grant` CapabilityGrant (ElevatedGuard 전용, 재위임 차단 — §7 capability 위임 항목) |

1. **결재 문은 하나다.** 어떤 경로(화면·CLI·스크립트·자동 결재)로 오든 같은 문을 지난다.
   *왜: 문이 둘이면 캡 판정을 안 지나는 결재가 생긴다 — 현행 코드가 이미 이 문장을
   주석으로 박아 두었다(`installer.ts:628`).*
2. **선언 캡 판정은 구현 내부 불변식이다.** 로컬은 manifest `edges` 직독으로, 원격은
   동기화된 선언 행(package_edge)으로 판정한다 — 판정 재료의 거처는 다르되 "결재 ≤ 선언"
   불변식은 계약이다. *왜: 판정을 호출부(이음새 밖)에 두면 원격 기판에서 판정 재료
   (manifest)와 판정 주체(control)가 갈라져 캡 없는 결재가 가능해진다.*
3. **결재의 승인 주체는 구현이 정한다.** 1인 기판은 소유자의 행위 자체가 승인이고,
   조직은 신청(pending) → 승인(active) 2단이다. 이음새는 "기록되었는가"만 계약한다.
4. **계약 타입이 3형을 전부 실어야 문이 하나다.** components 자동 결재
   (`recordComponentGrants`, `installer.ts:622-626`)도 `addGrant` 를 지나므로, 이사 후
   `recordGrant(g: AuthorityGrant)` 가 이 경로를 받으려면 `AuthorityGrant` 에
   `components?: boolean` 이 있어야 한다(§3.3, §8 1단계). 타입 확장 없이 이사하면
   `{components: true}` 결재가 타입 불성립이거나 components 경로만 이음새를 우회해
   "문은 하나"가 첫날부터 깨진다.

### 4.3 설치 관문 (prepare 판정 결과의 결재)

```ts
/** prepare(정적 판정·고지서)를 통과한 설치의 활성 결재. 거부는 throw — fail-loud */
approveInstall(req: {
  ref: string; version: string; digest: string;
  signed: boolean; registry: string | null;
  disclosure: unknown;      // 고지서 — prepare 가 계산한 요구 범위
}): Promise<void>;
```

| | 로컬 구현 | control-ts 대응물 |
|---|---|---|
| 현행 | 2단 관문: `prepareArtifact`(`installer.ts:224-301` — 봉인·서명 검증, 판정, 고지서까지 전부 정적, 코드 실행 0) → **사람의 동의**(동의 화면 `api.ts:144-183`, prepared 토큰 왕복 `api.ts:27-30`, confirm `api.ts:600-613`, activate `api.ts:778-791`) → `activatePrepared`(`installer.ts:310-355` — conform·빌드·장부, 여기서 처음 코드 실행). 서명 정책: `RELAY_PUBKEYS` 고정 기판은 무서명·미지 키 fail-loud(`installer.ts:244-252`) | 서명 feed 소비 `store/feedimport.service`(Ed25519 → sha256 → origin=feed·immutable 단일 안착 — ARCHITECTURE.md §1) + 라이선스(`domains/license`)·인스턴스 배치(`POST /instances/:id/upgrade`). **단일 동사 확정(2026-08-16, §9-1)** — 원격 구현이 내부에서 셋을 순차 조립한다. 계약은 "승인되었는가"만 묻는다 |

1. **동의 전에는 한 줄도 실행되지 않는다.** prepare(정적)와 activate(실행)의 분리가
   계약이고, 결재는 그 사이에 선다(`installer.ts:138-143` 머리 주석). *왜: 마켓에서 오는
   패키지는 모르는 사람의 코드다 — 결재 주체가 사람이든 조직 정책이든, 실행 전 결재라는
   순서는 스코프를 건너도 같아야 한다.*
2. **결재 주체가 갈라지는 지점이 이 동사다.** 1인 기판은 고지서를 본 사람의 동의, 조직은
   라이선스·배치·서명 정책의 판정. *왜: 마이그레이션 = 재저작이 아니라 재승인
   (convergence.md §스코프 사이 세 관계) — 같은 봉투가 다른 권위에서 다시 결재받는
   것이 이 동사의 원격 구현이다.*
3. **폴더·바인딩 결재도 같은 원칙이다.** workspace 지정과 dir 서비스 바인딩은 설치 시
   결재이고 선언을 초과할 수 없다(`installer.ts:26-37` `judgeBindings`). 이 축을
   `approveInstall` 의 인자로 접을지는 형 확정 시 함께 결정한다.

### 4.4 세션 스코프 판정

```ts
/** 실행 반쪽이 manifest 에서 계산한 선언 동사 집합을 principal 문맥으로 좁힌다.
    반환 ⊆ declared 불변식 — 이 동사는 좁히기만 하고 넓히지 못한다. 1인 기판 구현 = 항등 */
narrowSessionScope(pkg: string, agent: string, declared: string[]): Promise<string[]>;
```

| | 로컬 구현 | control-ts 대응물 |
|---|---|---|
| 현행 | `api.ts:291-303` `sessionScriptSet` — manifest `agents[].scripts` 선언(+ dispatch 위임 에이전트의 스코프 합집합)을 `manifest.ts:450-457` `agentScriptScope` 로 해석. 소비처 둘: 목록 `sessionTools`(`api.ts:308-313`)와 집행 게이트(`api.ts:368-369` `E_SCOPE`) | org 는 per-script 게이트를 폐기하고 Edge 행 단위로 접었다(ARCHITECTURE.md §0). principal 별 세션 배치·acting-as 정책이 같은 질문에 겹친다(convergence.md §채널 표) — 정확한 조립 지점(turn 도메인)은 **미확인** |

1. **목록(tools/list)과 집행(tools/call)이 같은 집합을 본다.** *왜: 목록에만 스코프를
   걸면 이름을 아는 세션이 아무 동사나 부른다 — 선언 = 캡 원칙 위반
   (`api.ts:289-290` 주석).*
2. **선언 해석은 실행 반쪽 잔류 — 계약 편입 후보는 좁히기뿐이다.** manifest
   `agents[].scripts` 해석(`sessionScriptSet`, `api.ts:291-303` → `agentScriptScope`,
   `manifest.ts:450-457`)은 순수 실행 의미론이라 이음새 뒤로 넣을 수 없다. 넣는 순간
   원격 구현의 길은 둘뿐이다 — control-ts 에 manifest 스코프 해석을 신설하거나(§6.1 과
   convergence.md 금지 규율 1 "manifest 실행 의미론 금지" 위반 — script 스코프는 신원·
   grant 장부·라이선스·배치·자격 브로커·감사 6기능 어디에도 환원되지 않는다), 전량
   허용으로 답해 선언 = 캡을 조용히 깨거나. 그래서 동사를 쪼갠다: 실행 반쪽이 선언
   집합을 계산해 `declared` 로 넘기고, 권위는 principal 문맥(조직: principal 별 replica,
   guest principal 강등)으로 **좁히기만** 한다. 1인 기판 구현은 항등이다. 편입 여부는
   **편입하지 않음으로 확정**(2026-08-16, §9-3) — 이 축 전체가 실행 반쪽 소관으로 남고,
   권위는 principal 정책으로만 관여한다. 실측상 이 동사의 소비자가 어느 기판에도 없다
   (relayos 는 per-script 게이트를 폐기하고 Edge 행 단위로 접었다). 필요해지는 날
   additive 로 추가하며, 위 시그니처는 그때를 위한 기록이다.

## 5. 동기·실패 의미론

1. **fail-loud. 판정 아니면 실패다.** 이음새의 어떤 동사도 경고·폴백·조용한 강등으로
   답하지 않는다. `null` 은 오류가 아니라 판정("자격 없음", "인가 없음", "토큰 주인
   없음")이고, 그 판정을 거부로 번역하는 것은 호출부의 의무다(`E_NO_GRANT` ·
   `E_SCOPE` · 401 — `api.ts:332,369,852`). 통신 실패·내부 오류는 throw 다 — `null` 로
   뭉개지 않는다. *왜: "없음"과 "모름"을 한 값에 실으면 원격 장애가 조용한 인가 거부로
   위장되고, 그 역도 성립한다.*
2. **판정은 요청 시점이다. 판정 캐시는 계약이 아니다.** 구현이 내부 캐시를 두더라도
   revoke·회전이 다음 소비부터 서야 한다는 관측 가능한 의미론은 불변이다. 자격은 특히
   env·전역 상주 금지(§3.2). *왜: 캐시를 계약으로 승격하면 "revoke 했는데 왜 아직
   되나"가 스펙이 된다.*
3. **오프라인: 로컬은 항상 가능, 원격은 fail-closed. 예외 없다.** 로컬 권위는 디스크와
   OS 만 본다 — 네트워크 없이 완결이다. 원격 권위는 control 에 닿지 못하면 **판정 불가 =
   거부**다. 마지막으로 성공한 판정의 재사용(grace 캐시)은 시한을 어떻게 달아도 계약
   위반이다 — revoke 직후 control 이 죽으면 회수된 grant 가 그 시한 동안 계속 통과해
   §5.2("revoke·회전이 다음 소비부터 선다")를 깬다. *왜: "control 이 죽었으니 일단
   통과"는 조용한 강등의 정의 그 자체다(CLAUDE.md 규율 2 — 경고도 폴백도 조용한 강등도
   없다, 판정만 있다). 정당한 연속성은 grace 가 아니라 §6.2 가 이미 제공한다 — 판정
   결과로 발급된 단기 토큰은 잔여 수명 동안 유효하고 이미 맺은 연결은 runner 가 직접
   쥔다. 판정은 control-ts, 트래픽은 아니다 — 판정이 안 되면 새 소비가 멈추는 것이
   맞고, 이미 맺은 연결이 멈출 이유는 없다.*

## 6. 경계 — 이 인터페이스에 절대 들어가지 않는 것

1. **실행 의미론.** 스폰·빌드·세션·하네스·채널 어댑터·트리거 발화는 실행 반쪽이다.
   권위는 "해도 되는가"만 답하고 "어떻게 하는가"에 손대지 않는다. *왜: 실행이 이음새로
   새면 control-ts 가 manifest 실행 의미론을 갖게 된다 — convergence.md 금지 규율
   1번의 위반이고, 구 scripts-engine(해석·게이트·원장 기계의 동거)의 재발이다.*
2. **트래픽 중계.** 자격은 단기 토큰으로 발급하고 연결은 runner 가 직접 맺는다. 판정
   결과(토큰·주소)가 이음새를 지나되, 바이트는 지나지 않는다. *왜: "제어 평면을 데이터
   핫패스에 올리면 deployd 의 재발이다"(convergence.md §runner의 두 반쪽). 권위가
   죽으면 새 판정이 멈춰야지 흐르던 스트림이 끊겨선 안 된다.*
3. **org 전용 어휘.** member·라이선스·principal 바인딩·배치 행·신뢰 등급 — 전부 어댑터
   구현의 내부이거나 manifest 의 org 블록·capability 옵셔널 선언의 몫이다. 이음새의 형에
   등장하는 순간 익명의 제3자 임베더 테스트 탈락이다. *왜: 한 기판의 방언이 계약에
   들어오면 모두의 문법이 된다(docs/verb-contract.md 의 meta 미지 키 원칙과 같은 결).*
4. **장기 비밀.** 이음새의 어떤 답에도 장기 비밀이 실리지 않는다(§3.2-3). 로컬 구현이
   내부적으로 장기 비밀을 vault 에 보관하는 것과, 이음새가 그것을 원격으로 내려보내는
   것은 다른 문제다 — 후자가 금지다.

## 7. 부착 계약과의 관계 — federation

1. **부착 계약 = 이 인터페이스의 원격 구현이다** (convergence.md §"OSS 선행 작업 3" 1번).
   개인 PC worker 가 조직에 붙는다는 것은: 그 runner 의 권위 백엔드가 조직 control 의
   어댑터로 바뀌고, 조직 쪽 노드 레지스트리가 그 worker 에 **신뢰 등급**을 매긴다는
   뜻이다. k3s pod 도 등록된 개인 PC 도 같은 문으로 붙는다 — k3s 는 조직이 자기 소유
   고신뢰 worker 를 찍는 방법일 뿐이다(convergence.md 불변 4).
2. **신뢰 등급은 이음새 답변의 범위를 좁힌다.** 저신뢰 worker 에는 단기 자격의 수명이
   짧아지고, 결재 범위가 좁아지고, 감사가 촘촘해진다 — 전부 어댑터 구현의 정책이지
   계약의 변경이 아니다. *왜: 등급마다 계약이 갈라지면 worker 가 계약 버전을 협상하게
   되고, 그 협상 자체가 공격 표면이다.*
3. **federation 전 3수칙** (convergence.md §순서): ① 부착 계약 공개 ② "인스턴스=pod"
   하드코딩 금지 ③ 장기 비밀 내려보내기 금지. 이 문서의 §3.2(단기 발급)·§6.4 가 ③의
   집행 지점이고, 이 계약 문서 자체가 ①의 선행물이다.

## 8. 추출 순서 — 단계와 검증 게이트

현행 코드에서 계약을 완성하는 순서. 각 단계는 앞 단계의 게이트를 통과해야 시작한다.

1. **타입 정의 — ✅ 착지(2026-08-16).** ① `AuthorityGrant` 에 `components?: boolean`
   추가 ② 확장 동사 4종 추가: `audit` · `recordGrant`/`removeGrant` · `approveInstall`
   (+`InstallApproval` 형) — `narrowSessionScope` 는 §9-3 확정으로 제외. 로컬 래퍼도 함께
   착지했다(`authority.ts` — `logLine`·`addGrant`·installer `removeGrant` 를 그대로
   감싼다; `approveInstall` 은 결재 사실의 원장 기록 — 승인 주체인 소유자 동의 관문은
   installer 에 그대로 있다).
   - 게이트 통과: `npm run typecheck` GREEN · `npm run validate` GREEN ·
     `rg "^import" runner/authority-contract.ts` 빈 결과.
2. **로컬 구현 리팩터 — ✅ 착지(2026-08-17).** 이음새 밖 직결 소비를 이음새 뒤로
   이사했다: scripts.ts 의 커넥터 자격(runScript 선발급 → `ctx.credential`), oauth.ts ·
   session.ts · relay.ts · api.ts 의 vault/`pkgToken`/`PRINCIPAL` 직소비, `/grants` 와
   host 브리지·CLI 의 `addGrant` 직결(→ `authority.recordGrant`/`removeGrant`),
   `logLine` 소비처(→ `authority.audit` — login.ts·tick.ts·session.ts·run.ts localIO).
   동작 무변경 리팩터다 — 로컬 구현이 기존 함수를 그대로 감싼다.
   - 게이트 통과: `npm run validate` + `npm run typecheck` GREEN. grep 게이트 —
     `runner/` 에서 `vaultGet|vaultSet|ledger.grants|addGrant|logLine` 의 직접 호출이
     `authority.ts`(구현)와 원 소유 모듈(vault.ts·state.ts·installer.ts) 밖에는
     **`§8-2 잔여` 주석 동반 지점**뿐이다. 잔여의 사유는 전부 동기 계약이다 — 이사가
     시그니처 연쇄를 일으키는 지점만 남긴다: build.ts(동기 설치 파이프라인의 audit),
     pack.ts(동기 pack 계약의 서명 키·audit), registry.ts(다운로드 3동사 audit —
     호출부 6곳 연쇄 대비 과대수술), run.ts `RunnerIO.credential`(스폰 전 선발급 동기
     계약). 이 잔여의 이사는 3단계 요구가 생길 때 additive 로 푼다.
3. **control-ts 어댑터.** relayos-claude 쪽에 `authority-contract.ts` 를 벤더링(무패치)하고
   control-ts 도메인 기계(AuthService·token.controller·EdgeService·audit)를 감싸는 원격
   구현을 쓴다. runner 인접 조직 코드는 이 어댑터 하나뿐이다(§1.3).
   - 게이트: **계약 적합성 테스트 한 벌을 두 구현에 돌린다** — 같은 시나리오
     (인가 있음/없음, 캡 초과 결재 거부, 토큰 위조, 자격 회전 후 즉시 반영, 오프라인
     fail-closed)가 로컬·원격에서 같은 관측 결과를 내야 한다. `conform.ts` 가 하네스
     어댑터에 하는 일을 권위 어댑터에도 하는 것이다. 익명 임베더 테스트: 어댑터가
     계약 파일 외의 runner 소스를 import 하지 않는다.

이 트랙은 전송 계약 트랙(클라이언트↔기판 SSE 수렴)과 병행하되 독립이다 — 전송 계약은
문(門)의 프레이밍을 바꾸고, 이 계약은 문 뒤의 판정을 바꾼다. 겹치는 파일(api.ts)의
충돌은 판정 호출부가 이미 `authority` 객체를 지나므로(§3 소비처) 작다.

## 9. 열린 질문 — 확정 기록 (2026-08-16)

형 확정 전에 답해야 했던 3건. 전부 확정되어 §8 1단계가 착지했다.

1. **`approveInstall` 의 control-ts 단일 대응** (§4.3) → **확정: 단일 동사.** 원격 구현이
   내부에서 셋(feed 소비 `feedimport` · 라이선스 `domains/license` · 인스턴스 배치
   upgrade)을 순차 조립한다. 계약은 "승인되었는가"만 묻고, 내부 절차의 수는 구현 사정이다
   — 쪼개면 1인 기판이 의미 없는 다단계를 흉내 내야 한다.
2. **audit append 실패의 의미론** (§4.1) → **확정: 2계열.** 결재 계열(grant 기록·회수·설치
   승인)은 원장 필수 — 실패가 본 행위를 막는다. 소비 계열(빈번 기록)은 행위를 진행하되
   실패를 fail-loud 로 표면화한다. 근거: 결재는 드물고 중요해 멈춰도 되고, 소비는 빈번해
   가용성이 우선이다 — §4.1.
3. **`narrowSessionScope` 의 계약 편입 여부** (§4.4) → **확정: 편입하지 않음.** 실측상
   소비자가 어느 기판에도 없다(relayos 는 Edge 행 단위로 접음). 필요해지는 날 additive 로
   추가한다 — §4.4.

## 10. 참조

- `runner/authority-contract.ts` — 계약 코드 반쪽 (벤더링 아티팩트)
- `runner/authority.ts` — 1인 기판 구현 `localAuthority`
- `runner/api.ts:525-526` — 이음새 배선점 ("조직 임베드는 여기 다른 구현을 꽂는다 — api 는 모른다")
- relayos-claude/docs/convergence.md — 북극성: runner의 두 반쪽 · OSS 선행 작업 3 · federation 전 3수칙
- relayos-claude/control-ts/ARCHITECTURE.md — 원격 대응물의 현행 정본 (GoTrue·token:issue·Edge 행·audit)
- docs/verb-contract.md — ctx 가 소비하는 판정(caller·credential·grant)의 동사 쪽 계약
