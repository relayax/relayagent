/*!
 * runtime.ts — assistant-ui ChatModelAdapter + 위젯 데이터 로더(신 클라이언트 계약 v1).
 *
 * Phase 1-c 재배선(relayos-claude docs/relayjs-convergence-plan.md §3): relayos 원본의
 * 구 브리지 전송(rpc/rpcStream — host.* method 어휘)과 claude CLI stream-json 리듀서를
 * chat/transport.ts 의 계약 동사(docs/client-protocol.md)와 chat/envelope-reducer.ts
 * (하네스 봉투 protocol 3 — 라이브·재생 단일 리듀서) 위로 옮겼다. 파트 모델·TurnMeta 출력
 * 형태는 구 판과 동형이라 Chat 렌더가 그대로 소비한다.
 *
 * 은퇴 목록(구 어휘 — 이 파일에서 제거된 것과 대체):
 *  - rpc/rpcStream 브리지 호출 전량(host.sessions.* · host.conversations.* · host.turns.* ·
 *    host.instances.* · host.settings.* · host.llm.*) → createTransport 의 계약 동사
 *    (turn.* · session.* · history.get · file.* · harness.* · instances.list).
 *  - stream-json Reducer(stream_event/assistant/user/result 분기·message_start 티커 추정·
 *    input_json_delta 인자 전개)와 framesToParts 리플레이 쌍 → EnvelopeReducer 단일
 *    (봉투 8종 + 수명주기 turn 이벤트, client-protocol §6). 툴 인자 실시간 전개 손실은
 *    v1 수용 판정(§6-35)이다.
 *  - subscribePush 재수출(transport EventSource 파사드) → transport push.subscribe
 *    (capability push) — 이 파일의 재수출은 소비자가 없어 은퇴.
 *  - /api/portal/nav 열거(loadInbox·loadInstances) → instances.list(§5.6, capability
 *    enumerate)의 닫힌 shape. pkg/kind 판정 어휘는 은퇴(display_name 만 나른다).
 *  - <base>/u/_attachments?access_token= 업로드 + uploadBaseFromPathname 의 /i/<id> 마운트
 *    문법 파싱 → file.upload 단일 동사(§5.4·§9-46). 마운트 문법이 이 파일에 남으면 계약
 *    위반이다(§2-6).
 *  - window.__RELAY_CONTEXT 의 org 좌표(instanceId×principal×conversation 4축 wire 키) →
 *    {base, root(, baseFor)} 좌표 주입 규약(§2-6). instanceId·conversationId 는 화면 축으로
 *    남고, wire 는 base 상대 경로와 세션 id 만 안다. principal 은 표시 전용 잔류 — wire 에
 *    싣지 않는다(org 의미는 문 뒤에서 해석, §1-2).
 *  - host.sessions.activeTurn 프로브 → history.get 의 busy/turn(§5.3-24, §9-46 흡수표).
 *  - host.instances.get/setMyLLM·getLLM(오버라이드/기본 이원 축) → harness.set(§5.5-30) +
 *    instances.list 행의 model/effort. effort 필드는 capability effort 게이트.
 *  - host.llm.models org 카탈로그(display_name·max_input_tokens) → harness.models
 *    (capability harness-models). 컨텍스트 미터 분모의 카탈로그 축은 소실 — 봉투
 *    reply.context.window 실측(envelope-reducer contextWindow)이 그 자리를 대체한다.
 *  - host.settings.chatLimits(org 전역 첨부 상한) — 계약 밖 잔류(§부록 A 말미). 클라이언트는
 *    폴백 상수로 수렴하고, 실 상한은 업로드 프로브(§5.4-26)가 바이트 전에 fail-loud 로 판정.
 *  - connectUrlFromLocation 의 /i/<inst> 파싱·/connect 딥링크·E_NO_LLM_CREDENTIAL /
 *    getLLM 사후 프로브 특화 배너 — org 표면(claude-login 잔류, 결정 D)이라 은퇴. 자격 만료
 *    감지(isLlmAuthError)는 중립 안내 문구로만 남는다.
 */
import type { ChatModelAdapter } from "@assistant-ui/react";
import {
  createTransport,
  isError,
  type Transport,
  type Result,
  type StreamHandle,
  type TurnSettled,
  type EnvelopeEvent as WireEvent,
  type InstanceEntry,
  type Attachment as WireAttachment,
} from "./transport";
import { EnvelopeReducer } from "./envelope-reducer";
import { siblingThread, displayBinding } from "./routematch";

export type RelayCtx = {
  /** 대화 스코프 base URL — §2-6 주입 좌표. 생략 시 전역 주입(__RELAY_CONTEXT.base), 그것도
   *  없으면 ""(same-origin 루트). 마운트 문법(/pkg/·/i/)을 클라이언트가 조립하면 계약 위반. */
  base?: string;
  /** 열거 동사(instances.list)의 뿌리 — 생략 시 전역 주입 root, 그것도 없으면 base. */
  root?: string;
  instanceId: string;
  /** 표시 전용 잔류(계정 메뉴 등) — 신 계약 wire 에는 싣지 않는다(신원 해석은 기판 소유). */
  principal: string;
  conversationId: string;
  title: string;
  /** 호스트(relayjs 크롬 등)가 준 패널 접기 콜백 — 있으면 위젯 헤더가 접기 버튼을 그린다. */
  onClose?: () => void;
  /** 대상 전환(대화함 — 다른 인스턴스의 대화로) — mount API 가 재마운트로 구현해 주입.
   *  없으면 대화함 행 클릭은 해당 인스턴스 채팅 문서로 이동(폴백). */
  onRetarget?: (instanceId: string, conversation: string) => void;
};

// ── 좌표 주입 (§2-6) ────────────────────────────────────────────────────────
// 호스트는 window.__RELAY_CONTEXT 에 {base, root, baseFor?} 를 주입한다. baseFor 는
// instances.list 의 id 로 base URL 을 얻는 기판 제공 함수(§5.6-32)다 — 대화함의 전 인스턴스
// fan-out 이 이것으로만 다른 인스턴스의 문을 찾는다(미주입 시 현재 인스턴스만).

type InjectedCoords = {
  base: string;
  root: string;
  baseFor: ((id: string) => unknown) | null;
  /** desk 우측 뷰 iframe 주소 해석 — 기판 마운트를 아는 호스트만 알 수 있다(§2-6). */
  viewFor: ((id: string) => unknown) | null;
  /** base 가 명시 주입됐는가 — 자동 마운트 게이트의 판정 근거. 미주입 문서에서 마운트 문법을
   *  조립하는 대신 마운트를 포기해야 하므로(§2-6) "부재"와 "빈 문자열 주입"을 구분한다. */
  declared: boolean;
};

/** 좌표 주입 2형(§2-6): ① 전역 __RELAY_CONTEXT.{base,root,baseFor,viewFor} — 기판이 서빙
 *  HTML 에 심거나 호스트 앱이 번들 로드 전에 세운다. ② 문서 요소의 data-relay-base /
 *  data-relay-root 속성 — 임베더가 마크업으로 선언한다. 전역이 속성보다 우선. */
export function injectedCoords(): InjectedCoords {
  const w = window as any;
  const c = w.__RELAY_CONTEXT || (w.relay && w.relay.context) || {};
  const attrEl = typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-relay-base]") : null;
  const base = typeof c.base === "string" ? c.base : attrEl?.getAttribute("data-relay-base") ?? "";
  const root = typeof c.root === "string" ? c.root : attrEl?.getAttribute("data-relay-root") ?? base;
  const baseFor = typeof c.baseFor === "function" ? c.baseFor : null;
  const viewFor = typeof c.viewFor === "function" ? c.viewFor : null;
  return { base, root, baseFor, viewFor, declared: typeof c.base === "string" || attrEl != null };
}

/** desk 뷰 iframe 의 주소. 주입(viewFor)이 없으면 null — 클라이언트가 /i/<id>·/pkg/<pkg> 류
 *  마운트 문법을 조립하면 계약 위반이다(§2-6). null 이면 뷰 패널 자체를 그리지 않는다. */
export function viewUrlForInstance(instanceId: string): string | null {
  const inj = injectedCoords();
  if (!inj.viewFor) return null;
  try {
    const u = inj.viewFor(instanceId);
    return typeof u === "string" && u ? u : null;
  } catch {
    return null;
  }
}

function baseOf(ctx: RelayCtx): string {
  return typeof ctx.base === "string" ? ctx.base : injectedCoords().base;
}
function rootOf(ctx: RelayCtx): string {
  if (typeof ctx.root === "string") return ctx.root;
  const inj = injectedCoords();
  return inj.root || baseOf(ctx);
}

/** 인스턴스 id → base URL. 주입 baseFor > 현재 ctx/전역 컨텍스트의 자기 인스턴스 > null(미상).
 *  null 이면 그 인스턴스의 문을 두드리지 않는다 — 마운트 문법 조립 금지(§2-6). */
