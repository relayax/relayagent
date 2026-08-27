/*!
 * transport.ts — 신 클라이언트 계약(docs/client-protocol.md, protocol 1)의 wire 전송층.
 *
 * Phase 1-b 재작성(relayos-claude docs/relayjs-convergence-plan.md §3): relayos 원본
 * (deployd /api 파사드 + 브리지 method 명 어휘)을 계약 동사 표면으로 전면 교체했다.
 * 소비자는 신 SDK(src/client.ts)와 위젯 런타임(chat/runtime.ts)이다. 구 wire·구 위젯은
 * 원자 컷에서 은퇴했다 — 이 전송층이 기판과 말하는 유일한 어휘다.
 *
 * 계약 근거(조항 좌표는 전부 client-protocol.md):
 *  - 좌표는 {base, root} 주입(§2-6). 마운트 문법(/pkg/·/i/)·X-Relay-Instance 헤더는
 *    클라이언트 계약이 아니다 — 이 파일에 등장하면 위반.
 *  - 인증은 기판 소유(§2-5) — fetch 래퍼 옵션으로 주입, 기본은 전역 fetch(no-op).
 *  - no-throw 봉투(§5.0-9·10) — 모든 동사는 절대 throw 하지 않고 실패를
 *    {error:{code,message}} 로 돌려준다. error 없는/JSON 아닌 본문은 E_HTTP_<status> 합성.
 *    계약 소유 코드는 넷: E_PROTOCOL·E_DISCONNECTED·E_NO_TURN·E_NETWORK.
 *  - SSE(§5.2) — data: JSON 한 덩이 = 봉투 이벤트 한 개. event:/id:/retry:/하트비트 주석은
 *    SSEParser(chat/src/sse.ts, Phase 0-a 상륙분)가 버린다. 종결 정본은
 *    turn/settled(§5.2-20·§6-36) — settled 없는 EOF 는 E_DISCONNECTED(가짜완료 금지).
 *  - 커넥션 예산(§5.2) — push 는 페이지당 공유 커넥션 1개(백오프 재접속 + document.hidden
 *    시 반납). 관찰은 기판이 capability observe 를 선언하면 **커넥션 한 줄기**로 다중화되고
 *    (§5.2-20-a), 아니면 세션마다 직접 열되 같은 세션의 이전 관찰을 대체하고 인스턴스당
 *    OBSERVE_MAX 로 접는다. 어느 길이든 소비자의 핸들 계약은 같다.
 *  - push 실패는 fail-loud(§5.8) — dead 래치 금지. 실패마다 onError 로 표면화하고,
 *    구독자가 남아 있는 한 백오프로 재시도한다.
 *  - 이벤트 어휘는 하네스 봉투 protocol 3 재사용(§6-35, harness-protocol.md:55-68) —
 *    재성형 층 없음. 미지의 event 값은 불투명 진행으로 흘린다(§6-37).
 *
 * 은퇴 목록(구 relayos wire — client-protocol §9-46 처분표의 집행):
 *  - planHttpCall 매핑표·HttpPlan — 브리지 method 명 어휘(host.sessions.* · host.turns.* ·
 *    host.conversations.* · host.instances.* · host.settings.* · host.llm.*) 전부.
 *  - instanceScopeOf·scalarQuery·X-Relay-Instance 헤더 — base URL 주입으로 강등(§2-6).
 *  - reshapeSSEData·decodeSSEData 재성형 층({type:"result"} 터미널 후보·{data:<line>} 래핑 —
 *    claude stream-json/브리지 rpc_event 어휘) — 신 계약은 봉투 이벤트를 그대로 싣는다.
 *  - parseErrorBody 의 E_UPSTREAM 중첩 언랩 — deployd/control 봉투 결합.
 *  - fetchWithSessionRetry 의존(../transport) — 세션 갱신은 기판 소유(§2-5), 필요한 기판이
 *    fetch 훅으로 주입한다.
 *  - httpRpc/httpRpcStream/rpc/rpcStream — method 문자열 단일 문 대신 계약 동사별 함수.
 *  - EventSource 기반 subscribePush·eventsUrl — fetch SSE 공유 커넥션 + fail-loud 로 대체.
 */

import { SSEParser } from "../sse";

/** 이 클라이언트가 말하는 계약 버전(§3-7 · §9-47-3). */
export const PROTOCOL_VERSION = 1;

// ── no-throw 봉투 (§5.0) ─────────────────────────────────────────────────────

export type ErrorEnvelope = { error: { code: string; message: string } };
export type Result<T> = T | ErrorEnvelope;

export function isError(v: unknown): v is ErrorEnvelope {
  const e = (v as ErrorEnvelope | null | undefined)?.error;
  return !!e && typeof e === "object" && typeof e.code === "string";
}

const err = (code: string, message: string): ErrorEnvelope => ({ error: { code, message } });

// ── 이벤트 어휘 (§6 — 봉투 protocol 3 + 수명주기 turn 이벤트) ────────────────

/** SSE data 한 덩이 = 봉투 이벤트 한 개. 필드 정본은 harness-protocol.md:55-68. */
export type EnvelopeEvent = { event: string } & Record<string, unknown>;
export type OnEvent = (ev: EnvelopeEvent) => void;

/** turn/settled(§6-36)의 판정 결과 — 스트림 관찰의 정상 종결. */
export type TurnSettled = { turn: string; ok: boolean };

/**
 * 턴 관찰 핸들. settled 는 절대 reject 하지 않는다 —
 * settled 없는 EOF·절단·로컬 close 는 E_DISCONNECTED 봉투로 resolve(§5.2-20).
 */
