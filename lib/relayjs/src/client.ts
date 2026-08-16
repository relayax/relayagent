/*!
 * client.ts — 신 계약(docs/client-protocol.md v1) 단일 클라이언트. 구 core.js 의 후계다.
 *
 * 유지: **no-throw 봉투**(모든 호출의 실패는 `{error:{code,message}}` 로 돌아온다 —
 * core.js:2, 4-20) 와 `createChat` 표면(history/busy/ready/meta/on/send/cancel/answer/
 * reset/upload/fileUrl/sessions.* — core.js:423-428).
 *
 * 폐기(계약이 은퇴시킨 것):
 *  - 900ms 진행 폴링 · 3초 유휴/busy 폴링(core.js:134-154, 91-114, 253-270) → turn.stream ·
 *    turn.attach · push.subscribe. 폴링 폴백은 금지다(client-protocol §5.8).
 *  - 클라이언트 전송 큐(core.js:116-127) → 같은 세션의 직렬화는 기판 소유(§5.1-12).
 *    화면 두 개가 같은 세션에 붙는 순간 클라이언트 큐는 깨진다.
 *  - 클라이언트 slot 발급(core.js:315-324) → `session.create` 가 발급하는 불투명 문자열(§5.3-22).
 *  - `/registry` manifest 파헤치기(core.js:49-70) → `instances.list` 의 닫힌 shape(§5.6-32).
 *    착지 에이전트 판정도 서버가 실어 보낸다 — 재구현 금지(§8-42).
 *
 * 좌표는 주입이다(§2-6): `base`(대화 스코프) · `root`(열거 동사의 뿌리). `/pkg/:pkg` 나
 * `/i/<id>` 같은 마운트 문법이 이 파일에 새면 계약 위반이다.
 *
 * 전송은 chat/transport 의 `createTransport` 팩토리가 소유한다 — 이 모듈은 경로·헤더·
 * 프레이밍을 모른다. 팩토리 동사는 no-throw `Result` 를 돌려주므로, 아래 wire* 어댑터가
 * 실패 봉투를 **throw**(코드는 `e.code`)로 승격하고, 도로 봉투로 접는 지점은 `envelope()`
 * 하나다. 스트림 동사(stream/attach)는 관찰 핸들의 `settled` 를 끝까지 몰아 종결 판정만
 * 돌려준다 — 이벤트는 onEvent 콜백으로 흐른다(§5.2).
 */
import {
  createTransport,
  isError,
  type Transport,
  type Result,
  type OnEvent,
  type TurnSettled,
  type TurnSendRequest,
  type RespondRequest,
} from "./chat/transport";
import { EnvelopeReducer, type EnvelopeEvent, type TurnUsageLive } from "./chat/envelope-reducer";
// 봉투 축 타입의 정본은 패키지 공개 선언(src/index.d.ts) — 재선언하지 않는다.
import type { TurnUsage, TurnContext } from "./index.js";

/** 이 클라이언트가 말하는 계약 버전. capabilities 의 protocol 과 다르면 fail-loud(§3-7). */
export const CLIENT_PROTOCOL = 1;

export type ErrorShape = { code: string; message: string };
export type Envelope<T> = (T & { error?: undefined }) | { error: ErrorShape };

export type Role = "user" | "bot" | "sys";
export type FileRef = { name?: string; path: string };
/** 이력 한 줄. usage/context 는 **봉투 이름**이 정본이다(패키지 공개 선언 ChatMessage 와 같은 축) —
 *  기판이 이력에 적는 모양이자 위젯 게이지가 읽는 모양이다. Chat 이 쓰는 Anthropic 이름 투영은
 *  이력이 아니라 리듀서 meta 에만 산다. */
export type Message = {
  role: Role;
  text: string;
  files?: FileRef[];
  usage?: TurnUsage;
  context?: TurnContext;
  model?: string;
};

export type SessionRow = {
  session: string;
  label?: string;
  updated?: number;
  archived?: boolean;
  pinned?: boolean;
};

/** instances.list 한 줄(§5.6-32 닫힌 shape). `agent` 는 서버가 실은 착지 판정 결과다. */
export type InstanceRow = {
  id: string;
  display_name?: string;
  icon?: string;
  chat?: { greeting?: string };
  agents?: string[];
  agent?: string | null;
  model?: string;
  effort?: string;
};

export type ChatMeta = {
  found: boolean;
  display_name: string;
  icon: string;
  greeting: string;
  model: string | null;
  effort: string | null;
  agents: string[];
  agent: string | null;
};