function baseForInstance(instanceId: string, ctx?: RelayCtx): string | null {
  const inj = injectedCoords();
  if (inj.baseFor) {
    try {
      const b = inj.baseFor(instanceId);
      if (typeof b === "string") return b;
    } catch { /* 주입 함수 오류 — 아래 폴백 */ }
  }
  if (ctx && instanceId === ctx.instanceId) return baseOf(ctx);
  const g = getCtx();
  if (instanceId === g.instanceId) return baseOf(g);
  return null;
}

// transport 는 base×root 당 1개를 재사용한다 — 관찰 커넥션 예산(§5.2)의 단위가 transport 다.
const _transports = new Map<string, Transport>();
function transportFor(base: string, root: string): Transport {
  const key = base + "\u0000" + root;
  let t = _transports.get(key);
  if (!t) {
    t = createTransport({ base, root });
    _transports.set(key, t);
  }
  return t;
}
function wireOf(ctx: RelayCtx): Transport {
  return transportFor(baseOf(ctx), rootOf(ctx));
}

// capabilities 개막(§3-7)의 결과 캐시 — 미선언 capability 의 동사는 두드리지 않는다(§3-8).
// 실패는 캐시하지 않는다(일시 실패가 영구 침묵으로 굳으면 안 된다 — fail-loud 규율).
const _caps = new Map<string, Promise<Set<string>>>();
function capsFor(base: string, root: string): Promise<Set<string>> {
  let p = _caps.get(base);
  if (!p) {
    p = transportFor(base, root)
      .capabilities()
      .then((r) => {
        if (isError(r)) {
          _caps.delete(base);
          return new Set<string>();
        }
        return new Set<string>(r.capabilities);
      });
    _caps.set(base, p);
  }
  return p;
}
function capsOf(ctx: RelayCtx): Promise<Set<string>> {
  return capsFor(baseOf(ctx), rootOf(ctx));
}

// ── 로컬 대화 좌표 ↔ 서버 세션 (§5.3-22 — 클라이언트 로컬 id 발급 은퇴) ──────
//
// 세션 id 는 기판이 발급하는 불투명 문자열이다. 화면이 로컬에서 만드는 좌표(새 탭·sibling
// 스레드 — routematch 의 "c-<id16>"/"…~<id8>" 문법)는 **화면 축의 드래프트**로만 살고 wire 에
// 실리지 않는다: 첫 발화 직전 session.create 가 진짜 id 를 발급하고(지연 민팅), 이후 그
// 드래프트의 모든 wire 호출은 발급 id 로 번역된다. 호스트가 주입한 대화 id 는 호스트 기판이
// 아는 세션이므로 불투명 그대로 wire 에 나간다.

const LOCAL_CONV_RE = /(^c-[0-9a-f]{16}$)|(~[0-9a-f]{8}$)/;

/** 로컬 민팅 드래프트인가 — siblingThread 가 만드는 두 문법만. 그 밖의 id 는 전부 주입분. */
export function isLocalConversation(id: string): boolean {
  return LOCAL_CONV_RE.test(String(id || ""));
}

// 드래프트 → session.create 발급 id. 메모리 수명 — 새로고침 뒤에는 탭/폴백이 발급 id 를
// 직접 들고 있으므로(민팅 시 relay-session-minted 로 재바인딩 + last-session 기억) 무손실이다.
const _minted = new Map<string, string>();

function wireSessionForId(conversation: string): string | null {
  if (!isLocalConversation(conversation)) return conversation;
  return _minted.get(conversation) ?? null;
}
/** ctx 의 wire 세션 id. null = 미민팅 드래프트 — wire 에 싣지 않는다(이력·프로브는 빈 결과). */
function wireSessionOf(ctx: RelayCtx): string | null {
  return wireSessionForId(ctx.conversationId);
}

const lastSessionKey = (instanceId: string) => "relay-chat-last-session:" + (instanceId || "default");
function rememberLastSession(instanceId: string, session: string): void {
  try { localStorage.setItem(lastSessionKey(instanceId), session); } catch { /* quota */ }
}
function forgetLastSession(instanceId: string, session: string): void {
  try {
    if (localStorage.getItem(lastSessionKey(instanceId)) === session) localStorage.removeItem(lastSessionKey(instanceId));
  } catch { /* quota */ }
}

// 인스턴스당 드래프트 1개 메모 — getCtx 가 호출마다 새 좌표를 만들면 같은 화면의 두 소비자가
// 서로 다른 대화를 보게 된다.
const _seedDrafts = new Map<string, string>();

/** 대화 미주입 문서/새 탭의 시드 좌표 — 마지막 민팅 세션(연속성) > 새 로컬 드래프트(지연 민팅). */
export function seedConversation(instanceId: string): string {
  const key = instanceId || "default";
  try {
    const v = localStorage.getItem(lastSessionKey(instanceId));
    if (v) return v;
  } catch { /* localStorage 불가 문맥 — 드래프트로 */ }
  let d = _seedDrafts.get(key);
  if (!d) {
    d = siblingThread("");
    _seedDrafts.set(key, d);
  }
  return d;
}

/** 지연 민팅 — 첫 발화 직전 어댑터가 부른다. 드래프트가 아니면 그대로, 드래프트면 1회
 *  session.create 후 매핑을 기록하고 relay-session-minted 로 탭 셸에 재바인딩을 알린다. */
export async function ensureWireSession(ctx: RelayCtx): Promise<Result<{ session: string }>> {
  const id = ctx.conversationId;
  const known = wireSessionForId(id);
  if (known != null) return { session: known };
  const r = await wireOf(ctx).session.create();
  if (isError(r)) return r;
  const real = typeof r.session === "string" ? r.session : "";
  if (!real) return { error: { code: "E_NO_SESSION", message: "세션 발급 응답에 session 이 없습니다" } };
  _minted.set(id, real);
  rememberLastSession(ctx.instanceId, real);
  try {
    window.dispatchEvent(new CustomEvent("relay-session-minted", {
      detail: { instanceId: ctx.instanceId, conversation: id, session: real },
    }));
  } catch { /* ignore */ }
  return { session: real };
}

/** 민팅 통지 구독 — 탭 셸이 드래프트 좌표의 탭을 발급 id 로 재바인딩(영속 정합)하는 데 쓴다. */
export function onSessionMinted(
  fn: (d: { instanceId: string; conversation: string; session: string }) => void,
): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent).detail || {};
    const conversation = String(d.conversation || "");
    const session = String(d.session || "");
    if (conversation && session) fn({ instanceId: String(d.instanceId || ""), conversation, session });
  };
  window.addEventListener("relay-session-minted", h);
  return () => window.removeEventListener("relay-session-minted", h);
}

/**
 * getCtx — 호스트 주입 전역(__RELAY_CONTEXT)에서 컨텍스트 해석. overrides 는 mount API
 * (RelayChat.mount(el, {instanceId, conversation, …}))가 위젯 인스턴스별로 주입하는 값.
 * conversationId 미주입 폴백은 seedConversation — 구 "chat-<id>" 로컬 발급은 은퇴했다(§5.3-22):
 * 마지막 민팅 세션이 있으면 그 id(기판 발급분), 없으면 지연 민팅 드래프트다.
 */
export function getCtx(overrides?: Partial<RelayCtx>): RelayCtx {
  const w = window as any;
  const c = w.__RELAY_CONTEXT || (w.relay && w.relay.context) || {};
  const script = document.currentScript as HTMLScriptElement | null;
  const inj = injectedCoords();
  const instanceId =
    overrides?.instanceId ||
    c.instanceId || c.instance_id ||
    (script && script.getAttribute("data-relay-instance")) ||
    document.querySelector<HTMLElement>("[data-relay-instance]")?.getAttribute("data-relay-instance") || "";
  const ctx: RelayCtx = {
    base: typeof overrides?.base === "string" ? overrides.base : inj.base,
    root: typeof overrides?.root === "string" ? overrides.root : inj.root,
    instanceId,
    principal: overrides?.principal || c.principal || "local",
    // host/mount 가 라우트별 세션 분리용 conversation id 를 주입하면 그걸 사용(예: "agent-builder:test").
    // 없으면 시드 좌표(마지막 민팅 세션 > 지연 민팅 드래프트) — 로컬 "chat-<id>" 발급은 은퇴.
    conversationId:
      overrides?.conversationId || c.conversationId || c.conversation_id || seedConversation(instanceId),
    title:
      overrides?.title || c.title ||
      document.querySelector<HTMLElement>("[data-relay-title]")?.getAttribute("data-relay-title") || "",
  };
  // onClose/onRetarget 은 있을 때만 싣는다 — ctx 는 값 객체(테스트 deepEqual·직렬화)라 undefined 키를 남기지 않는다.
  if (overrides?.onClose) ctx.onClose = overrides.onClose;
  if (overrides?.onRetarget) ctx.onRetarget = overrides.onRetarget;
  return ctx;
}

// ── LLM 자격 만료(401) 안내 ────────────────────────────────────────────────
// claude 가 만료/무효 토큰을 만나면 답변 텍스트가 "Failed to authenticate. API Error: 401 …"
// 로 온다. raw 로 렌더하면 사용자가 뭘 해야 하는지 모르므로, 감지해서 중립 안내로 갈아끼운다.
// (구 /connect 딥링크 합성은 org 표면 결합이라 은퇴 — 파일 머리 은퇴 목록.)
function isLlmAuthError(text: string): boolean {
  // claude/anthropic 자격 실패의 특정 문구만 — 프롬프트가 401 을 단순 언급한 답변에 오탐하지 않게.
  return /failed to authenticate|api error:\s*401|401\s+invalid authentication/i.test(String(text || ""));
}