export type StreamHandle = { settled: Promise<Result<TurnSettled>>; close(): void };

/** 절단(§5.2-20) 뒤 attach 로 잇는 유한 재시도의 상한. 관찰을 모는 소비자가 둘이고(SDK 의
 *  client.observe · 위젯의 runtime.drive) 둘은 같은 예산을 써야 한다 — 각자 상수를 두면
 *  한쪽만 고쳐도 아무도 모르게 갈린다. 예산의 주인은 관찰을 여는 층, 즉 transport 다 */
export const REATTACH_MAX = 5;

/** 인스턴스(transport)당 동시 관찰 상한. 브라우저 HTTP/1.1 origin 커넥션 예산 6 에서 push 공유
 *  커넥션 1 을 빼고 unary fetch 몫 2 를 남긴 값(§5.2 — relayos 실사고: 탭 5개 SSE 상시 점유 →
 *  fetch 기아). 탭 셸이 pane 을 전부 살려 두므로 진행 턴 수만큼 관찰이 열린다 — 이 상한이 예산이다. */
export const OBSERVE_MAX = 3;

// ── 동사 응답 shape (§5) ─────────────────────────────────────────────────────

/** §7 닫힌 어휘 — 새 capability 는 계약 문서 개정이다. */
export type Capability =
  | "push"
  | "state"
  | "enumerate"
  | "harness-info"
  | "harness-models"
  | "harness-commands"
  | "harness-variants"
  | "effort"
  | "upload-progress"
  | "observe";

export type Capabilities = { protocol: number; capabilities: Capability[] };

export type TurnStarted = { turn: string; session: string };

export type Attachment = { path: string; name?: string };

export type TurnSendRequest = {
  session: string;
  message: string;
  agent?: string;
  /** path 는 file.upload 가 돌려준 불투명 참조(§5.4-25) — 조립·검사 금지. */
  attachments?: Attachment[];
  /** 화면 맥락 서문 — 합성은 기판 몫, 이력에는 원문만 남는다(§5.1-12). */
  scene?: string;
};

export type SessionEntry = { session: string; label: string; updated: number; archived: boolean; pinned: boolean;
  /** §5.3-21 additive — 이 대화의 정체성(위임 세션 등): 에이전트와 작업 대상. 없으면 착지 */
  agent?: string; param?: string;
  /** 작업 사본 위 세션 — 고친 판을 적용 전에 써보는 대화 */
  draft?: boolean };

/** §5.3-22 additive — 민팅 시 대화 바인딩. param 은 agent 없이 설 수 없다(기판 판정).
 *  draft = 작업 사본 위에 민팅(기판이 그 나무로 세션을 세운다) */
export type SessionCreateRequest = { agent?: string; param?: string; draft?: boolean };

export type HistoryMessage = {
  role: "user" | "bot" | "sys";
  text: string;
  files?: unknown;
  usage?: Record<string, unknown>;
  context?: Record<string, unknown>;
  model?: string;
};

export type History = { messages: HistoryMessage[]; busy: boolean; turn?: string };

export type UploadResult = { path: string; size: number; name: string };
export type UploadBytes = Blob | ArrayBuffer | ArrayBufferView;
export type UploadOptions = {
  name: string;
  /** 지정 시 XHR 경로로 전송해 진행 이벤트를 받는다(§5.4-28 — 진행률은 클라이언트 소관). */
  onProgress?: (sent: number, total: number) => void;
};

export type HarnessInfo = {
  ok: boolean;
  value: { name: string; provider: string; protocol: number; verbs: string[]; capabilities: string[] };
};
export type HarnessModels = { ok: boolean; value: string[] };
export type HarnessCommands = { ok: boolean; value: { name: string; description?: string; tty?: boolean }[] };
/** {harness, model} 을 함께 실으면 전환 뒤 그 하네스의 모델로 앉는다(기판이 순서를 지킨다). */
export type HarnessSetRequest = { model?: string; effort?: string; harness?: string };
/** §5.5-30 — 기판은 해제("" 저장)를 null 로 되돌려주고, known 은 판정 불가(카탈로그 불달)면 null. */
export type HarnessSetResult = { ok: boolean; model: string | null; effort: string | null; harness?: string | null;
  known: boolean | null;
  /** §5.5-30-a — {harness} 를 실은 요청에만. 전환 자체는 성공하고, ok:false 는 다음 턴 실패 예고다. */
  ready?: { ok: boolean; note: string } };
export type HarnessVariant = { name: string; provider?: string };
export type HarnessVariants = { ok: boolean; value: { active: string | null; variants: HarnessVariant[] } };

export type InstanceEntry = {
  id: string;
  display_name: string;
  icon?: string;
  /** 착지 에이전트의 인사말 — 서버 판정(agents[].greeting) */
  greeting?: string;
  agents: string[];
  /** 착지 에이전트 판정 결과 — 서버 정본(§8-42), 클라이언트 재구현 금지. */
  agent: string | null;
  model?: string;
  effort?: string;
};

export type AskAnswer = { question: string; selected: string[] };
export type RespondRequest = { ask: string; answers: AskAnswer[] };

export type PushSubscription = {
  onEvent: OnEvent;
  /** fail-loud(§5.8) — 접속 실패·절단마다 호출된다. 재시도는 transport 가 계속한다. */
  onError: (e: ErrorEnvelope) => void;
};

