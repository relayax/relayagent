// index.d.ts — @relay/relayjs 공개 선언(클라이언트 계약 v1 — docs/client-protocol.md).
// 실구현 정본은 src/client.ts(신 SDK)·src/chat/transport.ts(wire)·src/chat/envelope-reducer.ts.
// 구 core.js 표면(pkg/slot 좌표, 하네스 관리 동사 setup/variants/connect/login* — 계약 밖,
// client-protocol §5.5-31)의 선언은 이 세대에서 은퇴했다.

// ── 봉투 축 타입 (하네스 protocol 3 — harness-protocol.md:55-68 이 정본) ──────

export interface ChatMessage {
  role: "user" | "bot" | "sys";
  text: string;
  files?: { name?: string; path: string }[];
  /** 봉투 reply 의 토큰 장부 (bot 메시지) — 턴의 청구 합계 */
  usage?: TurnUsage;
  /** 봉투 reply 의 context — 대화 점유량 (bot 메시지). 컨텍스트 게이지는 usage 가 아니라 이걸 그린다 */
  context?: TurnContext;
  /** 실제 사용 모델 (별칭 해석 결과, bot 메시지) */
  model?: string;
}

export interface TurnUsage {
  input: number;
  output: number;
  context_window: number | null;
  /** 캐시 분해 (additive) — 비캐시 input = input − cache_read − cache_creation */
  cache_read?: number;
  cache_creation?: number;
  /** CLI 자기 정산액 (USD) — 보고하는 어댑터만 싣는다 */
  cost_usd?: number;
}

/** 봉투 reply 의 context {input, window} — 대화 점유량(마지막 메인라인 상태). 게이지의 정본 */
export interface TurnContext {
  input: number | null;
  window: number | null;
}

/** ask 이벤트의 질문 하나 — 답은 answer() 의 { question, selected[] } 로 돌아간다 */
export interface AskQuestion {
  question?: string;
  options?: (string | { label: string; description?: string })[];
  multiSelect?: boolean;
}

// ── 스트림 이벤트 — 3갈래 합(client-protocol §6) ─────────────────────────────
// turn.stream / turn.attach / push 에 실리는 이벤트는 ① 클라이언트 수명주기 2종(닫힌 목록,
// §6-36) ② 하네스 봉투 8종(§6-35) ③ 미지 이벤트(불투명 arm, §6-37)다. 미지의 event 값은
// 렌더하지 않되 E_PROTOCOL 로 승격하지도 않는다 — 하네스 축은 additive 로 자란다.

/** 하네스 봉투 진행 이벤트 — protocol 3 의 닫힌 8종. 필드 정본은 harness-protocol.md:55-68 */
export interface TurnEvent {
  t?: number;
  event: "delta" | "tool" | "usage" | "task" | "ask" | "file" | "reply" | "error";
  /** delta 의 조각 · reply 의 종결 본문 */
  text?: string;
  /** tool 짝맞춤·task·ask 식별자 */
  id?: string;
  name?: string;
  /** tool: "start" | "end" · task: "started" | "done" */
  status?: "start" | "end" | "started" | "done";
  detail?: string;
  /** tool start 의 인자 요약 (JSON 문자열, ≤2KB) */
  args?: string;
  /** tool end · task done 의 성패 */
  ok?: boolean;
  /** tool end 의 결과 발췌 (≤8KB) */
  result?: string;
  /** 위임 서브에이전트 도구 호출의 부모 tool_use id */
  parent?: string;
  /** task started 의 짧은 설명 */
  note?: string;
  /** ask 의 질문 목록 */
  questions?: AskQuestion[];
  /** file 이벤트의 무대 상대 경로 */
  path?: string;
  /** error 의 사유 */
  message?: string;
  /** usage(라이브 티커) 이벤트의 실측 — reply.usage 와 별개 자리다 */
  input?: number;
  output?: number;
  /** reply 페이로드 — 턴 종결 장부(harness-protocol.md:67) */
  session?: string;
  model?: string;
  usage?: TurnUsage;
  context?: TurnContext;
  /** reply.origin === "task" — 백그라운드 완료가 만든 자발 턴 */
  origin?: "task";
}

/** 클라이언트 계약 v1 의 수명주기 이벤트(§6-36) — 닫힌 2종. 의미가 아니라 프레이밍(절단 대
 *  종결의 판별)만 담당한다: settled 없는 EOF 는 E_DISCONNECTED 다(§5.2-20) */
