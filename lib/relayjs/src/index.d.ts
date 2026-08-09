export interface ChatMessage {
  role: "user" | "bot" | "sys";
  text: string;
  files?: { name: string; path: string }[];
  /** 봉투 reply 의 토큰 장부 (bot 메시지) — 컨텍스트 게이지가 이걸 그린다 */
  usage?: TurnUsage;
  /** 실제 사용 모델 (별칭 해석 결과, bot 메시지) */
  model?: string;
}

export interface TurnUsage {
  input: number;
  output: number;
  context_window: number | null;
}

/** 세션 봉투의 진행 이벤트 — delta | tool | file | reply | error */
export interface TurnEvent {
  t?: number;
  event: string;
  text?: string;
  name?: string;
  status?: "start" | "end";
  detail?: string;
  path?: string;
  message?: string;
}

export interface ChatMeta {
  found: boolean;
  display_name: string;
  chat: { mode: "direct" | "none"; greeting?: string } | null;
  greeting: string;
  harness: unknown | null;
  model: string | null;
  /** 추론 강도 (RELAY_EFFORT) — effort capability 어댑터만 반영 */
  effort: string | null;
  /** 패키지가 선언한 에이전트 이름들 */
  agents: string[];
  /** 이 대화가 착지하는 에이전트 (명시 옵션 > 착지 에이전트, 없으면 null) */
  agent: string | null;
}

export interface ChatError {
  code: string;
  message: string;
}

export interface SessionInfo {
  slot: string;
  label: string;
  updated: number;
}

export interface HarnessVariantInfo {
  name: string;
  provider: string | null;
  icon?: string | null;
  llm_icon?: string | null;
  /** probe 일 때만 실린다 — 어댑터를 실제 실행한 결과 */
  ready?: boolean;
  /** 미준비의 축: ok | no-tool(설치 필요) | no-auth(자격 필요) */
  reason?: "ok" | "no-tool" | "no-auth";
  note?: string;
  account?: { email?: string | null; plan?: string | null; method?: string | null } | null;
  protocol?: number;
  capabilities?: string[];
  login?: boolean;
  auth?: string | null;
}

export interface ChatClient {
  pkg: string;
  readonly slot: string;
  history: ChatMessage[];
  busy: boolean;
  ready: Promise<ChatMeta>;
  on(ev: "message", fn: (m: ChatMessage) => void): () => void;
  on(ev: "busy", fn: (b: boolean) => void): () => void;
  on(ev: "session", fn: (slot: string) => void): () => void;
  on(ev: "progress", fn: (e: TurnEvent) => void): () => void;
  on(ev: "usage", fn: (u: { usage: TurnUsage | null; model: string | null }) => void): () => void;
  on(ev: "reset" | "meta" | "history", fn: (arg?: unknown) => void): () => void;
  send(
    text: string,
    opts?: { attachments?: { path: string; name?: string }[]; agent?: string; display?: string },
  ): Promise<{ reply: string } | { error: ChatError }>;
  /** 진행 중 턴 중단 — 봉투 cancel 제어 1순위, 기판이 신호 그물을 겹친다 */
  cancel(): Promise<{ ok: boolean } | { error: ChatError }>;
  upload(file: File | Blob, onProgress?: (pct: number) => void): Promise<{ path: string; size: number; name: string } | { error: ChatError }>;
  fileUrl(rel: string, dl?: boolean): string;
  reset(): Promise<{ ok: true } | { error: ChatError }>;
  meta(): Promise<ChatMeta>;
  sessions: {
    list(): Promise<{ sessions: SessionInfo[]; error?: ChatError }>;
    open(slot: string): Promise<{ slot: string }>;
    create(): { slot: string };
    rename(slot: string, label: string): Promise<{ ok: true } | { error: ChatError }>;
    remove(slot: string): Promise<{ ok: true } | { error: ChatError }>;
  };
  harness: {
    models(): Promise<{ models: string[]; current: string | null } | { error: ChatError }>;
    setModel(model: string | null): Promise<{ model: string | null; known: boolean | null } | { error: ChatError }>;
    setEffort(level: string | null): Promise<{ effort: string | null } | { error: ChatError }>;
    setup(): Promise<{ ok: boolean; out: string } | { error: ChatError }>;
    info(): Promise<{ ok: boolean; value: unknown } | { error: ChatError }>;
    commands(): Promise<{ commands: { name: string; description?: string; tty?: boolean }[]; error?: ChatError }>;
    variants(probe?: boolean): Promise<{ active: string | null; variants: HarnessVariantInfo[] } | { error: ChatError }>;
    setVariant(name: string): Promise<{ active: string; setup: { ok: boolean; out: string } } | { error: ChatError }>;
    connect(token: string): Promise<{ ok: boolean; setup: { ok: boolean; out: string } } | { error: ChatError }>;
    /** 대화형 로그인 발화 — 기판이 터미널 창을 연다 (인증은 그 창이 소유) */
    login(): Promise<{ launched: boolean; command: string; note: string } | { error: ChatError }>;
  };
}

export function createChat(opts: { pkg: string; slot?: string; agent?: string }): ChatClient;