// isLlmNetworkError — 하네스가 LLM API 에 **닿지 못한** 연결 실패 식별(connection refused 류).
// CLI 는 연결 오류를 내부 백오프로 수분 재시도한 끝에야 포기하므로, 사용자는 몇 분 기다린 끝에
// 영어 원문을 본다(2026-08-17 조직 기판 prod 실사고 — 두 번째 구현체가 실사고로 얻은 개념을
// 계약 층으로 승격한다). **실패 확정 경로에서만 부를 것** — 정상 답변이 네트워크 오류를
// 인용(디버깅 상담)한 경우를 배너로 덮으면 안 된다.
function isLlmNetworkError(text: string): boolean {
  return /econnrefused|econnreset|etimedout|connection refused|connection error|fetch failed|socket hang up/i.test(
    String(text || ""),
  );
}

function llmAuthGuide(): string {
  return (
    "🔑 **Claude 자격이 만료되었거나 연결되어 있지 않습니다**\n\n" +
    "하네스 자격을 다시 연결한 뒤 보내주세요 — 연결 방법은 이 기판의 콘솔(또는 `relay login`)이 안내합니다."
  );
}

// llmNetworkGuide — 연결 실패 안내. 자격 미연결이면 외부 통로도 함께 닫혀 refused 로 나타날
// 수 있으므로 연결 확인을 1순위로 놓는다. llmAuthGuide 와 같은 이유로 **기판 중립**이다 —
// 마운트별 동선(/connect 딥링크 등)은 그 기판의 콘솔이 안내한다(§2-6 마운트 문법 비조립).
function llmNetworkGuide(): string {
  return (
    "🔌 **LLM API 에 연결하지 못했습니다**\n\n" +
    "기판이 API 에 닿지 못해 응답을 만들지 못했어요 — 자격이 연결되어 있지 않거나 만료됐을 수 있고, " +
    "서버의 외부 네트워크(egress) 문제일 수도 있습니다. 연결 상태를 확인한 뒤 다시 보내주세요."
  );
}

// friendlyTurnError — 배너에 실을 사람말. 벌거벗은 기계 코드가 그대로 채팅에 노출되지 않게
// 계약 소유 코드(client-protocol §5.0-10)는 문장으로, 미등록 E_ 코드는 괄호 보존 문구로 감싼다.
const TURN_ERROR_TEXT: Record<string, string> = {
  E_DISCONNECTED: "연결이 잠시 끊겼어요 — 진행 중이던 턴은 서버에서 계속 실행됩니다. 잠시 후 대화를 다시 열어 확인해 주세요.",
  E_NETWORK: "서버와 통신하지 못했어요 — 네트워크 상태를 확인하고 다시 시도해 주세요.",
  E_NO_TURN: "진행 중인 턴을 찾지 못했어요 — 대화를 다시 불러온 뒤 시도해 주세요.",
  E_PROTOCOL: "이 화면과 서버의 클라이언트 계약 세대가 달라요 — 새로고침으로 최신 화면을 받아주세요.",
};
function friendlyTurnError(text: string): string {
  const t = (text || "").trim();
  const mapped = TURN_ERROR_TEXT[t];
  if (mapped) return mapped;
  // 미등록이라도 벌거벗은 코드 꼴이면(E_FOO_BAR — 공백 없이 대문자·언더스코어) 원 코드를 괄호로
  // 보존한 최소 문구로 감싼다 — 기계 코드 단독 노출 금지.
  if (/^E_[A-Z0-9_]+$/.test(t)) return `요청 처리 중 오류가 발생했어요 (${t}). 잠시 후 다시 시도해 주세요.`;
  return t;
}

// ---------------- 파트 모델 — 정본은 envelope-reducer ----------------
// usage = 턴 전체 누적(토큰 푸터용). contextUsage = 마지막 본류 스텝의 프롬프트 크기(미터용).
// ended = 턴의 터미널 사유. model/effort = 그 턴이 실제 실행된 파라미터(봉투 reply.model).
export type TurnMeta = { usage?: any; contextUsage?: any; durationMs?: number; costUsd?: number; numTurns?: number; ended?: "ok" | "error" | "cancelled" | "cut"; model?: string; effort?: string };

export type ReplayMessage =
  | { role: "user"; content: { type: "text"; text: string }[]; createdAt?: Date; turnId?: string }
  | { role: "assistant"; content: any[]; metadata?: { custom: TurnMeta }; createdAt?: Date; turnId?: string };

// ---------------- 이력 (history.get — §5.3-24) ----------------
//
// 신 계약의 이력은 평문 원장이다({role, text, usage?, context?, model?}) — 구 판이 저장된
// stream-json 프레임에서 툴 카드까지 복원하던 리치 리플레이는 이력 동사의 닫힌 shape 밖이라
// 은퇴한다. 진행 중 턴의 리치 재생은 turn.attach 의 장부 재생(EnvelopeReducer)이 담당한다.

const HISTORY_RETRIES = 5;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type WireHistory = { messages: any[]; busy: boolean; turn?: string };

// 마운트 직후 첫 조회는 기판이 아직 덜 깬 창과 겹칠 수 있다 — E_NETWORK 만 유한 재시도한다
// (판정 에러는 재시도 대상이 아니다: 같은 요청은 같은 판정을 받는다).
async function fetchHistory(ctx: RelayCtx): Promise<Result<WireHistory>> {
  const sid = wireSessionOf(ctx);
  if (sid == null) return { messages: [], busy: false }; // 미민팅 드래프트 — 서버에 아직 없다
  let last: Result<WireHistory> = { error: { code: "E_NETWORK", message: "이력 조회 미시도" } };
  for (let attempt = 0; attempt < HISTORY_RETRIES; attempt++) {
    last = await wireOf(ctx).history.get(sid);
    if (!isError(last) || last.error.code !== "E_NETWORK") return last;
    if (attempt < HISTORY_RETRIES - 1) await sleep(400 * (attempt + 1));
  }
  return last;
}

// loadHistory returns the conversation's prior turns as assistant-ui initial messages
// (oldest-first). busy 턴의 프롬프트(마지막 user 행)에는 진행 턴 id 를 스탬프한다 —
// 재부착 경로(AttachOnMount)가 같은 프롬프트를 다시 append 할 때 이력 쪽을 걸러낼 근거.
export async function loadHistory(ctx: RelayCtx): Promise<ReplayMessage[]> {
  const r = await fetchHistory(ctx);
  if (isError(r)) return [];
  const out: ReplayMessage[] = [];
  for (const m of Array.isArray(r.messages) ? r.messages : []) {
    if (!m || typeof m.role !== "string" || typeof m.text !== "string") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.text }] });
      continue;
    }
    // bot = 완료 턴, sys = 시스템 고지(오류 등) — 둘 다 assistant 말풍선으로 그린다.
    const meta: TurnMeta = {};
    if (m.usage) meta.usage = m.usage;
    if (m.context) meta.contextUsage = m.context;
    if (typeof m.model === "string" && m.model) meta.model = m.model;
    if (m.role === "bot") meta.ended = "ok";
    out.push({ role: "assistant", content: [{ type: "text", text: m.text }], metadata: { custom: meta } });
  }
  if (r.busy && typeof r.turn === "string" && r.turn) {
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.role === "user") { m.turnId = r.turn; break; }
    }
  }
  return out;
}

// ---------------- 대화함 (내 신원의 전 인스턴스 대화 — 글로벌 독) ----------------
// 열거원 = instances.list(§5.6) × session.list(인스턴스별 base — baseFor 주입). baseFor 가
// 없으면 현재 인스턴스만 — 다른 인스턴스의 문 주소를 클라이언트가 조립하지 않는다(§2-6).

export type InboxRow = {
  instance: string;
  conversation_id: string;
  title?: string;
  last_started_at?: string;
};

export async function loadInbox(ctx: RelayCtx): Promise<InboxRow[]> {
  let ids: string[] = [];
  try {
    ids = (await loadInstances()).map((i) => i.id);
  } catch { /* 열거 실패 — 현재 인스턴스만 */ }
  if (ctx.instanceId && !ids.includes(ctx.instanceId)) ids.unshift(ctx.instanceId);
  const rows: InboxRow[] = [];
  await Promise.all(ids.map(async (id) => {
    const info = await loadConversationsOf(id, ctx.principal);
    for (const c of info.conversations) {
      rows.push({ instance: id, conversation_id: c.conversation_id, title: c.title, last_started_at: c.last_started_at });
    }
  }));
  rows.sort((a, b) => Date.parse(b.last_started_at || "") - Date.parse(a.last_started_at || "") || 0);
  return rows.slice(0, 100);
}

// ---------------- 대화 목록 (다중세션 헤더) ----------------

export type ConversationRow = { conversation_id: string; session_count?: number; last_started_at?: string; title?: string };
export type ConversationsInfo = { conversations: ConversationRow[] };