// ── 옵션 — 좌표 주입 + 인증 훅 (§2) ──────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TransportOptions = {
  /** 대화 스코프(패키지/인스턴스 하나)의 뿌리 — §5 의 모든 스코프 동사가 이 아래 산다. */
  base: string;
  /** 문의 뿌리 — 열거 동사(instances.list, §5.6)가 여기 산다. */
  root: string;
  /**
   * 인증 주입 훅(§2-5): 자격 운반·갱신이 필요한 기판이 fetch 래퍼를 꽂는다.
   * 기본은 전역 fetch — loopback 무인증 기판은 아무것도 안 꽂는다(no-op).
   * 단 XHR 업로드(onProgress 경로)는 이 훅을 타지 않는다 — 쿠키 자동 운반만.
   */
  fetch?: FetchLike;
};

// ── 팩토리 ───────────────────────────────────────────────────────────────────

export function createTransport(opts: TransportOptions) {
  const base = opts.base.replace(/\/+$/, "");
  const root = opts.root.replace(/\/+$/, "");
  const fetchFn: FetchLike =
    opts.fetch ?? ((input, init) => fetch(input, init));

  // 불투명 참조를 URL 에 싣기 위한 이스케이프 — 의미 해석이 아니다(§5.4-25 · §8-40).
  const escOpaque = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

  const envelopeOfText = (status: number, text: string): ErrorEnvelope => {
    try {
      const j = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      const e = j?.error;
      if (e && typeof e.code === "string") {
        return { error: { code: e.code, message: typeof e.message === "string" ? e.message : "" } };
      }
    } catch { /* JSON 아님 — 아래 합성 */ }
    return err("E_HTTP_" + status, text.trim());
  };

  const envelopeOf = async (res: Response): Promise<ErrorEnvelope> => {
    let text = "";
    try { text = await res.text(); } catch { /* 본문 없이도 상태코드로 합성 */ }
    return envelopeOfText(res.status, text);
  };

  /** unary 호출 — no-throw(§5.0-9). 2xx 비-JSON 본문도 E_HTTP_<status> 로 합성한다. */
  const call = async <T>(url: string, init?: RequestInit): Promise<Result<T>> => {
    let res: Response;
    try {
      res = await fetchFn(url, { credentials: "same-origin", ...init });
    } catch (e) {
      return err("E_NETWORK", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) return envelopeOf(res);
    let text = "";
    try { text = await res.text(); } catch { return err("E_NETWORK", "응답 본문 수신 실패"); }
    try { return JSON.parse(text) as T; } catch { return err("E_HTTP_" + res.status, "JSON 아닌 응답 본문"); }
  };

  const get = <T>(url: string): Promise<Result<T>> => call<T>(url);
  const post = <T>(url: string, body: unknown): Promise<Result<T>> =>
    call<T>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // ── 개막 캐시 — 관찰이 어느 길로 갈지(capability observe) transport 스스로 알아야 한다 ────

  const fetchCapabilities = async (): Promise<Result<Capabilities>> => {
    const r = await get<Capabilities>(base + "/capabilities");
    if (isError(r)) {
      if (r.error.code === "E_HTTP_404") {
        return err("E_PROTOCOL", "이 기판은 클라이언트 계약 v" + PROTOCOL_VERSION + " 이전 세대입니다(capabilities 부재).");
      }
      return r;
    }
    if (r.protocol !== PROTOCOL_VERSION) {
      return err("E_PROTOCOL", "계약 버전 불일치: 기판 " + String(r.protocol) + " ≠ 클라이언트 " + PROTOCOL_VERSION);
    }
    return r;
  };
  let capsCache: Promise<Result<Capabilities>> | null = null;
  /** 매 호출이 기판에 다시 묻는다(하네스 전환 뒤 capability 집합이 바뀐다) — 성공값만 캐시에 남는다. */
  const loadCaps = (): Promise<Result<Capabilities>> => {
    const p = fetchCapabilities();
    capsCache = p;
    void p.then((r) => { if (isError(r) && capsCache === p) capsCache = null; });
    return p;
  };
  const muxSupported = async (): Promise<boolean> => {
    const r = await (capsCache ?? loadCaps());
    return !isError(r) && Array.isArray(r.capabilities) && r.capabilities.includes("observe");
  };

  // ── 직접 관찰 (§5.2 — observe 미선언 기판) ─────────────────────────────────

  /** 관찰 하나. fetch 는 start() 가 연다(상한 대기 때문에 생성과 개시가 갈린다). onDone 은
   *  슬롯 반납 신호 — fetch 가 실제로 끝났을 때, 또는 열리기 전에 닫혔을 때 정확히 한 번. */
  type Observation = { settled: Promise<Result<TurnSettled>>; start(): void; close(reason?: string): void };

  const openObservation = (url: string, onEvent: OnEvent, onDone: () => void): Observation => {
    const ctrl = new AbortController();
    let finish!: (r: Result<TurnSettled>) => void;
    let done = false;
    const settled = new Promise<Result<TurnSettled>>((resolve) => {
      finish = (r) => { if (!done) { done = true; resolve(r); } };
    });
    let started = false;
    let released = false;
    const release = (): void => { if (!released) { released = true; onDone(); } };

    const consume = (msg: string): void => {
      let ev: unknown;
      try { ev = JSON.parse(msg); } catch { return; } // data = JSON 한 덩이(§5.2-18) — 아닌 라인은 버린다
      if (!ev || typeof ev !== "object" || typeof (ev as { event?: unknown }).event !== "string") return;
      const e = ev as EnvelopeEvent;
      try { onEvent(e); } catch { /* 소비자 오류가 스트림을 죽이지 않게 */ }
      if (e.event === "turn" && e.status === "settled") {
        finish({ turn: typeof e.turn === "string" ? e.turn : "", ok: e.ok === true });
      }
    };

    const start = (): void => {
      if (started || ctrl.signal.aborted) return;
      started = true;
      (async () => {
        let res: Response;
        try {
          res = await fetchFn(url, {
            method: "GET",
            credentials: "same-origin",
            headers: { accept: "text/event-stream" },
            signal: ctrl.signal,
          });
        } catch (e) {
          finish(ctrl.signal.aborted
            ? err("E_DISCONNECTED", "관찰을 클라이언트가 닫음")
            : err("E_NETWORK", e instanceof Error ? e.message : String(e)));
          return;
        }
        if (!res.ok) { finish(await envelopeOf(res)); return; } // E_NO_TURN(§5.1-14) 도 이 경로
        if (!res.body) { finish(err("E_DISCONNECTED", "SSE 응답에 body 없음")); return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const parser = new SSEParser();
        try {
          for (;;) {
            const { done: eof, value } = await reader.read();
            if (eof) break;
            for (const msg of parser.feed(dec.decode(value, { stream: true }))) consume(msg);
          }
          const rest = parser.flush();
          if (rest != null) consume(rest);
        } catch { /* 절단 — 아래 판정으로 귀결 */ }
        // settled 를 이미 받았으면 no-op(래치). 아니면 가짜완료 금지 판정(§5.2-20).
        finish(err(
          "E_DISCONNECTED",
          "연결이 끊겼어요 — 진행 중이던 턴은 서버에서 계속 실행됩니다. turn.attach 로 재접속하세요.",
        ));
      })().finally(release);
    };

    return {
      settled,
      start,
      close: (reason?: string) => {
        finish(err("E_DISCONNECTED", reason ?? "관찰을 클라이언트가 닫음"));
        ctrl.abort();
        if (!started) release(); // 열리기 전에 닫힘 — 끝날 fetch 가 없으니 여기서 반납한다
      },
    };
  };

  // 커넥션 예산(§5.2): 관찰의 단위는 세션이다 — stream/attach 는 같은 세션의 이전 관찰만 대체한다.
  // 전역 슬롯 하나로 접으면 pane 마다 자기 세션을 관찰하는 탭 셸에서 두 세션이 서로의 관찰을
  // 번갈아 닫고, 재접속이 그 순환을 REATTACH_MAX 까지 돌린다(2026-08-27 "관찰을 클라이언트가 닫음").
  // 인스턴스당 동시 관찰은 OBSERVE_MAX: 초과분의 attach 는 슬롯이 비면 순서대로 열리고, 새 턴의
  // stream 은 가장 오래 열린 관찰을 양보시킨다. 양보된 쪽의 복구는 attach 라 대기열에 서므로
  // 양보가 양보를 부르지 않는다.
  const observations = new Map<string, Observation>(); // session → 그 세션의 관찰(열림 또는 대기)
  const opened: Observation[] = []; // 열린 순서 — 양보 후보는 맨 앞
  const waiting: Observation[] = [];
  const admit = (): void => {
    while (opened.length < OBSERVE_MAX && waiting.length) {
      const o = waiting.shift()!;
      opened.push(o);
      o.start();
    }
  };
  const directObserve = (session: string, url: string, onEvent: OnEvent, mode: "stream" | "attach"): StreamHandle => {
    observations.get(session)?.close();
    const h: Observation = openObservation(url, onEvent, () => {
      if (observations.get(session) === h) observations.delete(session);
      const oi = opened.indexOf(h);
      if (oi >= 0) opened.splice(oi, 1);
      const wi = waiting.indexOf(h);
      if (wi >= 0) waiting.splice(wi, 1);
      admit();
    });
    observations.set(session, h);
    if (mode === "stream" && opened.length >= OBSERVE_MAX) {
      waiting.unshift(h);
      opened[0].close("관찰 슬롯을 새 턴에 양보 — turn.attach 로 재접속하세요.");
    } else {
      waiting.push(h);
    }
    admit();
    return h;
  };

  // ── 관찰 다중화 (§5.2-20-a, capability observe) — 세션 몇 개를 보든 SSE 한 줄기 ──────
  //
  // 줄기: GET {base}/observe?id=<관찰자 id>. 구독 편집: POST {base}/observe/<id>/sessions {add,remove}.
  // 줄기의 이벤트마다 turn·session 이 덧붙어 오고, observe 제어 이벤트(ready·session·turn)가
  // 관찰 창의 좌표를 알린다. 핸들은 세션 안의 턴 하나에 묶인다 — attach 는 창의 첫 턴, stream 은
  // 그 턴. 창 밖의 턴(이미 종결)은 직접 stream 으로 장부를 재생한다(§5.1-13). 늦게 묶인 핸들은
  // 줄기가 이미 받아 둔 그 턴의 줄을 먼저 받는다 — 서버 재생을 다시 청하지 않는다.
  // 줄기가 끊기면 모든 핸들이 절단(§5.2-20)으로 판정되고, 소비자의 재접속이 새 줄기를 연다.

  type MuxWant = { kind: "stream"; turn: string } | { kind: "attach" };
  type MuxHandle = {
    session: string;
    want: MuxWant;
    turn: string | null;
    onEvent: OnEvent;
    finish: (r: Result<TurnSettled>) => void;
    done: boolean;
    fallback: StreamHandle | null;
  };
  type MuxSession = { handles: Set<MuxHandle>; turns: string[] | null; ledger: Map<string, EnvelopeEvent[]> };
  type Mux = { id: string; ctrl: AbortController; ready: Promise<boolean>; sessions: Map<string, MuxSession>; dead: boolean };
  let mux: Mux | null = null;

  const muxPost = async (m: Mux, body: { add?: string[]; remove?: string[] }): Promise<boolean> => {
    if (!(await m.ready) || m.dead) return false;
    try {
      const res = await fetchFn(base + "/observe/" + encodeURIComponent(m.id) + "/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const muxClose = (m: Mux): void => {
    if (m.dead) return;
    m.dead = true;
    if (mux === m) mux = null;
    m.ctrl.abort();
  };

  /** 핸들 종결 + 세션 살림 — 핸들이 없어진 세션은 구독을 걷고, 세션이 없어진 줄기는 닫는다. */
  const muxFinish = (m: Mux, h: MuxHandle, r: Result<TurnSettled>): void => {
    if (h.done) return;
    h.done = true;
    h.fallback?.close();
    h.finish(r);
    const s = m.sessions.get(h.session);
    if (!s || !s.handles.delete(h) || s.handles.size) return;
    m.sessions.delete(h.session);
    if (m.sessions.size) void muxPost(m, { remove: [h.session] });
    else muxClose(m);
  };

  const muxDied = (m: Mux, why: string): void => {
    if (m.dead) return;
    muxClose(m);
    for (const s of [...m.sessions.values()]) {
      for (const h of [...s.handles]) {
        if (h.done) continue;
        h.done = true;
        h.fallback?.close();
        h.finish(err("E_DISCONNECTED", why));
      }
    }
    m.sessions.clear();
  };

  const muxDeliver = (m: Mux, h: MuxHandle, e: EnvelopeEvent): void => {
    if (h.done) return;
    try { h.onEvent(e); } catch { /* 소비자 오류가 줄기를 죽이지 않게 */ }
    if (e.event === "turn" && e.status === "settled") muxFinish(m, h, { turn: h.turn ?? "", ok: e.ok === true });
  };

  /** 관찰 창(turns)을 아는 순간 핸들을 턴에 묶고, 줄기가 받아 둔 장부를 먼저 준다. */
  const muxBind = (m: Mux, s: MuxSession, h: MuxHandle): void => {
    if (h.done || h.turn != null || h.fallback || s.turns == null) return;
    if (h.want.kind === "attach") {
      const first = s.turns[0];
      if (!first) { muxFinish(m, h, err("E_NO_TURN", "진행 중 턴 없음: " + h.session)); return; }
      h.turn = first;
    } else if (s.turns.includes(h.want.turn)) {
      h.turn = h.want.turn;
    } else {
      // 창 밖의 턴 — 이미 종결했다. 장부 재생은 직접 stream 이 맡는다(§5.1-13)
      const url = base + "/turns/" + encodeURIComponent(h.want.turn) + "/stream";
      h.fallback = directObserve(h.session, url, h.onEvent, "stream");
      void h.fallback.settled.then((r) => muxFinish(m, h, r));
      return;
    }
    for (const e of s.ledger.get(h.turn) ?? []) muxDeliver(m, h, e);
  };

  const muxConsume = (m: Mux, msg: string, onReady: () => void): void => {
    let raw: unknown;
    try { raw = JSON.parse(msg); } catch { return; }
    if (!raw || typeof raw !== "object" || typeof (raw as { event?: unknown }).event !== "string") return;
    const ev = raw as EnvelopeEvent;
    const session = typeof ev.session === "string" ? ev.session : "";
    const turn = typeof ev.turn === "string" ? ev.turn : "";
    if (ev.event === "observe") {
      if (ev.status === "ready") { onReady(); return; }
      const s = m.sessions.get(session);
      if (!s) return;
      if (ev.status === "session") {
        s.turns = Array.isArray(ev.turns) ? (ev.turns as unknown[]).filter((x): x is string => typeof x === "string") : [];
        s.ledger.clear(); // 서버 재생이 뒤따른다
        for (const h of [...s.handles]) muxBind(m, s, h);
      } else if (ev.status === "turn" && turn) {
        if (s.turns == null) s.turns = [];
        if (!s.turns.includes(turn)) s.turns.push(turn);
        for (const h of [...s.handles]) muxBind(m, s, h);
      }
      return;
    }
    const s = m.sessions.get(session);
    if (!s || !turn) return;
    const buf = s.ledger.get(turn) ?? [];
    buf.push(ev);
    s.ledger.set(turn, buf);
    for (const h of [...s.handles]) if (h.turn === turn) muxDeliver(m, h, ev);
    if (ev.event === "turn" && ev.status === "settled") {
      s.ledger.delete(turn);
      if (s.turns) s.turns = s.turns.filter((t) => t !== turn);
    }
  };

  const muxOpen = (): Mux => {
    if (mux && !mux.dead) return mux;
    const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    let onReady: (ok: boolean) => void = () => {};
    const ready = new Promise<boolean>((r) => { onReady = r; });
    const m: Mux = { id, ctrl: new AbortController(), ready, sessions: new Map(), dead: false };
    mux = m;
    (async () => {
      let res: Response;
      try {
        res = await fetchFn(base + "/observe?id=" + encodeURIComponent(id), {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "text/event-stream" },
          signal: m.ctrl.signal,
        });
      } catch (e) {
        onReady(false);
        muxDied(m, m.ctrl.signal.aborted ? "관찰을 클라이언트가 닫음" : "관찰 줄기를 열지 못했어요: " + (e instanceof Error ? e.message : String(e)));
        return;
      }
      if (!res.ok || !res.body) { onReady(false); muxDied(m, "관찰 줄기 응답 " + res.status); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SSEParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const msg of parser.feed(dec.decode(value, { stream: true }))) muxConsume(m, msg, () => onReady(true));
        }
      } catch { /* 절단 */ }
      onReady(false);
      muxDied(m, m.ctrl.signal.aborted
        ? "관찰을 클라이언트가 닫음"
        : "연결이 끊겼어요 — 진행 중이던 턴은 서버에서 계속 실행됩니다. turn.attach 로 재접속하세요.");
    })();
    return m;
  };

  const muxObserve = (m: Mux, session: string, want: MuxWant, onEvent: OnEvent): StreamHandle => {
    let finish!: (r: Result<TurnSettled>) => void;
    let done = false;
    const settled = new Promise<Result<TurnSettled>>((resolve) => {
      finish = (r) => { if (!done) { done = true; resolve(r); } };
    });
    const h: MuxHandle = { session, want, turn: null, onEvent, finish, done: false, fallback: null };
    const s = m.sessions.get(session);
    if (!s) {
      m.sessions.set(session, { handles: new Set([h]), turns: null, ledger: new Map() });
      void muxPost(m, { add: [session] }).then((ok) => {
        if (ok || m.dead) return;
        for (const x of [...(m.sessions.get(session)?.handles ?? [])]) {
          muxFinish(m, x, err("E_DISCONNECTED", "관찰 구독에 실패했어요 — turn.attach 로 재접속하세요."));
        }
      });
    } else {
      // 같은 세션의 이전 관찰은 대체한다(§5.2 ④) — 새 핸들을 먼저 앉혀 구독이 내려가지 않게 한다
      const olds = [...s.handles];
      s.handles.add(h);
      for (const old of olds) muxFinish(m, old, err("E_DISCONNECTED", "관찰을 클라이언트가 닫음"));
      muxBind(m, s, h);
    }
    return {
      settled,
      close: () => muxFinish(m, h, err("E_DISCONNECTED", "관찰을 클라이언트가 닫음")),
    };
  };

  // ── 관찰 진입 — 길은 개막이 정한다. 핸들은 즉시 돌려주고 안쪽은 판정 뒤에 연다 ───────

  const observeTurn = (session: string, want: MuxWant, onEvent: OnEvent): StreamHandle => {
    let finish!: (r: Result<TurnSettled>) => void;
    let done = false;
    const settled = new Promise<Result<TurnSettled>>((resolve) => {
      finish = (r) => { if (!done) { done = true; resolve(r); } };
    });
    let inner: StreamHandle | null = null;
    let closed = false;
    void muxSupported().then((useMux) => {
      if (closed) return;
      inner = useMux
        ? muxObserve(muxOpen(), session, want, onEvent)
        : directObserve(
            session,
            want.kind === "stream"
              ? base + "/turns/" + encodeURIComponent(want.turn) + "/stream"
              : base + "/turns/attach?session=" + encodeURIComponent(session),
            onEvent,
            want.kind,
          );
      void inner.settled.then(finish);
    });
    return {
      settled,
      close: () => {
        closed = true;
        finish(err("E_DISCONNECTED", "관찰을 클라이언트가 닫음"));
        inner?.close();
      },
    };
  };

  // ── push 공유 커넥션 (§5.8 — fail-loud, dead 래치 금지) ────────────────────

  const pushSubs = new Set<PushSubscription>();
  let pushCtrl: AbortController | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushDelay = 1000;
  const PUSH_DELAY_MAX = 30000;

  const pushHidden = (): boolean => typeof document !== "undefined" && document.hidden;

  const pushError = (e: ErrorEnvelope): void => {
    for (const s of [...pushSubs]) { try { s.onError(e); } catch { /* 구독자 오류 격리 */ } }
  };
  const pushDispatch = (ev: EnvelopeEvent): void => {
    for (const s of [...pushSubs]) { try { s.onEvent(ev); } catch { /* 구독자 오류 격리 */ } }
  };

  const pushSchedule = (): void => {
    if (pushTimer != null || pushCtrl != null || pushSubs.size === 0 || pushHidden()) return;
    pushTimer = setTimeout(() => { pushTimer = null; void pushOpen(); }, pushDelay);
    pushDelay = Math.min(pushDelay * 2, PUSH_DELAY_MAX);
  };

  const pushOpen = async (): Promise<void> => {
    if (pushCtrl != null || pushSubs.size === 0 || pushHidden()) return;
    const ctrl = new AbortController();
    pushCtrl = ctrl;
    try {
      const res = await fetchFn(base + "/events", {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok) { pushError(await envelopeOf(res)); return; }
      if (!res.body) { pushError(err("E_DISCONNECTED", "push SSE 응답에 body 없음")); return; }
      pushDelay = 1000; // 접속 성공 — 백오프 리셋
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SSEParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const msg of parser.feed(dec.decode(value, { stream: true }))) {
          let ev: unknown;
          try { ev = JSON.parse(msg); } catch { continue; }
          if (ev && typeof ev === "object" && typeof (ev as { event?: unknown }).event === "string") {
            pushDispatch(ev as EnvelopeEvent);
          }
        }
      }
      if (!ctrl.signal.aborted) pushError(err("E_DISCONNECTED", "push 스트림이 닫혔습니다 — 재접속합니다."));
    } catch (e) {
      if (!ctrl.signal.aborted) pushError(err("E_NETWORK", e instanceof Error ? e.message : String(e)));
    } finally {
      if (pushCtrl === ctrl) pushCtrl = null;
      pushSchedule(); // 구독자가 남아 있는 한 재시도 — 영구 침묵 강등 금지(§5.8)
    }
  };

  const onVisibility = (): void => {
    if (pushHidden()) {
      pushCtrl?.abort(); // 커넥션 반납(§5.2 예산)
    } else {
      pushDelay = 1000;
      void pushOpen();
    }
  };

  const pushSubscribe = (sub: PushSubscription): (() => void) => {
    if (pushSubs.size === 0 && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    pushSubs.add(sub);
    void pushOpen();
    return () => {
      pushSubs.delete(sub);
      if (pushSubs.size === 0) {
        if (pushTimer != null) { clearTimeout(pushTimer); pushTimer = null; }
        pushCtrl?.abort();
        pushDelay = 1000;
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  };

  // ── 파일 (§5.4) ────────────────────────────────────────────────────────────

  const uploadUrl = (name: string): string => base + "/upload?name=" + encodeURIComponent(name);

  const sizeOf = (data: UploadBytes): number =>
    data instanceof Blob ? data.size : "byteLength" in data ? data.byteLength : 0;

  /** 업로드 프로브(§5.4-26) — 바이트 전송 없이 인가·상한을 선판정한다. */
  const uploadProbe = async (name: string, size: number): Promise<Result<{ ok: true }>> => {
    let res: Response;
    try {
      res = await fetchFn(uploadUrl(name), {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Upload-Probe": "1", "X-Upload-Size": String(size) },
      });
    } catch (e) {
      return err("E_NETWORK", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) return envelopeOf(res);
    return { ok: true };
  };

  const xhrUpload = (
    url: string,
    data: UploadBytes,
    total: number,
    onProgress: (sent: number, total: number) => void,
  ): Promise<Result<UploadResult>> =>
    new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.upload.onprogress = (e) => {
        try { onProgress(e.loaded, e.lengthComputable ? e.total : total); } catch { /* 소비자 오류 격리 */ }
      };
      xhr.onload = () => {
        const text = xhr.responseText || "";
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(text) as UploadResult); }
          catch { resolve(err("E_HTTP_" + xhr.status, "JSON 아닌 응답 본문")); }
        } else {
          resolve(envelopeOfText(xhr.status, text));
        }
      };
      xhr.onerror = () => resolve(err("E_NETWORK", "업로드 전송 실패"));
      xhr.onabort = () => resolve(err("E_NETWORK", "업로드 중단"));
      xhr.send(data as XMLHttpRequestBodyInit);
    });

  // ── 표면 — 계약 동사 그대로 ────────────────────────────────────────────────

  return {
    /**
     * 개막 호출(§3-7). 구 기판(404)·protocol 불일치는 E_PROTOCOL 판정 —
     * 구 wire 폴백 없음(fail-loud, §9-44).
     */
    capabilities: (): Promise<Result<Capabilities>> => loadCaps(),

    turn: {
      /** §5.1-12 — 비블로킹 시작. 202 {turn, session}, 종결은 stream/attach 로 관찰. */
      send: (req: TurnSendRequest): Promise<Result<TurnStarted>> => post<TurnStarted>(base + "/turns", req),

      /** §5.1-13 — send 직후의 관찰 창. 종결된 턴이면 장부 재생 후 즉시 settled·EOF.
       *  session = 관찰의 단위(§5.2 ④) — 같은 세션의 이전 관찰만 대체한다. observe 기판에선 줄기
       *  하나에 실리고, 아니면 직접 SSE(상한에 닿으면 가장 오래 열린 관찰을 양보시킨다). */
      stream: (turn: string, session: string, onEvent: OnEvent): StreamHandle =>
        observeTurn(session, { kind: "stream", turn }, onEvent),

      /** §5.1-14 — 진행 중 턴 재접속(장부 처음부터 재생 + 라이브). 없으면 E_NO_TURN.
       *  직접 SSE 에서 상한에 닿으면 슬롯이 빌 때까지 대기한다 — 양보시키지 않는다(순환 차단). */
      attach: (session: string, onEvent: OnEvent): StreamHandle =>
        observeTurn(session, { kind: "attach" }, onEvent),

      /** §5.1-15 — 봉투 cancel 제어로 전달된다. */
      interrupt: (turn: string): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/turns/" + encodeURIComponent(turn) + "/interrupt", {}),

      /** §5.1-16 — 봉투 ask 이벤트의 회송. 빈 answers = 사용자 취소. */
      respond: (turn: string, req: RespondRequest): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/turns/" + encodeURIComponent(turn) + "/respond", req),

      /** §5.1-16-a — capability `steer`. 진행 중 턴에 발화를 얹는다(턴을 열지 않는다).
       *  `ok:false` = 얹을 턴이 없다 — 호출자는 발화를 버리지 말고 turn.send 로 폴백한다. */
      steer: (turn: string, prompt: string): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/turns/" + encodeURIComponent(turn) + "/steer", { prompt }),
    },

    session: {
      /** §5.3-21 — 정렬(고정 우선·최근순)은 기판 몫, label 은 그대로 그린다. */
      list: (): Promise<Result<{ sessions: SessionEntry[] }>> =>
        get<{ sessions: SessionEntry[] }>(base + "/sessions"),

      /** §5.3-22 — 세션 id 는 기판 발급 불투명 문자열. 클라이언트 로컬 발급은 은퇴.
       *  init(additive) = 대화 바인딩 {agent, param} — param 축은 기판 id 에 실을 수 없어
       *  민팅 순간이 바인딩이 wire 에 닿는 유일한 자리다. */
      create: (init?: SessionCreateRequest): Promise<Result<{ session: string }>> =>
        post<{ session: string }>(base + "/sessions", {
          ...(init?.agent ? { agent: init.agent } : {}),
          ...(init?.param ? { param: init.param } : {}),
          ...(init?.draft ? { draft: true } : {}),
        }),

      /** §5.3-23 — 빈 label = 자동 라벨 복귀. */
      rename: (session: string, label: string): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/sessions/" + encodeURIComponent(session) + "/rename", { label }),

      archive: (session: string, archived: boolean): Promise<Result<{ ok: boolean; archived: boolean }>> =>
        post<{ ok: boolean; archived: boolean }>(
          base + "/sessions/" + encodeURIComponent(session) + "/archive", { archived }),

      pin: (session: string, pinned: boolean): Promise<Result<{ ok: boolean; pinned: boolean }>> =>
        post<{ ok: boolean; pinned: boolean }>(
          base + "/sessions/" + encodeURIComponent(session) + "/pin", { pinned }),

      /** 추상 동사 session.remove — wire op 명은 delete 다(§5.3-23 표 · 부록 A). */
      remove: (session: string): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/sessions/" + encodeURIComponent(session) + "/delete", {}),

      /** §5.3-23 — 이력은 두고 하네스 대화 포인터만 끊는다. */
      reset: (session: string): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/sessions/" + encodeURIComponent(session) + "/reset", {}),
    },

    history: {
      /** §5.3-24 — busy=true 면 turn 에 진행 중 턴 id. 새로고침 복구는 이 한 왕복 + attach. */
      get: (session: string): Promise<Result<History>> =>
        get<History>(base + "/sessions/" + encodeURIComponent(session) + "/history"),
    },

    file: {
      /** §5.4-26 단독 선판정 — 파일 선택 시점의 조기 거절 문장용. upload 도 내부에서 거친다. */
      probe: (name: string, size: number): Promise<Result<{ ok: true }>> => uploadProbe(name, size),

      /**
       * §5.4-25 — 본문이 곧 바이트다(raw, JSON/base64/multipart 비경유).
       * 프로브 선판정 후 전송하며, onProgress 지정 시 XHR 로 진행 이벤트를 낸다.
       */
      upload: async (data: UploadBytes, options: UploadOptions): Promise<Result<UploadResult>> => {
        const size = sizeOf(data);
        const probe = await uploadProbe(options.name, size);
        if (isError(probe)) return probe;
        if (options.onProgress) return xhrUpload(uploadUrl(options.name), data, size, options.onProgress);
        return call<UploadResult>(uploadUrl(options.name), { method: "POST", body: data as BodyInit });
      },

      /** §5.4-27 — file.download 의 GET URL. path 는 불투명 참조(이스케이프만, 해석 금지). */
      url: (path: string, o?: { dl?: boolean }): string =>
        base + "/file/" + escOpaque(path) + (o?.dl ? "?dl=1" : ""),

      /** §5.4-27 — HEAD 실재 프로브. */
      head: async (path: string): Promise<Result<{ ok: true }>> => {
        let res: Response;
        try {
          res = await fetchFn(base + "/file/" + escOpaque(path), { method: "HEAD", credentials: "same-origin" });
        } catch (e) {
          return err("E_NETWORK", e instanceof Error ? e.message : String(e));
        }
        if (!res.ok) return envelopeOf(res);
        return { ok: true };
      },
    },

    harness: {
      /** §5.5-29 — capability harness-info 뒤. */
      info: (): Promise<Result<HarnessInfo>> => get<HarnessInfo>(base + "/harness/info"),
      /** §5.5-29 — capability harness-models 뒤. */
      models: (variant?: string): Promise<Result<HarnessModels>> =>
        get<HarnessModels>(base + "/harness/models" + (variant ? "?variant=" + encodeURIComponent(variant) : "")),
      /** §5.5-29 — capability harness-commands 뒤. */
      commands: (): Promise<Result<HarnessCommands>> => get<HarnessCommands>(base + "/harness/commands"),
      /** §5.5-30-a — capability harness-variants 뒤. 변형 선택은 설정이지 자격 행위가 아니다. */
      variants: (): Promise<Result<HarnessVariants>> => get<HarnessVariants>(base + "/harness/variants"),
      /** §5.5-30 — known:false 는 판정 정보(저장은 된다). effort 필드는 capability effort 뒤. */
      set: (req: HarnessSetRequest): Promise<Result<HarnessSetResult>> =>
        post<HarnessSetResult>(base + "/model", req),
    },

    instances: {
      /** §5.6-32 — root 소속, capability enumerate 뒤. 닫힌 shape — manifest 파헤치기 금지. */
      list: (): Promise<Result<{ instances: InstanceEntry[] }>> =>
        get<{ instances: InstanceEntry[] }>(root + "/instances"),
    },

    state: {
      /** §5.7-33 — capability state 뒤. 내용은 기판 소유 불투명 JSON. */
      get: (): Promise<Result<{ state: unknown }>> => get<{ state: unknown }>(base + "/state"),
      set: (state: unknown): Promise<Result<{ ok: boolean }>> => post<{ ok: boolean }>(base + "/state", { state }),
    },

    push: {
      /**
       * §5.8 — capability push 뒤. 페이지당 공유 커넥션 1개(구독자끼리 공유),
       * 백오프 재접속 + visibility 반납. 반환 = 해지 함수.
       */
      subscribe: (sub: PushSubscription): (() => void) => pushSubscribe(sub),
    },
  };
}

export type Transport = ReturnType<typeof createTransport>;