export type TurnLifecycleEvent =
  | { t?: number; event: "turn"; status: "started"; turn: string; session: string }
  | { t?: number; event: "turn"; status: "settled"; turn: string; ok: boolean };

/** 미지 이벤트 — 불투명 진행으로 취급한다(§6-37). E_PROTOCOL 승격 금지 */
export type UnknownTurnEvent = { event: string; t?: number; [k: string]: unknown };

/** 스트림 입력 전량 — 수명주기 2종 + 봉투 8종 + 미지 arm */
export type TurnStreamEvent = TurnLifecycleEvent | TurnEvent | UnknownTurnEvent;

// ── SDK 표면 (src/client.ts createChat) ──────────────────────────────────────

export interface ChatError {
  code: string;
  message: string;
}

/** no-throw 봉투(§5.0-9) — 실패는 항상 { error } 로 돌아온다 */
export type Envelope<T> = (T & { error?: undefined }) | { error: ChatError };

export interface FileRef {
  name?: string;
  /** file.upload 가 돌려준 불투명 참조(§5.4-25) — 검사·조립 금지 */
  path: string;
}

export interface SessionRow {
  session: string;
  label?: string;
  updated?: number;
  /** 보관함에 들어간 세션 — 이력은 유지, 기본 목록에서만 빠진다 */
  archived?: boolean;
  /** 고정된 세션 — 목록 맨 위로 정렬된다 */
  pinned?: boolean;
}

/** instances.list(§5.6-32 닫힌 shape)에서 조립한 메타. agent 는 서버 착지 판정 결과(§8-42) */
export interface ChatMeta {
  found: boolean;
  display_name: string;
  icon: string;
  greeting: string;
  model: string | null;
  effort: string | null;
  agents: string[];
  agent: string | null;
}

export interface CreateChatOptions {
  /** 대화 스코프의 뿌리(§2-6 주입 좌표). 마운트 문법(/pkg/·/i/) 조립은 계약 위반 */
  base: string;
  /** 열거 동사(instances.list)의 뿌리. 없으면 meta 는 기본값으로 남는다 */
  root?: string;
  /** 이 대화가 사는 인스턴스 id — instances.list 에서 자기 행을 찾는 키 */
  instance?: string;
  /** 명시 에이전트. 없으면 서버 판정(instances.list 의 agent)을 쓴다 */
  agent?: string | null;
  /** 이어서 열 세션. 없으면 개막에서 session.create 로 발급받는다(§5.3-22) */
  session?: string;
}

export interface SendOptions {
  attachments?: FileRef[];
  /** 화면에 그릴 원문(@멘션 포함) — 프롬프트와 다를 수 있다 */
  display?: string;
  agent?: string;
  /** 화면 맥락 스냅샷 — 합성은 기판 몫. 프롬프트 서문으로 붙고 이력에는 원문만 남는다(§5.1-12) */
  scene?: string;
}

export interface ChatClient {
  readonly base: string;
  readonly root: string;
  history: ChatMessage[];
  /** 개막(capabilities 판정 §3-7) — 구 기판·버전 불일치는 { error: E_PROTOCOL } */
  ready: Promise<Envelope<{ protocol: number; capabilities: string[] }>>;
  /** 현재 세션 id — 기판 발급 불투명 문자열(§5.3-22) */
  readonly session: string;
  readonly busy: boolean;
  /** 봉투 task 이벤트로 추적 중인 미결 백그라운드 작업 수 */
  readonly bgCount: number;
  /** 개막이 받은 capabilities 사본(§7 닫힌 어휘) */
  readonly capabilities: string[];
  /** 개막이 받은 계약 버전(현재 1) */
  readonly protocol: number;