/** (instance) 대화 슬롯 목록 — session.list(§5.3-21)의 재포장. principal 인자는 구 표면
 *  호환용 잔류로 무시된다(신원 스코프는 기판이 문 뒤에서 해석).
 *  best-effort: 실패 = 빈 목록(목록 UI 만 잠김 — 대화 자체는 무관). */
export async function loadConversationsOf(instanceId: string, _principal: string): Promise<ConversationsInfo> {
  const base = baseForInstance(instanceId);
  if (base == null) return { conversations: [] };
  const r = await transportFor(base, injectedCoords().root || base).session.list();
  if (isError(r)) return { conversations: [] };
  const conversations: ConversationRow[] = (Array.isArray(r.sessions) ? r.sessions : [])
    .filter((s) => s && typeof s.session === "string" && s.session)
    .map((s) => ({
      conversation_id: s.session,
      title: typeof s.label === "string" && s.label ? s.label : undefined,
      last_started_at:
        typeof s.updated === "number" && Number.isFinite(s.updated) && s.updated > 0
          ? new Date(s.updated).toISOString()
          : undefined,
    }));
  return { conversations };
}

export async function loadConversations(ctx: RelayCtx): Promise<ConversationsInfo> {
  return loadConversationsOf(ctx.instanceId, ctx.principal);
}

/** 특정 대화의 현재 표시명(자동 제목 pop-in 용) — 없으면 "". best-effort(목록 재사용). */
export async function loadConversationTitle(
  instanceId: string,
  conversationId: string,
  principal: string,
): Promise<string> {
  const sid = wireSessionForId(conversationId);
  if (sid == null) return ""; // 미민팅 드래프트 — 서버 목록에 없다
  const info = await loadConversationsOf(instanceId, principal);
  return info.conversations.find((c) => c.conversation_id === sid)?.title || "";
}

/** 대화 표시명 설정(""=clear → 자동 라벨, §5.3-23). 성공 여부 반환 — 실패는 UI 가 알린다.
 *  미민팅 드래프트는 서버에 아직 없다 — 라벨은 로컬 표시로만 살고 true(민팅 후 자동 라벨). */
export async function renameConversation(ctx: RelayCtx, conversation: string, title: string): Promise<boolean> {
  const sid = wireSessionForId(String(conversation));
  if (sid == null) return true;
  const r = await wireOf(ctx).session.rename(sid, String(title ?? ""));
  return !isError(r);
}

/** 대화 삭제 — 추상 동사 session.remove(wire op 명은 delete, §5.3-23). 성공 여부 반환.
 *  미민팅 드래프트는 지울 서버 세션이 없다 — 탭만 닫히면 끝(true). */
export async function deleteConversation(ctx: RelayCtx, conversation: string): Promise<boolean> {
  const sid = wireSessionForId(String(conversation));
  if (sid == null) return true;
  const r = await wireOf(ctx).session.remove(sid);
  if (!isError(r)) forgetLastSession(ctx.instanceId, sid); // 시드 연속성이 죽은 세션을 가리키지 않게
  return !isError(r);
}

// ---------------- 열거 (instances.list — §5.6) ----------------

/** 열거 한 줄 — 구 표면 호환 shape. pkg 에는 닫힌 shape 의 display_name 이 실린다(패키지명·
 *  kind 판정 어휘는 은퇴 — manifest 파헤치기 금지, §5.6-32). */
export type NavInstance = { id: string; pkg: string; kind: string };

/** 이 사용자에게 보이는 인스턴스 목록 — capability enumerate 뒤(§7). best-effort: 미선언·
 *  실패 = [] (섹션이 안 뜰 뿐, 나머지 피커는 정상). */
export async function loadInstances(): Promise<NavInstance[]> {
  const g = getCtx();
  const base = baseOf(g);
  const root = rootOf(g);
  if (!(await capsFor(base, root)).has("enumerate")) return [];
  const r = await transportFor(base, root).instances.list();
  if (isError(r)) return [];
  return (Array.isArray(r.instances) ? r.instances : [])
    .filter((i) => i && typeof i.id === "string" && i.id)
    .map((i) => ({ id: i.id, pkg: typeof i.display_name === "string" ? i.display_name : "", kind: "" }));
}

// 열거 행 공유 캐시 — 아이콘처럼 실시간성이 낮은 조회용(실패는 캐시하지 않는다 — fail-loud 규율).
let _instanceRowsCache: Promise<InstanceEntry[]> | null = null;
function instanceRowsCached(): Promise<InstanceEntry[]> {
  if (_instanceRowsCache) return _instanceRowsCache;
  const p = (async (): Promise<InstanceEntry[]> => {
    const g = getCtx();
    const base = baseOf(g);
    const root = rootOf(g);
    if (!(await capsFor(base, root)).has("enumerate")) return [];
    const r = await transportFor(base, root).instances.list();
    if (isError(r)) {
      _instanceRowsCache = null;
      return [];
    }
    return Array.isArray(r.instances) ? r.instances : [];
  })();
  _instanceRowsCache = p;
  return p;
}

/** 인스턴스 아이콘 — 열거 닫힌 shape 의 기판 제공 값(§5.6-32)만. 클라이언트가
 *  /i/<id>/… 류 자산 경로를 조립하면 계약 위반이다(§2-6). 없으면 null(아이콘 생략). */
export async function iconUrlForInstance(instanceId: string): Promise<string | null> {
  if (!instanceId) return null;
  const rows = await instanceRowsCached();
  const row = rows.find((x) => x && x.id === instanceId);
  return row && typeof row.icon === "string" && row.icon ? row.icon : null;
}

/** 열거에서 자기 행 하나 — 에이전트 목록·model/effort 현재값의 단일 소스(§5.6-32·§8-42). */
async function instanceRow(ctx: RelayCtx): Promise<InstanceEntry | null> {
  const base = baseOf(ctx);
  const root = rootOf(ctx);
  if (!(await capsFor(base, root)).has("enumerate")) return null;
  const r = await transportFor(base, root).instances.list();
  if (isError(r)) return null;
  const rows = Array.isArray(r.instances) ? r.instances : [];
  return (ctx.instanceId ? rows.find((x) => x && x.id === ctx.instanceId) : rows[0]) || null;
}

// ---------------- in-flight turn re-attach (VS-Code-style rehydration) ----------------
//
// 위젯은 내비에서 재마운트된다. 진행 중 턴은 메모리(위젯 소멸)에도 완료 이력에도 없다 —
// history.get 의 busy/turn(§5.3-24)으로 프로브해서, 있으면 turn.attach 로 라이브 스트림에
// 재접속한다(장부 처음부터 재생 + 라이브, §5.1-14).

export type ActiveTurn = { turnId: string; prompt: string };

// loadActiveTurn returns the conversation's in-flight turn (or null). Best-effort: any failure
// → null (the chat just starts from history, same as before this feature).
// 폴링 동사가 아니라 1회 조회다 — 상시 감시는 push.subscribe(§5.8)의 몫이다.
export async function loadActiveTurn(ctx: RelayCtx): Promise<ActiveTurn | null> {
  const sid = wireSessionOf(ctx);
  if (sid == null) return null; // 미민팅 드래프트 — 진행 중 턴이 있을 수 없다
  const r = await wireOf(ctx).history.get(sid);
  if (isError(r) || !r.busy || typeof r.turn !== "string" || !r.turn) return null;
  const msgs = Array.isArray(r.messages) ? r.messages : [];
  let prompt = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user" && typeof m.text === "string") { prompt = m.text; break; }
  }
  return { turnId: r.turn, prompt };
}

// Single-slot attach holder — mirrors _pendingAttachments. The mount effect sets it right
// before append()ing the in-flight prompt; the adapter takes (and clears) it at the top of
// run(), routing that one turn to turn.attach instead of a new turn.send.
let _attachTurn: ActiveTurn | null = null;
export function setAttachTurn(a: ActiveTurn | null): void { _attachTurn = a; }
function takeAttachTurn(): ActiveTurn | null { const a = _attachTurn; _attachTurn = null; return a; }

/** 서버 스폰 턴 감시의 push 반쪽(§5.8) — capability push 선언 기판에서만 공유 커넥션(§5.2
 *  커넥션 예산 — transport 가 페이지당 1개로 접는다)을 구독하고, 이벤트마다 onSignal 을
 *  부른다. 정본은 기판의 이력이고 push 는 힌트다 — 신호는 history.get 재조회의 계기일 뿐.
 *  미선언 기판은 구독 없이 no-op 해지를 돌려준다 — 유휴 폴링 폴백은 금지다(§5.8). */
export function watchServerTurns(ctx: RelayCtx, onSignal: () => void): () => void {
  let unsub: (() => void) | null = null;
  let closed = false;
  void capsOf(ctx).then((caps) => {
    if (closed || !caps.has("push")) return;
    unsub = wireOf(ctx).push.subscribe({
      onEvent: () => onSignal(),
      // fail-loud(§5.8) — 침묵 강등 금지. 재접속은 transport 의 백오프가 계속 몬다.
      onError: (e) => console.error("relay-chat push:", e.error.code, e.error.message),
    });
    if (closed && unsub) { unsub(); unsub = null; }
  });
  return () => {
    closed = true;
    if (unsub) { unsub(); unsub = null; }
  };
}

