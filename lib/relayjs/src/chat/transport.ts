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
 *    SSEParser(lib/relayjs/src/sse.ts, Phase 0-a 상륙분)가 버린다. 종결 정본은
 *    turn/settled(§5.2-20·§6-36) — settled 없는 EOF 는 E_DISCONNECTED(가짜완료 금지).
 *  - 커넥션 예산(§5.2) — push 는 페이지당 공유 커넥션 1개(백오프 재접속 + document.hidden
 *    시 반납), 턴 스트림은 진행 중에만, stream/attach 는 서로 대체 접속(신규 추가 아님).
 *    이 transport 는 관찰 커넥션을 인스턴스당 1개로 강제한다(새 관찰이 이전 관찰을 닫는다).
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
  | "upload-progress";

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
  /** §5.3-24 additive — 이 대화의 에이전트(위임 세션 등). 없으면 착지 에이전트 */
  agent?: string };

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
  chat?: { greeting?: string };
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

  // ── SSE 관찰 (§5.2) ────────────────────────────────────────────────────────

  const openObservation = (url: string, onEvent: OnEvent): StreamHandle => {
    const ctrl = new AbortController();
    let finish!: (r: Result<TurnSettled>) => void;
    let done = false;
    const settled = new Promise<Result<TurnSettled>>((resolve) => {
      finish = (r) => { if (!done) { done = true; resolve(r); } };
    });

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
    })();

    return {
      settled,
      close: () => {
        finish(err("E_DISCONNECTED", "관찰을 클라이언트가 닫음"));
        ctrl.abort();
      },
    };
  };

  // 커넥션 예산(§5.2): 턴 관찰은 transport 당 1개 — stream/attach 는 이전 관찰의 대체 접속이다.
  let observation: StreamHandle | null = null;
  const observe = (url: string, onEvent: OnEvent): StreamHandle => {
    observation?.close();
    const h = observation = openObservation(url, onEvent);
    return h;
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
    capabilities: async (): Promise<Result<Capabilities>> => {
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
    },

    turn: {
      /** §5.1-12 — 비블로킹 시작. 202 {turn, session}, 종결은 stream/attach 로 관찰. */
      send: (req: TurnSendRequest): Promise<Result<TurnStarted>> => post<TurnStarted>(base + "/turns", req),

      /** §5.1-13 — send 직후의 관찰 창. 종결된 턴이면 장부 재생 후 즉시 settled·EOF. */
      stream: (turn: string, onEvent: OnEvent): StreamHandle =>
        observe(base + "/turns/" + encodeURIComponent(turn) + "/stream", onEvent),

      /** §5.1-14 — 진행 중 턴 재접속(장부 처음부터 재생 + 라이브). 없으면 E_NO_TURN. */
      attach: (session: string, onEvent: OnEvent): StreamHandle =>
        observe(base + "/turns/attach?session=" + encodeURIComponent(session), onEvent),

      /** §5.1-15 — 봉투 cancel 제어로 전달된다. */
      interrupt: (turn: string): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/turns/" + encodeURIComponent(turn) + "/interrupt", {}),

      /** §5.1-16 — 봉투 ask 이벤트의 회송. 빈 answers = 사용자 취소. */
      respond: (turn: string, req: RespondRequest): Promise<Result<{ ok: boolean }>> =>
        post<{ ok: boolean }>(base + "/turns/" + encodeURIComponent(turn) + "/respond", req),
    },

    session: {
      /** §5.3-21 — 정렬(고정 우선·최근순)은 기판 몫, label 은 그대로 그린다. */
      list: (): Promise<Result<{ sessions: SessionEntry[] }>> =>
        get<{ sessions: SessionEntry[] }>(base + "/sessions"),

      /** §5.3-22 — 세션 id 는 기판 발급 불투명 문자열. 클라이언트 로컬 발급은 은퇴. */
      create: (): Promise<Result<{ session: string }>> => post<{ session: string }>(base + "/sessions", {}),

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
      models: (): Promise<Result<HarnessModels>> => get<HarnessModels>(base + "/harness/models"),
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