export type CreateChatOptions = {
  /** 대화 스코프의 뿌리. §5 의 모든 스코프 동사가 여기 상대다. */
  base: string;
  /** 열거 동사(instances.list)의 뿌리. 없으면 meta 는 기본값으로 남는다. */
  root?: string;
  /** 이 대화가 사는 인스턴스 id — instances.list 에서 자기 행을 찾는 키. */
  instance?: string;
  /** 명시 에이전트. 없으면 서버 판정(instances.list 의 agent)을 쓴다. */
  agent?: string | null;
  /** 이어서 열 세션. 없으면 개막에서 session.create 로 발급받는다. */
  session?: string;
};

export type SendOptions = {
  attachments?: FileRef[];
  /** 화면에 그릴 원문(@멘션 포함). 프롬프트와 다를 수 있다. */
  display?: string;
  agent?: string;
  /** 화면 맥락 서문 — 합성은 기판 몫, 이력에는 원문만 남는다(§5.1-12). */
  scene?: string;
};

/**
 * 방출 이벤트 — 구 core.js 어휘를 보존한다.
 *  message(말풍선 추가) · busy · meta · history(이력 재적재) · session(전환) ·
 *  turn(턴 개설) · progress(봉투 이벤트 원본) · usage(종결 집계) · reset
 * 신설 둘: parts(진행 중 턴의 파트 스냅샷 — 리듀서가 클라이언트로 내려오며 생긴 자리) ·
 * error(계약 판정·push 실패의 fail-loud 표면, §5.8).
 */
export type ChatEventName =
  | "message" | "busy" | "meta" | "history" | "session"
  | "turn" | "progress" | "parts" | "usage" | "tick" | "reset" | "error";

type Listener = (arg?: any) => void;

const errorOf = (e: any): ErrorShape => {
  const code = typeof e?.code === "string" && e.code ? e.code : "";
  const message = typeof e?.message === "string" && e.message ? e.message : String(e ?? "");
  return code ? { code, message } : { code: "E_NETWORK", message };
};

/** 계약 동사 하나를 no-throw 봉투로 감싼다 — 이 모듈 밖으로 예외가 새지 않는다. */
async function envelope<T>(fn: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return (await fn()) as Envelope<T>;
  } catch (e) {
    return { error: errorOf(e) };
  }
}

// ── transport 어댑터 — 팩토리 Result 를 throw 로 승격한 계약 동사 함수들 ────
// transport 는 base×root 당 1개를 재사용한다 — 관찰 커넥션 예산(§5.2)의 단위가 transport 라
// stream/attach 가 이전 관찰의 대체 접속이 되게 한다(runtime.ts transportFor 와 같은 판정).

const _transports = new Map<string, Transport>();
function tFor(base: string, root?: string): Transport {
  const r = root || base;
  const key = base + "\u0000" + r;
  let t = _transports.get(key);
  if (!t) {
    t = createTransport({ base, root: r });
    _transports.set(key, t);
  }
  return t;
}

/** Result 봉투 → throw 승격. 도로 봉투로 접는 곳은 envelope() 하나다. */
function unwrap<T>(r: Result<T>): T {
  if (isError(r)) {
    const e = new Error(r.error.message || r.error.code) as Error & { code: string };
    e.code = r.error.code;
    throw e;
  }
  return r;
}

/** 관찰 핸들을 끝까지 몬다 — settled 는 reject 하지 않으므로(§5.2-20) 여기서 승격한다. */
const settledOf = (h: { settled: Promise<Result<TurnSettled>> }): Promise<TurnSettled> =>
  h.settled.then(unwrap);

const wireCapabilities = async (base: string) => unwrap(await tFor(base).capabilities());
const wireTurnSend = async (base: string, req: TurnSendRequest) => unwrap(await tFor(base).turn.send(req));
const wireTurnStream = (base: string, turn: string, onEvent: OnEvent) =>
  settledOf(tFor(base).turn.stream(turn, onEvent));
const wireTurnAttach = (base: string, session: string, onEvent: OnEvent) =>
  settledOf(tFor(base).turn.attach(session, onEvent));
const wireTurnInterrupt = async (base: string, turn: string) => unwrap(await tFor(base).turn.interrupt(turn));
const wireTurnRespond = async (base: string, turn: string, req: { ask: string; answers: unknown[] }) =>
  unwrap(await tFor(base).turn.respond(turn, req as unknown as RespondRequest));