// 사용자 Stop(중단)로 인터럽트한 대화를 표시한다. turn.interrupt 는 best-effort 라, 턴이
// '중지됨'으로 마감되고 idle 로 돌아온 직후에도 busy/turn 프로브가 그 죽어가는 턴을 잠깐 더
// 반환하는 레이스 창이 있다. abort 리스너가 이 표시를 **동기적으로** 심고, watch 의 첫
// 프로브가 1회 소비해 그 인터럽트 중인 턴만 건너뛴다 — 이후 프로브는 정상.
const _cancelledConvs = new Set<string>();
export function markConversationCancelled(conversationId: string): void {
  if (conversationId) _cancelledConvs.add(conversationId);
}
export function takeConversationCancelled(conversationId: string): boolean {
  if (conversationId && _cancelledConvs.has(conversationId)) { _cancelledConvs.delete(conversationId); return true; }
  return false;
}

// ---------------- model / effort (harness.set — §5.5-30) ----------------
//
// 구 판의 per-user 오버라이드/인스턴스 기본 이원 축은 은퇴 — 신 계약은 harness.set 단일 저장
// (known:false 는 경고가 아니라 판정 정보)이고, 현재값의 조회 축은 instances.list 행의
// model/effort 다(§5.6-32). effort 필드는 capability effort 게이트(§7).

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

// Fallback when the substrate doesn't report a value: claude-code's own default.
// 2026-07-31 실측(세션 jsonl assistant.effort, 플래그 없는 `claude -p`) = "high".
const CLAUDE_CODE_DEFAULT_EFFORT = "high";

// Model picker options — 하네스가 그대로 받는 model id. 열린 집합(BYO·신모델)이라 이 목록은
// 편의 프리셋일 뿐이다. 정본은 harness.models(capability harness-models) — loadModelOptions()
// 가 마운트 때 받아와 이 정적 목록을 대체한다. 여기는 카탈로그 미도달(미선언·오프라인) 폴백.
export type ModelOption = { id: string; label: string };
export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

let _modelOptions: ModelOption[] = MODEL_OPTIONS;
export function modelOptions(): ModelOption[] { return _modelOptions; }

/** "claude-opus-4-8" → "opus" (가족어 — 피커 큐레이션·별칭 해석의 축). */
function familyOf(id: string): string {
  const m = /^claude-([a-z]+)/.exec(id || "");
  return m ? m[1] : "";
}

/** id → 표시 라벨 — 카탈로그 display_name 축이 은퇴해 id 파생만 남는다("claude-" 접두 제거). */
function labelOf(id: string): string {
  return id
    .replace(/^claude-/, "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * loadModelOptions — harness.models 카탈로그로 피커 프리셋을 갱신한다. 큐레이션 = 가족
 * (fable/opus/sonnet/haiku…)별 최신 1개 — 신모델·신가족이 코드 수정 없이 피커에 나타난다.
 * capability 미선언·실패 = 폴백 유지.
 */
export async function loadModelOptions(): Promise<ModelOption[]> {
  const g = getCtx();
  const base = baseOf(g);
  const root = rootOf(g);
  if (!(await capsFor(base, root)).has("harness-models")) return _modelOptions;
  const r = await transportFor(base, root).harness.models();
  if (isError(r)) return _modelOptions;
  const ids = (Array.isArray(r.value) ? r.value : []).filter((v): v is string => typeof v === "string" && !!v);
  const byFamily = new Map<string, ModelOption>();
  for (const id of ids) { // 서버가 최신순 정렬 — 가족별 첫 행이 최신
    const fam = familyOf(id);
    if (!fam || byFamily.has(fam)) continue;
    byFamily.set(fam, { id, label: labelOf(id) });
  }
  if (byFamily.size > 0) _modelOptions = [...byFamily.values()];
  return _modelOptions;
}

// contextWindowFor — 컨텍스트 미터의 분모(토큰) 휴리스틱 폴백. 구 카탈로그(max_input_tokens)
// 축은 은퇴했고, 정본 분모는 봉투 reply.context.window 실측(envelope-reducer contextWindow)이다
// — 이 함수는 실측이 아직 없는 턴(구 이력 등)의 폴백으로만 남는다. 현행 Claude 는 Haiku(200k)
// 를 빼면 전부 1M, 미상(CLI 기본)도 현행 기본이 1M급이라 1M.
export function contextWindowFor(modelId: string): number {
  return /haiku/i.test(modelId || "") ? 200_000 : 1_000_000;
}

// loadAttTotalLimit — 첨부 총량 상한. 구 org 전역 설정(chat_limits)은 계약 밖 잔류라 조회
// 동사가 없다 — 폴백 상수로 수렴한다. 이 값은 UX 노브다: 실 상한 fail-closed 는 업로드
// 프로브(§5.4-26)가 바이트 전에 사유 문장과 함께 거절하는 것으로 이미 보장된다.
export async function loadAttTotalLimit(fallback: number): Promise<number> {
  return fallback;
}

// EffortInfo carries the current effort AND the effort that applies when unset. The slider
// parks its knob at `override || defaultEffort` so it shows the level a turn would REALLY run at.
export type EffortInfo = { override: string; defaultEffort: string };

// loadEffort — 현재값은 instances.list 자기 행의 effort. override "" = 기본.
export async function loadEffort(ctx: RelayCtx): Promise<EffortInfo> {
  const row = await instanceRow(ctx);
  return {
    override: row && typeof row.effort === "string" ? row.effort : "",
    defaultEffort: CLAUDE_CODE_DEFAULT_EFFORT,
  };
}

// setEffort persists the value ("" clears → 기본). Returns success; best-effort.
// capability effort 미선언 기판에는 두드리지 않고 실패를 돌려준다(§3-8).
export async function setEffort(ctx: RelayCtx, effort: string): Promise<boolean> {
  if (!(await capsOf(ctx)).has("effort")) return false;
  const r = await wireOf(ctx).harness.set({ effort: effort || "" });
  return !isError(r);
}

// ModelInfo — effort 와 대칭. defaultModel "" = 하네스 CLI 기본.
export type ModelInfo = { override: string; defaultModel: string };

export async function loadModel(ctx: RelayCtx): Promise<ModelInfo> {
  const row = await instanceRow(ctx);
  return {
    override: row && typeof row.model === "string" ? row.model : "",
    defaultModel: "",
  };
}

// setModel persists the value ("" clears → 기본). known:false 는 판정 정보 — 저장은 되고
// 어댑터가 거부하면 그 턴이 실패한다(§5.5-30).
export async function setModel(ctx: RelayCtx, model: string): Promise<boolean> {
  const r = await wireOf(ctx).harness.set({ model: model || "" });
  return !isError(r);
}

// ---------------- attachments (file picker / drag-drop / clipboard paste) ----------------
//
// All three input paths reduce to raw bytes — never a source filesystem path. 컴포저는 소형을
// base64 인라인으로, 대용량을 file.upload 참조(path)로 모은다. 신 wire 의 턴 첨부는 path 참조
// 단일(§5.1-12)이라, 인라인 분도 어댑터가 전송 직전에 file.upload 로 착지시킨다.
// data = 인라인 base64(소형), path = file.upload 가 돌려준 불투명 참조(§5.4-25). 정확히 한쪽만.
export type Attachment = { name: string; mime: string; data?: string; path?: string };

export type UploadedAttachment = { path: string; size: number; name: string };

/** file.upload(§5.4-25) — 본문이 곧 바이트다(프로브 선판정 + XHR 진행률은 transport 소유).
 *  실패는 throw(Error.message = 사람이 읽을 사유) — 호출부(컴포저)가 칩에 그린다. */
export async function uploadAttachment(
  file: File,
  name: string,
  onProgress: (pct: number) => void,
): Promise<UploadedAttachment> {
  const g = getCtx();
  const r = await wireOf(g).file.upload(file, {
    name,
    onProgress: (sent, total) => {
      if (total > 0) onProgress(Math.min(99, Math.round((sent / total) * 100)));
    },
  });
  if (isError(r)) throw new Error(r.error.message || r.error.code);
  onProgress(100);
  return { path: r.path, size: typeof r.size === "number" ? r.size : file.size, name: r.name || name };
}

// Sequential turns mean a single-slot holder is race-free: the composer sets the pending
// attachments immediately before append()/drain, the adapter takes (and clears) them at the
// top of run(). Kept out of the message content so textOf() stays text-only.
let _pendingAttachments: Attachment[] = [];
export function setPendingAttachments(a: Attachment[]): void { _pendingAttachments = a; }
function takePendingAttachments(): Attachment[] { const a = _pendingAttachments; _pendingAttachments = []; return a; }

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------- slash commands (agent skills/commands) ----------------
//
// The agent's slash commands come from harness.commands(§5.5-29 — 패키지 커맨드 + 하네스
// 네이티브 커맨드의 병합은 기판 몫). capability harness-commands 뒤.

export type SlashCommand = { name: string; description: string; kind: string };

// 빌트인 커맨드 — 에이전트 커맨드와 달리 앱이 제공. 실행 계층 2가지:
//   client-intercept(/clear·/effort·/model) = composer 가 전송 전 가로채 계약 동사로 끝냄(턴 0).
//   pass-through(/compact) = 프롬프트 그대로 턴으로 전달 — 하네스가 커맨드로 실행.
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "새 세션 시작 — 에이전트 컨텍스트 초기화(채팅 히스토리는 유지)", kind: "builtin" },
  { name: "compact", description: "세션 컨텍스트 압축 — 대화를 이어가며 토큰 사용량을 줄임", kind: "builtin" },
  { name: "effort", description: "추론 강도 오버라이드 — /effort low|medium|high|xhigh|max|default", kind: "builtin" },
  { name: "model", description: "모델 오버라이드 — /model fable|opus|sonnet|haiku|<model-id>|default", kind: "builtin" },
];