  on(ev: "message", fn: (m: ChatMessage) => void): () => void;
  on(ev: "busy", fn: (b: boolean) => void): () => void;
  on(ev: "meta", fn: (m: ChatMeta) => void): () => void;
  on(ev: "history" | "reset", fn: () => void): () => void;
  on(ev: "session", fn: (session: string) => void): () => void;
  /** 턴 개설 에코 — 신 SDK 는 {turn, session} 을 방출한다(구 코어의 {remaining} 큐 어휘는
   *  클라이언트 큐 은퇴와 함께 소멸 — 직렬화는 기판 몫, §5.1-12) */
  on(ev: "turn", fn: (t: { turn: string; session: string }) => void): () => void;
  /** 스트림 이벤트 원본(수명주기·봉투·미지 3갈래 그대로) */
  on(ev: "progress", fn: (e: TurnStreamEvent) => void): () => void;
  /** 진행 중 턴의 파트 스냅샷(리듀서 출력 — 렌더 소비용) */
  on(ev: "parts", fn: (parts: unknown[]) => void): () => void;
  /** 라이브 토큰 티커(봉투 usage 이벤트의 중계) */
  on(ev: "tick", fn: (u: { dir: "up" | "down"; inTok: number; outTok: number }) => void): () => void;
  /** 종결 집계 — 이력에 앉는 봉투 원형 */
  on(ev: "usage", fn: (u: { usage: TurnUsage | null; model: string | null; context: TurnContext | null }) => void): () => void;
  /** 계약 판정·push 실패의 fail-loud 표면(§5.8) */
  on(ev: "error", fn: (e: ChatError) => void): () => void;

  meta(): Promise<ChatMeta>;
  send(text: string, opts?: SendOptions): Promise<Envelope<{ reply: string }>>;
  /** 진행 중 턴 중단 — 봉투 cancel 제어로 전달된다(§5.1-15) */
  cancel(): Promise<Envelope<{ ok: boolean }>>;
  /** ask(질문) 회송 — 봉투 ask 이벤트의 답(§5.1-16). 빈 answers = 사용자 취소 */
  answer(id: string, answers: { question: string; selected: string[] }[]): Promise<Envelope<{ ok: boolean }>>;
  /** 하네스 대화 포인터만 끊는다 — 이력은 남는다(§5.3-23) */
  reset(): Promise<Envelope<{ ok: boolean }>>;
  upload(file: File, onProgress?: (pct: number) => void): Promise<Envelope<FileRef & { size: number }>>;
  fileUrl(path: string, dl?: boolean): string;
  /** push 없는 기판의 따라잡기 — 다음 사용자 행위 시점의 history.get(§5.8). 폴링이 아니다 */
  refresh(): Promise<unknown>;
  /** push 구독 해지 등 정리 */
  close(): void;

  sessions: {
    list(): Promise<Envelope<{ sessions: SessionRow[] }>>;
    /** wire 동사가 아니라 history.get + (busy 면) turn.attach 의 클라이언트 합성(§4) */
    open(session: string): Promise<Envelope<{ session: string }>>;
    /** 세션 id 는 기판이 발급하는 불투명 문자열(§5.3-22) — 로컬 발급 은퇴 */
    create(): Promise<Envelope<{ session: string }>>;
    /** 빈 문자열 = 자동 라벨로 복귀(§5.3-23) */
    rename(session: string, label: string): Promise<Envelope<{ ok: boolean }>>;
    /** 보관(on=true)/복원(on=false) — 이력은 그대로, 목록의 자리만 옮긴다 */
    archive(session: string, on: boolean): Promise<Envelope<{ ok: boolean; archived: boolean }>>;
    /** 고정(on=true)/해제(on=false) — 목록 맨 위로 */
    pin(session: string, on: boolean): Promise<Envelope<{ ok: boolean; pinned: boolean }>>;
    /** 추상 동사 session.remove — wire op 명만 delete 다(§5.3-23) */
    remove(session: string): Promise<Envelope<{ ok: boolean }>>;
  };

  /** 조회 동사는 각각 동명 capability 뒤(§5.5-29) — 미선언 기판은 E_UNSUPPORTED 봉투.
   *  관리 동사(variants 전환·setup·connect·login 중계)는 계약 밖이라 이 표면에 없다(§5.5-31) */
  harness: {
    info(): Promise<Envelope<{ ok: boolean; value: unknown }>>;
    models(): Promise<Envelope<{ models: unknown[]; current: string | null }>>;
    commands(): Promise<Envelope<{ commands: unknown[] }>>;
    /** known:false 는 경고가 아니라 판정 정보 — 저장은 되고 어댑터가 거부하면 그 턴이 실패(§5.5-30) */
    setModel(model: string | null): Promise<Envelope<{ model: string | null; known: boolean | null }>>;
    /** capability effort 뒤(§7) */
    setEffort(level: string | null): Promise<Envelope<{ effort: string | null }>>;
  };
}

export function createChat(opts: CreateChatOptions): ChatClient;

export type { ClassValue } from "./ui.js";
export { cn } from "./ui.js";