const wireSessionList = async (base: string) => unwrap(await tFor(base).session.list());
const wireSessionCreate = async (base: string) => unwrap(await tFor(base).session.create());
/** §5.3-23 부속 동사 — wire op 명(rename/archive/pin/delete/reset)을 팩토리 동사로 나른다. */
async function wireSessionOp(
  base: string,
  session: string,
  op: "rename" | "archive" | "pin" | "delete" | "reset",
  body: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const t = tFor(base);
  if (op === "rename") return unwrap(await t.session.rename(session, String(body.label ?? "")));
  if (op === "archive") return unwrap(await t.session.archive(session, !!body.archived));
  if (op === "pin") return unwrap(await t.session.pin(session, !!body.pinned));
  if (op === "delete") return unwrap(await t.session.remove(session));
  return unwrap(await t.session.reset(session));
}
const wireHistoryGet = async (base: string, session: string) => unwrap(await tFor(base).history.get(session));
const wireFileUpload = async (
  base: string,
  file: File,
  o: { name: string; onProgress?: (pct: number) => void },
) => {
  const onProgress = o.onProgress;
  return unwrap(
    await tFor(base).file.upload(file, {
      name: o.name,
      ...(onProgress
        ? {
            onProgress: (sent: number, total: number) => {
              if (total > 0) onProgress(Math.min(100, Math.round((sent / total) * 100)));
            },
          }
        : {}),
    }),
  );
};
const wireFileUrl = (base: string, path: string, dl: boolean) => tFor(base).file.url(path, { dl });
const wireHarnessInfo = async (base: string) => unwrap(await tFor(base).harness.info());
const wireHarnessModels = async (base: string) => unwrap(await tFor(base).harness.models());
const wireHarnessCommands = async (base: string) => unwrap(await tFor(base).harness.commands());
const wireHarnessSet = async (base: string, req: { model?: string; effort?: string }) =>
  unwrap(await tFor(base).harness.set(req));
const wireInstancesList = async (root: string) => unwrap(await tFor(root).instances.list());
const wirePushSubscribe = (
  base: string,
  onEvent: (ev: EnvelopeEvent) => void,
  onError: (e: unknown) => void,
): (() => void) =>
  tFor(base).push.subscribe({
    onEvent: (ev) => onEvent(ev as EnvelopeEvent),
    // transport 는 {error:{code,message}} 봉투로 알린다 — errorOf 가 읽는 ErrorShape 로 벗긴다.
    onError: (e) => onError(e.error),
  });

/** 절단 판정 — 서버 턴은 계속 돌 수 있으므로 재접속으로 잇는다(§5.2-20). */
const isCut = (e: ErrorShape | null): boolean => !!e && e.code === "E_DISCONNECTED";

const REATTACH_MAX = 5;
const REATTACH_BACKOFF_MS = 400;