// /model 별칭 폴백 — 카탈로그 로드 전(또는 미도달)용 정적 매핑. 로드 후엔 resolveModelAlias
// 가 현재 프리셋(가족별 최신)에서 해석하므로 신세대 출시가 별칭에도 자동 반영된다.
const MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

/** "opus" → 현재 프리셋의 opus 가족 최신 id. 프리셋에 없으면 정적 별칭, 그것도 없으면 "". */
function resolveModelAlias(alias: string): string {
  const hit = _modelOptions.find((m) => m.id === "claude-" + alias || m.id.startsWith("claude-" + alias + "-"));
  return hit?.id || MODEL_ALIASES[alias] || "";
}

/** 인터셉트 대상 빌트인 파싱(/compact 는 제외 — 턴으로 패스스루). null=일반 메시지. */
export function parseBuiltin(text: string): { name: string; arg: string } | null {
  const m = /^\/(clear|effort|model)(?:\s+(.*))?$/.exec(text.trim());
  return m ? { name: m[1], arg: (m[2] || "").trim() } : null;
}

/** /compact 패스스루 턴 여부. 압축은 서버측 장시간·무출력 작업이라 절단 판정이 '끊김'으로
 *  오탐할 수 있다 — 실패가 아니라 정상 압축(어댑터 종결 경로가 봉합). */
export function isCompactPrompt(text: string): boolean {
  return /^\/compact(?:\s|$)/.test((text || "").trim());
}

/** 빌트인 실행 — 사용자에게 보여줄 한 줄 notice 를 돌려준다(성공/사용법/실패 공통). */
export async function executeBuiltin(ctx: RelayCtx, name: string, arg: string): Promise<string> {
  if (name === "clear") {
    // session.reset(§5.3-23) — 이력은 두고 하네스 대화 포인터만 끊는다.
    const sid = wireSessionOf(ctx);
    if (sid == null) return "✓ 새 세션을 시작합니다 — 아직 시작 전인 대화라 초기화할 컨텍스트가 없어요";
    const r = await wireOf(ctx).session.reset(sid);
    return !isError(r)
      ? "✓ 새 세션을 시작합니다 — 다음 메시지부터 컨텍스트가 초기화됩니다 (채팅 기록은 유지)"
      : "세션 초기화 실패 — 서버 연결을 확인하세요";
  }
  if (name === "effort") {
    const v = arg.toLowerCase();
    if (v === "") return "사용법: /effort low|medium|high|xhigh|max|default";
    const val = v === "default" || v === "clear" ? "" : v;
    if (val !== "" && !(EFFORT_LEVELS as readonly string[]).includes(val)) {
      return `알 수 없는 레벨 "${arg}" — low|medium|high|xhigh|max|default 중 하나를 쓰세요`;
    }
    const ok = await setEffort(ctx, val);
    notifyOverridesChanged();
    return ok ? (val ? `✓ Effort → ${val} (다음 응답부터)` : "✓ Effort → 기본값") : "Effort 저장 실패";
  }
  if (name === "model") {
    if (arg === "") return "사용법: /model fable|opus|sonnet|haiku|<model-id>|default";
    const low = arg.toLowerCase();
    const val = low === "default" || low === "clear" ? "" : resolveModelAlias(low) || arg;
    const ok = await setModel(ctx, val);
    notifyOverridesChanged();
    return ok ? (val ? `✓ Model → ${val} (다음 응답부터)` : "✓ Model → 기본값") : "Model 저장 실패";
  }
  return "";
}

// ── 턴 페이즈 신호 (스폰 내레이션) ──────────────────────────────────────────
// 전송→첫 봉투 이벤트 구간이 유일하게 "죽은 침묵"이 되는 곳 — 첫 이벤트 도착을 윈도우
// 이벤트로 중계해 RunningStatus 가 스테이지를 전환한다. 실행 모델은 봉투 reply.model 로만
// 온다(구 stream-json init 프레임의 선행 모델 통지는 봉투 어휘에 없어 은퇴).
export function onTurnPhase(fn: (phase: string, model: string) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent).detail || {};
    fn(String(d.phase || ""), String(d.model || ""));
  };
  window.addEventListener("relay-turn-phase", h);
  return () => window.removeEventListener("relay-turn-phase", h);
}
function notifyTurnPhase(phase: string, model: string): void {
  if (phase === "connected" && model) _lastConnectedModel = model;
  try { window.dispatchEvent(new CustomEvent("relay-turn-phase", { detail: { phase, model } })); } catch { /* ignore */ }
}
// 마지막으로 알려진 실행 모델 — 피커가 "진행 중인 응답은 X로 완료됩니다" 안내에 쓴다.
// (봉투에선 reply 종결에서야 확정 — 그 전이면 "" — 호출부가 직전 실효 표시값으로 폴백.)
let _lastConnectedModel = "";
export function lastConnectedModel(): string { return _lastConnectedModel; }

// ── 라이브 토큰 티커 신호 — 업로드(↑ 스텝 입력·캐시 포함)/생성(↓ 출력 누적) ──
// 봉투 usage 이벤트(어댑터가 250ms 스로틀한 실측)를 그대로 중계한다 — 클라이언트 재추정 없음.
export type TurnUsageLive = { dir: "up" | "down"; inTok: number; outTok: number };
export function onTurnUsage(fn: (u: TurnUsageLive) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d && typeof d.inTok === "number") fn(d as TurnUsageLive);
  };
  window.addEventListener("relay-turn-usage", h);
  return () => window.removeEventListener("relay-turn-usage", h);
}
function notifyTurnUsage(u: TurnUsageLive): void {
  try { window.dispatchEvent(new CustomEvent("relay-turn-usage", { detail: u })); } catch { /* ignore */ }
}

// ── 스텝 메타 (타임라인 라벨/아이콘/대상/결과 요약) ─────────────────────────
// 원시 도구명·인자 JSON 대신 "무엇을 하는지"를 한 줄로: [아이콘] [동사] · [대상] · [결과 요약].
// 툴 이름 문법의 소비는 표시 목적 분해만 — 이름 조립·권한 추론 금지(§8-41).

export type StepMeta = { icon: string; label: string; target: string; summary: string };

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function stepMeta(toolName: string, args: any, result?: unknown, isError?: boolean): StepMeta {
  const n = (toolName || "").toLowerCase();
  const a = args && typeof args === "object" ? args : {};
  let icon = "•", label = "작업";
  if (n.includes("todo")) { icon = "☰"; label = "계획"; }
  else if (n.includes("bash") || n.includes("shell") || n.includes("exec")) { icon = "⌘"; label = "실행"; }
  else if (n.includes("write") || n.includes("edit") || n.includes("create") || n.includes("update") || n.includes("save")) { icon = "✎"; label = "작성"; }
  else if (n.includes("read")) { icon = "▢"; label = "읽기"; }
  else if (n.includes("search") || n.includes("grep") || n.includes("glob") || n.includes("find") || n.includes("query")) { icon = "⌕"; label = "검색"; }
  else if (n.includes("fetch") || n.includes("web") || n.includes("http")) { icon = "⊕"; label = "웹"; }
  else if (n.includes("task") || n.includes("agent")) { icon = "❖"; label = "에이전트"; }
  else if (n.includes("skill")) { icon = "▷"; label = "스킬"; }
  else if (n.startsWith("mcp__")) { icon = "⚙"; label = toolName.split("__").slice(1).join(" · ") || toolName; }
  else if (toolName) { icon = "⚙"; label = toolName; }

  // 대상 — 인자에서 사람이 알아볼 축 하나만 (파일명 > 패턴 > 명령 > 호스트 > 질의).
  let target = "";
  if (typeof a.description === "string" && a.description) target = clip(a.description, 42);
  else if (typeof a.file_path === "string" && a.file_path) target = basename(a.file_path);
  else if (typeof a.path === "string" && a.path) target = basename(a.path);
  else if (typeof a.pattern === "string" && a.pattern) target = clip(a.pattern, 30);
  else if (typeof a.command === "string" && a.command) target = clip(a.command, 42);
  else if (typeof a.url === "string" && a.url) { try { target = new URL(a.url).host; } catch { target = clip(a.url, 30); } }
  else if (typeof a.query === "string" && a.query) target = clip(a.query, 30);
  else if (typeof a.skill === "string" && a.skill) target = a.skill;
  else if (typeof a.prompt === "string" && a.prompt) target = clip(a.prompt, 30);

  // 결과 요약 — 오류 첫 줄 / 배열·rows 는 N건 / 짧은 한 줄은 그대로 / 그 외 N줄.
  let summary = "";
  if (result !== undefined && result !== null && result !== "") {
    let text: string;
    if (typeof result === "string") text = result;
    else { try { text = JSON.stringify(result); } catch { text = String(result); } }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    if (isError) summary = clip(lines[0] || "오류", 48);
    else if (!lines.length) summary = "완료";
    else {
      let count: number | null = null;
      const t0 = text.trim();
      if (t0.startsWith("[") || t0.startsWith("{")) {
        try {
          const j = JSON.parse(t0);
          if (Array.isArray(j)) count = j.length;
          else if (j && typeof j === "object") {
            for (const k of ["rows", "items", "messages", "results", "data"]) {
              if (Array.isArray((j as any)[k])) { count = (j as any)[k].length; break; }
            }
          }
        } catch { /* not json */ }
      }
      if (count != null) summary = `${count}건`;
      else if (lines.length === 1 && lines[0].length <= 48) summary = clip(lines[0], 48);
      else summary = `${lines.length}줄`;
    }
  }
  return { icon, label, target, summary };
}

// ── AskUserQuestion 질문 카드 답변 회송 (turn.respond — §5.1-16) ─────────────
// 봉투 ask 이벤트의 id 를 어댑터가 대화별로 잡아 둔다 — 회송은 그 (turn, ask) 쌍으로 간다.
// 재마운트로 어댑터 상태를 잃었으면 history.get 의 busy/turn 으로 턴만 복원한다(ask id 는
// attach 재생의 ask 이벤트가 다시 채운다).
const _pendingAsks = new Map<string, { turn: string; ask: string }>();

/** 반환 false = 회송 실패(카드가 안내 렌더). 빈 answers = 사용자 취소(§5.1-16). */
export async function respondAsk(ctx: RelayCtx, answers: unknown): Promise<boolean> {
  const pending = _pendingAsks.get(ctx.conversationId);
  let turn = pending?.turn || "";
  if (!turn) {
    const act = await loadActiveTurn(ctx);
    turn = act?.turnId || "";
  }
  if (!turn) return false;
  const list = Array.isArray(answers) ? answers : [];
  const norm = list.map((a: any) => ({
    question: String(a?.question ?? ""),
    selected: Array.isArray(a?.selected) ? a.selected.map((s: unknown) => String(s)) : [],
  }));
  const r = await wireOf(ctx).turn.respond(turn, { ask: pending?.ask || "", answers: norm });
  if (isError(r)) return false;
  _pendingAsks.delete(ctx.conversationId);
  return true;
}

// Effort/Model 셀렉터가 빌트인 커맨드로 바뀐 오버라이드를 다시 읽게 하는 신호(윈도우 이벤트).
export function onOverridesChanged(fn: () => void): () => void {
  const h = () => fn();
  window.addEventListener("relay-overrides-changed", h);
  return () => window.removeEventListener("relay-overrides-changed", h);
}
export function notifyOverridesChanged(): void {
  try { window.dispatchEvent(new CustomEvent("relay-overrides-changed")); } catch { /* ignore */ }
}

// loadCommands returns the instance's available slash commands. Best-effort: capability
// 미선언·실패 → 빌트인만(제어 경로가 별도라 빌트인은 항상 동작).
export async function loadCommands(ctx: RelayCtx): Promise<SlashCommand[]> {
  if (!(await capsOf(ctx)).has("harness-commands")) return BUILTIN_COMMANDS;
  const r = await wireOf(ctx).harness.commands();
  if (isError(r)) return BUILTIN_COMMANDS;
  const list = Array.isArray(r.value) ? r.value : [];
  return [
    ...list
      .filter((c) => c && typeof c.name === "string" && c.name)
      .map((c) => ({ name: c.name, description: c.description || "", kind: c.tty ? "tty" : "" })),
    ...BUILTIN_COMMANDS,
  ];
}

export type AgentEntry = { name: string; default: boolean };

// loadAgents — 챗 "@" 피커용 에이전트 목록. 열거 행의 agents[] + 착지 판정 agent(서버 정본,
// §8-42 — 클라이언트 재판정 금지). best-effort: 실패/미선언 = [] (피커만 안 열림).
export async function loadAgents(ctx: RelayCtx): Promise<AgentEntry[]> {
  const row = await instanceRow(ctx);
  if (!row) return [];
  const agents = Array.isArray(row.agents) ? row.agents : [];
  return agents
    .filter((n): n is string => typeof n === "string" && !!n)
    .map((n) => ({ name: n, default: n === row.agent }));
}

/** 봉투 file 이벤트 산출물의 다운로드 URL — file.download(§5.4-27, ?dl=1 attachment 처분).
 *  path 는 불투명 참조다 — 이스케이프만 하고 해석하지 않는다(transport 소유). */
export function fileDownloadUrl(ctx: RelayCtx, path: string): string {
  return wireOf(ctx).file.url(String(path || ""), { dl: true });
}

function textOf(m: any): string {
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x: any) => x && x.type === "text").map((x: any) => x.text).join("\n");
  return "";
}

// ---------------- adapter (turn.send + turn.stream / turn.attach) ----------------
//
// run() 은 파트 스냅샷을 누적 yield 하는 async generator 다. 시작은 비블로킹 turn.send
// (§5.1-12 — 직렬화는 기판 몫), 관찰은 turn.stream, 절단 복구는 turn.attach 의 대체 접속
// (§5.2 커넥션 예산 — 신규 추가가 아니다). 종결 정본은 turn/settled(§5.2-20) — settled 없는
// EOF 를 성공으로 위장하지 않는다. 이벤트 소비는 EnvelopeReducer 단일(라이브·재생 동일).

const REATTACH_MAX = 5;