export function createChat(opts: CreateChatOptions) {
  const base = String(opts.base || "");
  const root = opts.root ? String(opts.root) : "";
  const instanceId = opts.instance ? String(opts.instance) : "";
  const optAgent = opts.agent ?? null;

  const history: Message[] = [];
  const listeners: Record<string, Listener[]> = {};
  let session = opts.session ? String(opts.session) : "";
  let caps: string[] = [];
  let protocol = 0;
  let metaCache: ChatMeta | null = null;
  let cmdCache: unknown[] | null = null;
  /** 관찰 중인 턴 수. 0 이 아니면 busy — 큐가 아니라 관찰의 수다. */
  let observing = 0;
  let serverBusy = false;
  let busy = false;
  /** 지금 관찰 중인 턴 id — cancel·answer 가 대상을 찾는 1순위. */
  let liveTurn = "";
  /** 중단을 요청한 턴. 봉투는 취소와 실패를 구분하지 않으므로(어댑터는 error 로 종결한다)
   *  사용자 중단을 아는 쪽은 interrupt 를 부른 여기뿐이다 — 화면의 '중지됨'이 이 표시를 딛는다. */
  let cancelling = "";
  /** 미완 백그라운드 작업(봉투 task 이벤트의 원장) — 자발 턴을 기다릴 근거. */
  const bgTasks = new Set<string>();
  let unsubscribePush: (() => void) | null = null;

  const emit = (ev: ChatEventName, arg?: any): void => {
    for (const f of listeners[ev] || []) {
      try {
        f(arg);
      } catch {
        /* 구독자 오류가 다른 구독자와 스트림을 죽이지 않게 */
      }
    }
  };
  const on = (ev: ChatEventName, fn: Listener): (() => void) => {
    (listeners[ev] = listeners[ev] || []).push(fn);
    return () => {
      listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn);
    };
  };

  const syncBusy = (): void => {
    const next = observing > 0 || serverBusy;
    if (next === busy) return;
    busy = next;
    emit("busy", busy);
  };

  const push = (role: Role, text: string, files?: FileRef[]): Message => {
    const m: Message = { role, text, ...(files && files.length ? { files } : {}) };
    history.push(m);
    emit("message", m);
    return m;
  };

  const trackTask = (ev: EnvelopeEvent): void => {
    if (ev.event !== "task" || typeof ev.id !== "string") return;
    if (ev.status === "started") bgTasks.add(ev.id);
    else bgTasks.delete(ev.id);
  };

  // ── 개막 — capabilities 로 세대를 판정한다(§3-7) ─────────────────────────
  // 구 기판(이 경로 404)이나 protocol 불일치는 E_PROTOCOL 이다. 구 wire 로 폴백하지 않는다.
  async function open(): Promise<Envelope<{ protocol: number; capabilities: string[] }>> {
    let r: { protocol?: unknown; capabilities?: unknown };
    try {
      r = await wireCapabilities(base);
    } catch (e) {
      const err = errorOf(e);
      const shape: ErrorShape =
        err.code === "E_NETWORK"
          ? err
          : { code: "E_PROTOCOL", message: "이 주소는 계약 " + CLIENT_PROTOCOL + " 의 문이 아닙니다 (" + err.code + ")" };
      emit("error", shape);
      return { error: shape };
    }
    protocol = typeof r.protocol === "number" ? r.protocol : 0;
    caps = Array.isArray(r.capabilities) ? r.capabilities.filter((c): c is string => typeof c === "string") : [];
    if (protocol !== CLIENT_PROTOCOL) {
      const shape: ErrorShape = {
        code: "E_PROTOCOL",
        message: "계약 버전 불일치 — 기판 " + protocol + " / 클라이언트 " + CLIENT_PROTOCOL,
      };
      emit("error", shape);
      return { error: shape };
    }
    await meta();
    if (!session) {
      const created = await sessions.create();
      if (created.error) return { error: created.error };
    } else {
      await loadHistory();
    }
    armPush();
    return { protocol, capabilities: caps.slice() };
  }

  const has = (cap: string): boolean => caps.includes(cap);

  /** 미선언 capability 의 동사 호출은 클라이언트 결함이다(§3-8) — 문을 두드리지 않고 접는다. */
  const unsupported = (cap: string): { error: ErrorShape } => ({
    error: { code: "E_UNSUPPORTED", message: "이 기판은 " + cap + " 를 선언하지 않았습니다" },
  });

  // ── 메타 — 열거 동사의 닫힌 shape 소비(§5.6-32) ──────────────────────────
  async function meta(): Promise<ChatMeta> {
    if (metaCache) return metaCache;
    let row: InstanceRow | null = null;
    if (root && has("enumerate")) {
      try {
        const r = await wireInstancesList(root);
        const rows: InstanceRow[] = Array.isArray(r?.instances) ? r.instances : [];
        row = (instanceId ? rows.find((x) => x && x.id === instanceId) : rows[0]) || null;
      } catch {
        /* 열거 실패 — 기본 메타로 연다. 화면은 이름 없이도 대화할 수 있다 */
      }
    }
    metaCache = {
      found: !!row,
      display_name: row?.display_name || instanceId || "",
      icon: row?.icon || "",
      greeting: row?.chat?.greeting || "",
      model: row?.model || null,
      effort: row?.effort || null,
      agents: Array.isArray(row?.agents) ? row!.agents! : [],
      // 착지 판정은 서버 소유다(§8-42) — 명시 지정만 클라이언트가 덮는다.
      agent: optAgent ?? row?.agent ?? null,
    };
    emit("meta", metaCache);
    return metaCache;
  }

  const ready = open();

  // ── 이력 ────────────────────────────────────────────────────────────────
  async function loadHistory(): Promise<Envelope<{ messages: number; busy: boolean; turn: string }>> {
    if (!session) return { messages: 0, busy: false, turn: "" };
    const r = await envelope(() => wireHistoryGet(base, session));
    if (r.error) return { error: r.error };
    history.length = 0;
    for (const m of Array.isArray(r.messages) ? r.messages : []) {
      if (!m || typeof m.role !== "string" || m.text == null) continue;
      const text = String(m.text);
      const role: Role = m.role === "user" ? "user" : m.role === "bot" ? "bot" : "sys";
      history.push({
        role,
        // 빈 답변 기록은 새로고침하면 대화에서 통째로 증발한다 — 빈 자리는 빈 자리라고 말한다.
        text: role === "bot" && !text.trim() ? "(응답이 저장되지 않은 턴입니다)" : text,
        ...(Array.isArray(m.files) && m.files.length ? { files: m.files as FileRef[] } : {}),
        // 이력의 usage/context 는 봉투 원형이다 — wire 타입(열린 Record)을 공개 선언의 봉투
        // 타입으로 좁혀 싣는다(§5.3-24 shape 의 소비 지점).
        ...(m.usage ? { usage: m.usage as unknown as TurnUsage } : {}),
        ...(m.context ? { context: m.context as unknown as TurnContext } : {}),
        ...(m.model ? { model: m.model } : {}),
      });
    }
    emit("history");
    const turn = typeof r.turn === "string" ? r.turn : "";
    serverBusy = !!r.busy;
    syncBusy();
    // 진행 중 턴이 있고 아무도 관찰하고 있지 않다 = 새로고침·전환으로 관찰을 잃은 화면.
    // 폴링이 아니라 재접속으로 복구한다(§5.1-14).
    if (serverBusy && observing === 0) void attachTo(session);
    return { messages: history.length, busy: serverBusy, turn };
  }

  /** push 없는 기판의 따라잡기 — 다음 사용자 행위 시점의 history.get(§5.8). 폴링이 아니다. */
  const catchUp = (): Promise<unknown> => (observing > 0 ? Promise.resolve(null) : loadHistory());

  // ── 턴 관찰 ─────────────────────────────────────────────────────────────
  // 스트림 하나가 곧 관찰 하나다. 절단이면 attach 로 **대체 접속**한다 — 커넥션을 더 여는 것이
  // 아니라 끊긴 자리를 대신한다(§5.2 커넥션 예산).

  type Observation = { reply: string; error?: undefined } | { error: ErrorShape };

  function newReducer(): EnvelopeReducer {
    return new EnvelopeReducer({ onUsage: (u: TurnUsageLive) => emit("tick", u) });
  }

  function feed(reducer: EnvelopeReducer): (ev: EnvelopeEvent) => void {
    return (ev) => {
      trackTask(ev);
      reducer.push(ev);
      // 스트림의 첫 이벤트는 "어느 턴에 붙었는지"의 에코다(§6-36) — attach 로 붙은 관찰은
      // 여기서만 턴 id 를 알 수 있고, cancel·answer 가 그 id 를 대상으로 삼는다.
      if (reducer.turnId) liveTurn = reducer.turnId;
      emit("progress", ev);
      emit("parts", reducer.snapshot());
    };
  }

  /** 종결을 이력에 앉히고 화면에 알린다. */
  function land(reducer: EnvelopeReducer): Observation {
    const meta = reducer.meta;
    if (meta.ended === "cancelled") {
      // 중단은 실패가 아니다 — 그때까지 받은 말은 남기고, 아무 말도 없었으면 사실만 적는다.
      const partial = reducer.replyText;
      push(partial ? "bot" : "sys", partial || "(중지됨)");
      return { reply: partial };
    }
    if (meta.ended === "error") {
      const message = meta.error || "턴 실패";
      push("sys", "오류: " + message);
      return { error: { code: "E_TURN", message } };
    }
    const text = reducer.replyText;
    const files = (meta.files || []).map((p) => ({ path: p, name: p.split("/").pop() || p }));
    const m = push("bot", text || "(빈 응답)", files.length ? files : undefined);
    // 이력·게이지에는 봉투 원형을 앉힌다. meta.usage 는 Chat 전용 투영(Anthropic 필드명)이라
    // 여기에 쓰면 위젯 게이지가 라이브 턴에서만 꺼지고 새로고침하면 되살아난다 —
    // 기판이 이력에 적는 값이 봉투 이름이기 때문이다(widget.js:1754-1756 이 그 이름을 읽는다).
    if (reducer.settledUsage) m.usage = reducer.settledUsage;
    if (reducer.settledContext) m.context = reducer.settledContext;
    if (meta.model) m.model = meta.model;
    emit("usage", { usage: reducer.settledUsage ?? null, model: meta.model ?? null, context: reducer.settledContext ?? null });
    return { reply: text };
  }

  /**
   * observe — 열린 관찰 하나를 끝까지 몬다. settled 없이 끝난 스트림은 절단이므로
   * (§5.2-20) 유한 재시도로 attach 해 잇고, 이을 턴이 없으면(E_NO_TURN) 그 사이 종결된
   * 것이므로 이력으로 착지시킨다. 폴백 폴링은 없다.
   */
  async function observe(turnId: string, sessionId: string, initial?: "attach"): Promise<Observation> {
    observing += 1;
    liveTurn = turnId;
    syncBusy();
    try {
      let reducer = newReducer();
      const run = async (fn: () => Promise<unknown>): Promise<ErrorShape | null> => {
        const r = await envelope(fn);
        if (r.error) return r.error;
        // 스트림이 깨끗이 끝났는데 종결 마커가 없다 = 가짜완료 후보. 서버 턴은 계속 돌고
        // 있을 수 있으므로 절단으로 판정한다(§5.2-20) — 성공으로 위장하지 않는다.
        return reducer.settled ? null : { code: "E_DISCONNECTED", message: "턴 종결을 확인하지 못했습니다" };
      };
      let last = initial === "attach"
        ? await run(() => wireTurnAttach(base, sessionId, feed(reducer)))
        : await run(() => wireTurnStream(base, turnId, feed(reducer)));
      for (let i = 0; i < REATTACH_MAX && isCut(last); i++) {
        await new Promise((r) => setTimeout(r, REATTACH_BACKOFF_MS * (i + 1)));
        // 재접속은 장부를 처음부터 재생한다 — 신선한 리듀서로 받아야 완결 텍스트가 두 번
        // 적립되지 않는다. 화면은 재생이 채울 때까지 직전 스냅샷을 유지한다(빈 스냅샷 금지).
        reducer = newReducer();
        last = await run(() => wireTurnAttach(base, sessionId, feed(reducer)));
        if (last && last.code === "E_NO_TURN") {
          // 관찰이 끊긴 사이에 턴이 끝났다 — 이력이 정본이다.
          await loadHistory();
          return { reply: history[history.length - 1]?.text || "" };
        }
      }
      if (last) {
        reducer.markCut();
        emit("parts", reducer.snapshot());
        emit("error", last);
        return { error: last };
      }
      if (cancelling && (cancelling === turnId || cancelling === reducer.turnId)) {
        reducer.markCancelled();
        cancelling = "";
      }
      emit("parts", reducer.snapshot());
      return land(reducer);
    } finally {
      observing -= 1;
      if (observing === 0) {
        liveTurn = "";
        serverBusy = false;
      }
      syncBusy();
    }
  }

  /** 진행 중 턴에 붙는다 — 없으면 조용히 지나간다(E_NO_TURN 은 상태이지 실패가 아니다). */
  async function attachTo(sessionId: string): Promise<void> {
    const r = await observe("", sessionId, "attach");
    if (r.error && r.error.code === "E_NO_TURN") {
      serverBusy = false;
      syncBusy();
    }
  }

  // ── 전송 ────────────────────────────────────────────────────────────────
  async function send(text: string, sendOpts?: SendOptions): Promise<Observation> {
    const t = String(text ?? "").trim();
    const atts = (sendOpts?.attachments || []).filter((a) => a && a.path);
    if (!t && !atts.length) return { error: { code: "E_EMPTY", message: "빈 메시지" } };
    const message = t || "첨부 파일을 확인해줘";
    if (!session) {
      const created = await sessions.create();
      if (created.error) return { error: created.error };
    }
    // 말풍선은 보낸 즉시 그린다 — 큐가 아니라 왕복 지연 동안 보이지 않으면 유실처럼 보인다.
    push("user", sendOpts?.display || message, atts.map((a) => ({ name: a.name || String(a.path).split("/").pop(), path: a.path })));
    const agent = sendOpts?.agent || optAgent || undefined;
    const r = await envelope(() =>
      wireTurnSend(base, {
        session,
        message,
        ...(agent ? { agent } : {}),
        ...(atts.length ? { attachments: atts.map((a) => ({ path: a.path, ...(a.name ? { name: a.name } : {}) })) } : {}),
        ...(sendOpts?.scene ? { scene: String(sendOpts.scene) } : {}),
      }),
    );
    if (r.error) {
      push("sys", "오류: " + r.error.message);
      emit("error", r.error);
      return { error: r.error };
    }
    const turn = typeof r.turn === "string" ? r.turn : "";
    if (typeof r.session === "string" && r.session) session = r.session;
    // 개설은 종결을 붙들지 않는다 — 여기부터는 관찰이다(§5.1-12).
    emit("turn", { turn, session });
    if (!turn) {
      const shape: ErrorShape = { code: "E_NO_TURN", message: "턴 id 없이 개설 응답이 왔습니다" };
      emit("error", shape);
      return { error: shape };
    }
    return observe(turn, session);
  }

  /** 진행 중 턴 중단 — 봉투 cancel 제어로 전달된다(§5.1-15). */
  async function cancel(): Promise<Envelope<{ ok: boolean }>> {
    const turn = liveTurn || (await currentTurn());
    if (!turn) return { error: { code: "E_NO_TURN", message: "진행 중인 턴이 없습니다" } };
    const r = await envelope(() => wireTurnInterrupt(base, turn));
    if (!r.error) cancelling = turn;
    return r;
  }

  /** ask 회송 — 봉투 ask 이벤트의 답(§5.1-16). 빈 answers = 사용자 취소. */
  async function answer(askId: string, answers: unknown[]): Promise<Envelope<{ ok: boolean }>> {
    const turn = liveTurn || (await currentTurn());
    if (!turn) return { error: { code: "E_NO_TURN", message: "진행 중인 턴이 없습니다" } };
    return envelope(() => wireTurnRespond(base, turn, { ask: String(askId ?? ""), answers: answers || [] }));
  }

  /** 이력 한 왕복으로 진행 중 턴을 해석한다 — 폴링이 아니라 1회 조회다(§5.3-24). */
  async function currentTurn(): Promise<string> {
    if (!session) return "";
    const r = await envelope(() => wireHistoryGet(base, session));
    return !r.error && typeof r.turn === "string" ? r.turn : "";
  }

  /** 하네스 대화 포인터만 끊는다 — 이력은 남는다(§5.3-23). 구 코어의 history 비우기는 폐기. */
  async function reset(): Promise<Envelope<{ ok: boolean }>> {
    if (!session) return { error: { code: "E_NO_SESSION", message: "세션이 없습니다" } };
    const r = await envelope(() => wireSessionOp(base, session, "reset", {}));
    if (r.error) return { error: r.error };
    await loadHistory();
    emit("reset");
    return { ok: true };
  }

  // ── 파일 ────────────────────────────────────────────────────────────────
  // path 는 불투명 참조다(§5.4-25) — 검사·조립하지 않고 send 와 fileUrl 에만 되돌려준다.
  async function upload(file: File, onProgress?: (pct: number) => void): Promise<Envelope<FileRef & { size: number }>> {
    const name = (file && file.name) || "file";
    return envelope(() => wireFileUpload(base, file, { name, onProgress }));
  }

  const fileUrl = (path: string, dl?: boolean): string => wireFileUrl(base, path, !!dl);

  // ── 세션 ────────────────────────────────────────────────────────────────
  const sessions = {
    async list(): Promise<Envelope<{ sessions: SessionRow[] }>> {
      const r = await envelope(() => wireSessionList(base));
      if (r.error) return { error: r.error };
      return { sessions: Array.isArray(r.sessions) ? r.sessions : [] };
    },
    /** open 은 wire 동사가 아니다(§4) — history.get + (busy 면) turn.attach 의 합성이다. */
    async open(s: string): Promise<Envelope<{ session: string }>> {
      bgTasks.clear();
      session = String(s);
      history.length = 0;
      emit("session", session);
      const r = await loadHistory();
      if (r.error) return { error: r.error };
      return { session };
    },
    /** 세션 id 는 기판이 발급하는 불투명 문자열이다(§5.3-22) — 로컬 발급 폐기. */
    async create(): Promise<Envelope<{ session: string }>> {
      const r = await envelope(() => wireSessionCreate(base));
      if (r.error) {
        emit("error", r.error);
        return { error: r.error };
      }
      const next = typeof r.session === "string" ? r.session : "";
      if (!next) {
        const shape: ErrorShape = { code: "E_NO_SESSION", message: "세션 발급 응답에 session 이 없습니다" };
        emit("error", shape);
        return { error: shape };
      }
      bgTasks.clear();
      session = next;
      history.length = 0;
      emit("session", session);
      emit("history");
      return { session };
    },
    /** 빈 문자열 = 자동 라벨로 복귀(§5.3-23). */
    async rename(s: string, label: string): Promise<Envelope<{ ok: boolean }>> {
      return envelope(async () => {
        await wireSessionOp(base, String(s), "rename", { label: String(label ?? "") });
        return { ok: true };
      });
    },
    /** 보관/복원 — 이력을 지우지 않고 목록의 자리만 옮긴다. */
    async archive(s: string, on: boolean): Promise<Envelope<{ ok: boolean; archived: boolean }>> {
      return envelope(async () => {
        await wireSessionOp(base, String(s), "archive", { archived: !!on });
        return { ok: true, archived: !!on };
      });
    },
    async pin(s: string, on: boolean): Promise<Envelope<{ ok: boolean; pinned: boolean }>> {
      return envelope(async () => {
        await wireSessionOp(base, String(s), "pin", { pinned: !!on });
        return { ok: true, pinned: !!on };
      });
    },
    /** 추상 동사 session.remove — wire op 명만 delete 다(§5.3-23). */
    async remove(s: string): Promise<Envelope<{ ok: boolean }>> {
      const r = await envelope(() => wireSessionOp(base, String(s), "delete", {}));
      if (r.error) return { error: r.error };
      if (String(s) === session) await sessions.create();
      return { ok: true };
    },
  };

  // ── 하네스 — 동사별 capability 게이트(§5.5-29) ───────────────────────────
  const harness = {
    async info(): Promise<Envelope<{ ok: boolean; value: unknown }>> {
      if (!has("harness-info")) return unsupported("harness-info");
      return envelope(() => wireHarnessInfo(base));
    },
    async models(): Promise<Envelope<{ models: unknown[]; current: string | null }>> {
      if (!has("harness-models")) return unsupported("harness-models");
      const [r, m] = await Promise.all([envelope(() => wireHarnessModels(base)), meta()]);
      if (r.error) return { error: r.error };
      return { models: Array.isArray(r.value) ? r.value : [], current: m.model };
    },
    async commands(): Promise<Envelope<{ commands: unknown[] }>> {
      if (!has("harness-commands")) return unsupported("harness-commands");
      if (cmdCache) return { commands: cmdCache };
      const r = await envelope(() => wireHarnessCommands(base));
      if (r.error) return { error: r.error };
      cmdCache = Array.isArray(r.value) ? r.value : [];
      return { commands: cmdCache };
    },
    /** known:false 는 경고가 아니라 판정 정보다 — 저장은 되고 어댑터가 거부하면 그 턴이 실패한다. */
    async setModel(model: string | null): Promise<Envelope<{ model: string | null; known: boolean | null }>> {
      const r = await envelope(() => wireHarnessSet(base, { model: model == null ? "" : String(model) }));
      if (r.error) return { error: r.error };
      if (metaCache) metaCache.model = (r.model as string) || null;
      return { model: (r.model as string) || null, known: (r.known as boolean) ?? null };
    },
    async setEffort(level: string | null): Promise<Envelope<{ effort: string | null }>> {
      if (!has("effort")) return unsupported("effort");
      const r = await envelope(() => wireHarnessSet(base, { effort: level == null ? "" : String(level) }));
      if (r.error) return { error: r.error };
      if (metaCache) metaCache.effort = (r.effort as string) || null;
      return { effort: (r.effort as string) || null };
    },
  };

  // ── push — 턴 밖의 자발 이벤트(§5.8) ────────────────────────────────────
  // 정본은 기판의 이력이고 push 는 힌트다: 이벤트를 보고 이력을 다시 읽는다. 미구현 기판에서는
  // 다음 사용자 행위 시점의 catchUp 으로 따라잡는다 — 유휴 폴링으로 때우지 않는다.
  function armPush(): void {
    if (!has("push") || unsubscribePush) return;
    unsubscribePush = wirePushSubscribe(
      base,
      (ev: EnvelopeEvent) => {
        trackTask(ev);
        emit("progress", ev);
        // 자발 턴(백그라운드 완료가 만든 reply)과 다른 화면이 일으킨 종결 — 둘 다 이력에 앉는다.
        const settled = ev.event === "reply" || (ev.event === "turn" && ev.status === "settled");
        if (settled && observing === 0) void loadHistory();
      },
      (e: unknown) => {
        // 미배선·연속 실패를 침묵 no-op 으로 강등하지 않는다(fail-loud, §5.8).
        emit("error", errorOf(e));
      },
    );
  }

  function close(): void {
    unsubscribePush?.();
    unsubscribePush = null;
  }

  return {
    base,
    root,
    history,
    ready,
    on,
    meta,
    send,
    cancel,
    answer,
    reset,
    upload,
    fileUrl,
    sessions,
    harness,
    refresh: catchUp,
    close,
    get session() {
      return session;
    },
    get busy() {
      return busy;
    },
    get bgCount() {
      return bgTasks.size;
    },
    get capabilities() {
      return caps.slice();
    },
    get protocol() {
      return protocol;
    },
  };
}

export type Chat = ReturnType<typeof createChat>;