export function makeAdapter(getContext: () => RelayCtx): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const ctx = getContext();
      const t = wireOf(ctx);
      // Re-attach mode: this append was synthesized on mount to rejoin an in-flight turn, not to
      // start a new one — observe the existing turn's ledger+live (no turn.send, no attachments).
      const attach = takeAttachTurn();
      const prompt = attach ? attach.prompt : textOf(messages[messages.length - 1]);
      const attachments = attach ? [] : takePendingAttachments();

      // reducer 는 재접속마다 새로 간다(let) — attach 는 장부 전량을 재생하므로 기존 reducer 에
      // 이어 먹이면 완결 텍스트가 중복 적립된다. 신선한 reducer 로 전량 재구성하면 라이브 최초
      // 빌드와 동일 결과(envelope-reducer 헤더의 단일 리듀서 판정).
      let reducer = new EnvelopeReducer({ onUsage: (u) => notifyTurnUsage(u) });
      const newReducer = () => new EnvelopeReducer({ onUsage: (u) => notifyTurnUsage(u) });
      const queue: any[][] = [];
      let notify: (() => void) | null = null;
      let finished = false;
      let aborted = false; // 사용자 Stop — 자연 완료와 구분해 '중지됨' 터미널 상태를 남긴다.
      let connected = false;
      let knownTurnId = attach ? attach.turnId : "";
      let handle: StreamHandle | null = null;
      const wake = () => { const n = notify; notify = null; if (n) n(); };

      const onEvent = (ev: WireEvent): void => {
        // ask 회송 좌표 — respondAsk 가 (turn, ask) 쌍으로 turn.respond 를 부른다.
        if (ev.event === "ask" && typeof ev.id === "string" && ev.id) {
          _pendingAsks.set(ctx.conversationId, { turn: knownTurnId, ask: ev.id });
        }
        if (ev.event === "reply" || ev.event === "error") _pendingAsks.delete(ctx.conversationId);
        // 스폰 내레이션: 첫 이벤트 = 연결됨. 실행 모델 확정은 reply.model 에서.
        if (ev.event === "reply" && typeof ev.model === "string" && ev.model) {
          notifyTurnPhase("connected", ev.model);
        } else if (!connected && ev.event !== "turn") {
          connected = true;
          notifyTurnPhase("connected", "");
        }
        reducer.push(ev);
        queue.push(reducer.snapshot());
        wake();
      };

      // 첨부 착지 — path 참조는 그대로, 인라인 base64 는 여기서 file.upload 로 올려 참조로
      // 바꾼다(신 wire 의 턴 첨부는 불투명 path 단일, §5.1-12·§5.4-25).
      const landAttachments = async (): Promise<Result<WireAttachment[]>> => {
        const out: WireAttachment[] = [];
        for (const a of attachments) {
          if (a.path) { out.push({ path: a.path, ...(a.name ? { name: a.name } : {}) }); continue; }
          if (!a.data) continue;
          let bytes: Uint8Array;
          try { bytes = b64ToBytes(a.data); } catch {
            return { error: { code: "E_ATTACHMENT", message: "첨부를 읽지 못했어요: " + (a.name || "파일") } };
          }
          const up = await t.file.upload(new Blob([bytes as BlobPart], { type: a.mime || "application/octet-stream" }), { name: a.name || "file" });
          if (isError(up)) return up;
          out.push({ path: up.path, ...(a.name || up.name ? { name: a.name || up.name } : {}) });
        }
        return out;
      };

      // 관찰을 끝까지 몬다. 절단(E_DISCONNECTED/E_NETWORK)이면 attach 로 대체 접속해 잇고,
      // 이을 턴이 없으면(E_NO_TURN) 그 사이 종결된 것 — 종결 턴의 turn.stream 이 장부를 재생
      // 후 즉시 settled·EOF 한다(§5.1-13). 폴백 폴링은 없다.
      const replaySettledTurn = async (): Promise<Result<TurnSettled>> => {
        reducer = newReducer();
        queue.length = 0;
        handle = t.turn.stream(knownTurnId, onEvent);
        return handle.settled;
      };
      const drive = async (): Promise<{ code: string; message: string } | null> => {
        let res: Result<TurnSettled>;
        // attach 는 진행 중 턴이 이미 관측된 경로라 세션이 이미 발급/주입돼 있다 — 매핑만 통과.
        const attachSession = () => wireSessionOf(ctx) ?? ctx.conversationId;
        if (attach) {
          handle = t.turn.attach(attachSession(), onEvent);
          res = await handle.settled;
          if (isError(res) && res.error.code === "E_NO_TURN" && knownTurnId) res = await replaySettledTurn();
        } else {
          const wireAtts = await landAttachments();
          if (isError(wireAtts)) return wireAtts.error;
          // 지연 민팅(§5.3-22) — 드래프트 좌표는 첫 발화 직전에야 session.create 로 태어난다.
          const sid = await ensureWireSession(ctx);
          if (isError(sid)) return sid.error;
          // 에이전트 바인딩은 대화 좌표의 화면 축(displayBinding)에서 읽어 turn.send 인자로
          // 나른다 — 세션 id 가 불투명해진 뒤 바인딩이 wire 에 닿는 유일한 자리다(§5.1-12).
          const boundAgent = displayBinding(ctx.conversationId).agent;
          const started = await t.turn.send({
            session: sid.session,
            message: prompt,
            ...(boundAgent ? { agent: boundAgent } : {}),
            ...(wireAtts.length ? { attachments: wireAtts } : {}),
          });
          if (isError(started)) return started.error;
          knownTurnId = typeof started.turn === "string" ? started.turn : "";
          if (!knownTurnId) return { code: "E_NO_TURN", message: "턴 id 없이 개설 응답이 왔습니다" };
          handle = t.turn.stream(knownTurnId, onEvent);
          res = await handle.settled;
        }
        for (let i = 0; i < REATTACH_MAX; i++) {
          if (!isError(res) || aborted) return null;
          const code = res.error.code;
          if (code !== "E_DISCONNECTED" && code !== "E_NETWORK") return res.error;
          await sleep(400 * (i + 1)); // 점증 백오프 — 프록시/서버 블립 흡수
          if (aborted) return null;
          // 재접속 = 장부 처음부터 재생 → 신선한 reducer 로 중복 적립 방지. 빈 스냅샷은 밀지
          // 않는다 — 재생이 채울 때까지 소비자는 직전 부분내용을 유지한다(깜빡임 없음).
          reducer = newReducer();
          queue.length = 0;
          handle = t.turn.attach(attachSession(), onEvent);
          res = await handle.settled;
          if (isError(res) && res.error.code === "E_NO_TURN" && knownTurnId) res = await replaySettledTurn();
        }
        return isError(res) ? res.error : null;
      };

      if (abortSignal) abortSignal.addEventListener("abort", () => {
        finished = true; wake();
        // assistant-ui 는 abort 이유를 구분한다: 컴포넌트 언마운트(세션 전환·뷰 파괴) 정리는
        // detach=true, 사용자 Stop(cancelRun)은 detach=false. 언마운트로 인한 abort 에서 서버
        // 진행 턴을 interrupt 하면 돌아왔을 때 재부착할 턴이 사라진다 — 관찰만 닫고 살려둔다.
        const isDetach = !!((abortSignal as any).reason && (abortSignal as any).reason.detach === true);
        if (isDetach) { handle?.close(); return; }
        aborted = true; // 사용자 Stop 만 '중지됨' 터미널로 남긴다.
        // 동기 표시 — interrupt 레이스로 감시가 이 좀비 턴을 재부착(=프롬프트 재전송)하지 않도록
        // 반드시 async interrupt 앞에서 심는다.
        markConversationCancelled(ctx.conversationId);
        void (async () => {
          try {
            let tid = knownTurnId;
            if (!tid) tid = (await loadActiveTurn(ctx))?.turnId || "";
            if (tid) await t.turn.interrupt(tid); // best-effort(§5.1-15)
          } catch { /* best-effort */ }
        })();
        handle?.close();
      });

      // 홀더 객체 — 제너레이터 본문의 흐름 분석이 콜백 대입을 못 보므로 프로퍼티로 나른다.
      const outcome: { error: { code: string; message: string } | null } = { error: null };
      drive()
        .then((e) => { outcome.error = e; })
        .catch((e: any) => {
          outcome.error = { code: String(e?.code || "E_NETWORK"), message: String(e?.message || e || "턴 실행 실패") };
        })
        .finally(() => { finished = true; wake(); });

      yield { content: [], status: { type: "running" } };
      while (true) {
        while (queue.length) yield { content: queue.shift()!, status: { type: "running" } };
        if (finished) break;
        await new Promise<void>((r) => {
          notify = r;
          // 레이스 가드: if(finished) 체크와 대기자 등록 사이에 종료/이벤트 신호가 도착하면
          // wake()는 notify=null이라 유실된다 → 제너레이터가 영영 멈춰 스레드가 running에 묶인다.
          // 즉시 재확인해 메운다.
          if (finished || queue.length) { notify = null; r(); }
        });
      }
      const meta = { custom: { ...reducer.meta } as TurnMeta };
      const parts = reducer.snapshot();
      const driveError = outcome.error;
      if (driveError && !aborted) {
        // Render the failure IN the chat rather than throwing — a thrown run surfaces as an
        // "Uncaught (in promise)" and a broken thread. Keep any partial content.
        const cutClass = driveError.code === "E_DISCONNECTED" || driveError.code === "E_NETWORK";
        // /compact 는 서버측 무출력 압축 — 절단 판정이 오탐할 수 있지만 압축은 정상 완료돼
        // 다음 턴이 이어간다 → '압축 완료'로 봉합.
        if (isCompactPrompt(prompt) && cutClass) {
          meta.custom.ended = "ok";
          if (parts.length === 0) parts.push({ type: "text", text: "🗜️ 컨텍스트를 압축했어요 — 이어서 대화하세요." });
          yield { content: parts, status: { type: "complete" }, metadata: meta };
          return;
        }
        meta.custom.ended = cutClass ? "cut" : "error";
        const msg = friendlyTurnError(driveError.message || driveError.code);
        parts.push({ type: "text", text: (parts.length ? "\n\n" : "") + "⚠️ " + msg });
        yield { content: parts, status: { type: "incomplete", reason: "error" }, metadata: meta };
        return;
      }
      if (!driveError && meta.custom.ended === "error") {
        // 봉투 error 이벤트로 종결된 턴 — 사유는 리듀서가 meta.error 에 보관했다.
        const raw = (reducer.meta as { error?: string }).error || "턴 실행 실패";
        const base = friendlyTurnError(String(raw).replace(/^turn failed:\s*ERROR:\s*/i, "").trim());
        // 자격(401) → 연결(refused) 순으로 분류한다. 여기는 실패 확정 경로라 오탐이 없다.
        const guide = isLlmAuthError(raw) ? llmAuthGuide() : isLlmNetworkError(raw) ? llmNetworkGuide() : "";
        const msg = guide ? base + "\n\n" + guide : base;
        parts.push({ type: "text", text: (parts.length ? "\n\n" : "") + "⚠️ " + msg });
        yield { content: parts, status: { type: "incomplete", reason: "error" }, metadata: meta };
        return;
      }
      // LLM 자격 만료(401)가 정상 답변 텍스트로 온 경우 — raw 대신 안내를 덧붙이고 error 마감.
      {
        const seen = parts.map((p: any) => (p?.type === "text" ? p.text : "")).join("\n");
        if (isLlmAuthError(seen)) {
          parts.push({ type: "text", text: (parts.length ? "\n\n" : "") + llmAuthGuide() });
          meta.custom.ended = "error";
          yield { content: parts, status: { type: "incomplete", reason: "error" }, metadata: meta };
          return;
        }
      }
      // 사용자 Stop 이 먼저 걸렸고 settled 를 못 받았으면 '중지됨' — settled 를 이미 받았으면
      // 완료로 둔다(멈추기 직전에 끝난 경우).
      if (aborted && !reducer.settled) {
        meta.custom.ended = "cancelled";
        yield { content: parts, status: { type: "incomplete", reason: "cancelled" }, metadata: meta };
        return;
      }
      if (!meta.custom.ended) meta.custom.ended = "ok";
      yield { content: parts, status: { type: "complete" }, metadata: meta };
    },
  };
}
