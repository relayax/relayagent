/*!
 * envelope-reducer.ts — 하네스 봉투(protocol 3) 이벤트 → 채팅 파트 모델.
 *
 * 입력 어휘는 docs/harness-protocol.md §Events 의 9종(delta·tool·usage·task·ask·steer·file·
 * reply·error)과 docs/client-protocol.md §6-36 의 수명주기 2종(turn started/settled)뿐이다.
 * 출력 파트 모델·TurnMeta 는 stream-json 판 Reducer(runtime.ts:129-143, 277-285)의 것을
 * 그대로 쓴다 — Chat 렌더(말풍선·타임라인·툴 카드·완료 칩·컨텍스트 미터)가 무수정으로 붙어야
 * 하기 때문이다.
 *
 * 라이브(turn.stream)와 재생(turn.attach 의 장부 재생·저장된 events.jsonl)이 **같은 리듀서**를
 * 지난다 — 두 경로가 같은 이벤트 열이라 분기가 필요 없다(구 판은 라이브 델타용 Reducer 와
 * 재생용 framesToParts 가 갈라져 있었다, runtime.ts:288-294).
 *
 * v1 판정 — 툴 인자 스트리밍 부재 수용(client-protocol §6-35): 봉투 `tool` 의 `args` 는
 * ≤2KB 완결 JSON 문자열이라 stream-json 의 input_json_delta 급 실시간 전개가 없다. 툴 카드는
 * 시작(name·detail)·대상(args)·종결(ok·result 발췌) 세 지점으로만 그린다.
 */
import type { TurnMeta } from "./runtime";
// 봉투 축의 정본 타입은 패키지 공개 선언(src/index.d.ts)에 있다 — 여기서 다시 선언하지 않는다.
// 주의: 이 리듀서는 usage 를 **두 형태로** 들고 있어야 한다. 같은 숫자의 두 소비자가 필드명이
// 다르기 때문이다 — 위젯 게이지는 봉투 이름(usage.context_window·context.window, widget.js:1754-1756)
// 을, Chat 은 Anthropic 이름(usage.output_tokens 등, Chat.tsx:1005, 2143)을 읽는다. 중복이 아니라
// 두 화면 계약 사이의 어댑터다: 봉투 원형은 settledUsage/settledContext, 투영은 meta 안에 둔다.
import type { TurnUsage, TurnContext, AskQuestion } from "../index.js";

// ── 파트 모델 (runtime.ts:129-132 과 동형) ───────────────────────────────────
// reasoning 은 봉투 어휘에 없다(어댑터가 thinking 을 흘리지 않는다 —
// packages/system/harness/claude-code/run 의 thinking_delta 는 토큰 티커만 태운다).
// 타입에는 남겨 둔다: Chat 이 리플레이된 구 데이터에서 이 파트를 그리고, 미래 어댑터가
// 봉투에 사유 이벤트를 additive 로 얹으면 여기서 채운다.

export type TextPart = { type: "text"; text: string };
export type ReasoningPart = { type: "reasoning"; text: string };
export type ToolPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: any;
  argsText: string;
  result?: any;
  isError?: boolean;
  /** 위임받은 서브에이전트의 도구 호출이면 부모 tool_use id (봉투 tool.parent). */
  parent?: string;
  /** 기판이 붙인 짧은 이름(봉투 tool.label) — 우리 문의 동사는 이름만으로 뜻이 안 서므로
   *  기판이 자기 tools/list 의 서술에서 지어 보낸다. 없으면 종전 짐작으로 떨어진다. */
  label?: string;
};
export type Part = TextPart | ReasoningPart | ToolPart;

/** TurnMeta 의 봉투 축 확장 — 전부 additive라 Chat 은 TurnMeta 로만 읽어도 무해하다. */
export type EnvelopeTurnMeta = TurnMeta & {
  /** reply.context.window — 컨텍스트 미터의 분모를 카탈로그 추정 대신 서버 실측으로. */
  contextWindow?: number | null;
  // files(무대 산출물)는 이 확장이 아니라 TurnMeta 본체에 산다 — 재생(이력의 files)도 같은
  // 자리를 채우므로 봉투 전용 축이 아니다.
  /** reply.session — 하네스 대화 포인터(표시용). */
  harnessSession?: string | null;
  /** reply.origin === "task" — 백그라운드 완료가 만든 자발 턴. */
  origin?: "task";
  /** error 이벤트의 사유. 배너 렌더는 어댑터 몫이고 리듀서는 사유만 보관한다. */
  error?: string;
};

/** 라이브 토큰 티커 — runtime.ts:948 TurnUsageLive 와 동형(RunningStatus 가 그대로 구독). */
export type TurnUsageLive = { dir: "up" | "down"; inTok: number; outTok: number };

/** 리듀서 입력 — 열린 백으로 둔다.
 *
 *  공개 선언(index.d.ts)은 스트림 입력을 3갈래로 가른다: 봉투 8종 `TurnEvent`(reply 페이로드
 *  포함) + 수명주기 2종 `TurnLifecycleEvent`(client-protocol §6-36 — 프레이밍 전담) + 미지
 *  arm `UnknownTurnEvent`(§6-37 — 불투명 진행). 리듀서는 그 합집합을 다 받아야 하고 미지
 *  이벤트를 판정 없이 흘려보내야 하므로, 좁은 유니온이 아니라 열린 백으로 소비한다. */
export type EnvelopeEvent = {
  event?: unknown;
  /** 장부 줄의 기록 시각(runner/session.ts 가 `{t, ...ev}` 로 적는다). 재생의 duration 근거. */
  t?: unknown;
  [k: string]: unknown;
};

export type ReducerOptions = {
  /** 토큰 티커. window 이벤트가 아니라 콜백인 이유: 리듀서는 DOM 을 모른다. */
  onUsage?: (u: TurnUsageLive) => void;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 봉투 usage → Anthropic 형 usage. Chat 의 완료 칩(usage.output_tokens)과 컨텍스트 미터
 *  (input_tokens + cache_read + cache_creation)가 이 필드명을 읽는다. 봉투의 `input` 은
 *  캐시 포함 합계이므로(harness-protocol.md:67) 비캐시 입력으로 되구해 합이 보존되게 한다. */
function projectUsage(u: Record<string, unknown> | null | undefined): any {
  if (!u || typeof u !== "object") return undefined;
  const total = num(u.input);
  const cacheRead = num(u.cache_read);
  const cacheCreation = num(u.cache_creation);
  return {
    input_tokens: Math.max(0, total - cacheRead - cacheCreation),
    output_tokens: num(u.output),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

/** 봉투 context(대화 점유량) → 미터가 읽는 usage 형. 점유량은 누적 청구(usage)가 아니라
 *  마지막 본류 스텝의 프롬프트 크기다 — 게이지는 context 를 쓴다(harness-protocol.md:67). */
function projectContext(c: Record<string, unknown> | null | undefined): any {
  if (!c || typeof c !== "object") return undefined;
  const input = num(c.input);
  if (input <= 0) return undefined;
  return { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

/** 네이티브 질문 카드의 도구 이름 — Chat 의 isAskTool(Chat.tsx:68-70)이 이 이름으로 ask 카드를
 *  연다. 봉투 `ask` 는 도구 호출이 아니지만(어댑터가 control 채널에서 가로챈다) 화면에서는 같은
 *  카드다 — 파트 모델을 하나로 두어 렌더가 분기하지 않게 한다. */
const ASK_TOOL = "AskUserQuestion";

/** 얹기 카드의 예약 이름. 진짜 도구가 아니다 — 어댑터가 되돌려 준 `steer` 이벤트를 리듀서가
 *  파트로 세운 것이고, 파트 모델을 하나로 두는 것은 ask 와 같은 판정이다(렌더가 분기하지
 *  않는다). 도구 이름 문법(§8-41 `a2a__`·`edge__`·`mcp__`)과 겹치지 않는 접두를 쓴다. */
export const STEER_TOOL = "__steer";

export class EnvelopeReducer {
  parts: Part[] = [];
  meta: EnvelopeTurnMeta = {};
  /** 이 관찰이 붙은 턴/세션 — 수명주기 `turn started` 의 에코. */
  turnId = "";
  sessionId = "";
  /** settled 수신 여부. false 인 채 스트림이 끝나면 절단이다(client-protocol §5.2-20). */
  settled = false;
  /** 미완 백그라운드 작업 — 턴이 끝나도 남아 있으면 자발 턴이 뒤따른다. */
  tasks = new Map<string, string>();
  /** 답변 대기 중인 ask id. */
  pendingAsk = "";
  /** reply 가 말한 종결 본문 — 이력 착지의 정본. */
  settledText = "";
  /** 봉투 원형 그대로의 종결 장부 — 이력 메시지(ChatMessage.usage/context)와 게이지가 읽는 축.
   *  meta.usage 는 Chat 용 투영이라 이 자리에 쓰면 안 된다: 기판이 이력에 적는 값도 봉투 이름이라
   *  투영을 앉히면 같은 턴이 새로고침 전후로 다른 모양이 된다(게이지가 라이브에서만 꺼진다). */
  settledUsage?: TurnUsage;
  settledContext?: TurnContext;

  private opts: ReducerOptions;
  private textIdx = -1;
  private toolPos: Record<string, number> = {};
  private startedAt = 0;
  private lastT = 0;
  // 티커 — 봉투 usage 는 어댑터가 이미 250ms 스로틀한 값이라(harness-protocol.md:62)
  // 클라이언트가 다시 추정하지 않는다. 방향만 가린다.
  private inTok = 0;
  private outTok = 0;
  /** 얹기 파트의 순번 — 장부 순서 기반이라 재생이 라이브와 같은 id 를 만든다 */
  private steerSeq = 0;

  constructor(opts: ReducerOptions = {}) {
    this.opts = opts;
  }

  private text(): TextPart {
    const cur = this.parts[this.textIdx];
    if (this.textIdx >= 0 && cur && cur.type === "text") return cur;
    const p: TextPart = { type: "text", text: "" };
    this.parts.push(p);
    this.textIdx = this.parts.length - 1;
    return p;
  }

  private tool(id: string, name?: string): ToolPart {
    const pos = this.toolPos[id];
    if (pos != null) return this.parts[pos] as ToolPart;
    const p: ToolPart = { type: "tool-call", toolCallId: id, toolName: name || "tool", args: {}, argsText: "" };
    this.parts.push(p);
    this.toolPos[id] = this.parts.length - 1;
    this.textIdx = -1; // 도구가 현재 텍스트 런을 끊는다 — 다음 delta 는 새 파트
    return p;
  }

  push(raw: EnvelopeEvent | null | undefined): void {
    if (!raw || typeof raw !== "object") return;
    const ev = raw as Record<string, unknown>;
    const name = str(ev.event);
    if (!name) return;
    if (typeof ev.t === "number") this.lastT = ev.t;
    switch (name) {
      case "turn": return this.lifecycle(ev);
      case "delta": return this.delta(ev);
      case "tool": return this.toolEvent(ev);
      case "usage": return this.usage(ev);
      case "task": return this.task(ev);
      case "ask": return this.ask(ev);
      case "steer": return this.steer(ev);
      case "file": return this.file(ev);
      case "reply": return this.reply(ev);
      case "error": return this.error(ev);
      // 미지의 event 는 그리지 않되 E_PROTOCOL 로 승격하지도 않는다 — 하네스 축은 additive 로
      // 자란다(client-protocol §6-37). 불투명 진행으로 흘려보낸다.
      default: return;
    }
  }

  private lifecycle(ev: Record<string, unknown>): void {
    const status = str(ev.status);
    if (status === "started") {
      this.turnId = str(ev.turn) || this.turnId;
      this.sessionId = str(ev.session) || this.sessionId;
      this.startedAt = typeof ev.t === "number" ? ev.t : Date.now();
      return;
    }
    if (status !== "settled") return;
    this.settled = true;
    this.turnId = str(ev.turn) || this.turnId;
    // 의미적 종결은 reply/error 가 이미 찍었다 — 수명주기는 프레이밍만 담당한다
    // (client-protocol §6-36). 둘 다 없이 settled 만 온 턴에서만 ok 로 판정을 메운다.
    if (!this.meta.ended) this.meta.ended = ev.ok === false ? "error" : "ok";
    this.stampDuration(typeof ev.t === "number" ? ev.t : 0);
  }

  private delta(ev: Record<string, unknown>): void {
    const text = str(ev.text);
    if (!text) return;
    this.text().text += text;
  }

  private toolEvent(ev: Record<string, unknown>): void {
    const id = str(ev.id);
    if (!id) return;
    const status = str(ev.status);
    if (status === "start") {
      const card = this.tool(id, str(ev.name) || "tool");
      const argsText = str(ev.args);
      if (argsText) {
        card.argsText = argsText;
        // args 는 ≤2KB 로 잘려 올 수 있다 — 잘린 JSON 은 파싱 불능이고, 그때 카드의 "대상"이
        // 통째로 비어 무슨 도구가 무엇에 대해 돌았는지 화면에서 사라진다. detail(≤200자)이
        // 어댑터가 고른 바로 그 대상이므로 표시용 축으로 세운다(stepMeta 의 description 축).
        try {
          card.args = JSON.parse(argsText);
        } catch {
          const detail = str(ev.detail);
          card.args = detail ? { description: detail } : {};
        }
      } else {
        const detail = str(ev.detail);
        card.args = detail ? { description: detail } : {};
        card.argsText = "";
      }
      const parent = str(ev.parent);
      if (parent) card.parent = parent;
      const label = str(ev.label);
      if (label) card.label = label;
      return;
    }
    if (status !== "end") return;
    const pos = this.toolPos[id];
    // start 없이 온 end 는 카드를 새로 열어 받는다 — 재생이 중간부터 시작된 경우에도
    // 결과가 증발하지 않게(장부는 처음부터 재생되지만 상한 절단이 있을 수 있다).
    const card = pos != null ? (this.parts[pos] as ToolPart) : this.tool(id, str(ev.name) || "tool");
    card.result = str(ev.result);
    card.isError = ev.ok === false;
  }

  private usage(ev: Record<string, unknown>): void {
    this.inTok = num(ev.input);
    this.outTok = num(ev.output);
    // 방향: 출력이 아직 없으면 올려보내는 중(↑), 나오기 시작하면 생성 중(↓).
    const dir: "up" | "down" = this.outTok > 0 ? "down" : "up";
    this.opts.onUsage?.({ dir, inTok: this.inTok, outTok: this.outTok });
  }

  private task(ev: Record<string, unknown>): void {
    const id = str(ev.id);
    if (!id) return;
    if (str(ev.status) === "started") this.tasks.set(id, str(ev.note));
    else this.tasks.delete(id);
  }

  private ask(ev: Record<string, unknown>): void {
    const id = str(ev.id);
    if (!id) return;
    const card = this.tool(id, ASK_TOOL);
    const questions: AskQuestion[] = Array.isArray(ev.questions) ? (ev.questions as AskQuestion[]) : [];
    card.args = { questions };
    try {
      card.argsText = JSON.stringify(card.args, null, 2);
    } catch {
      card.argsText = "";
    }
    this.pendingAsk = id;
  }

  /**
   * 얹기 — 턴이 도는 중에 사용자가 더한 발화(§5.1-16-a). 어댑터가 **얹힌 직후에** 증언하므로
   * 이 파트는 말이 실제로 들어간 자리(도구 호출 사이)에 앉는다. 카드를 여는 것이 진행 중
   * 텍스트 런을 끊는데, 그게 맞다 — 화면의 순서가 대화의 순서다.
   *
   * id 는 장부 순서에서 결정론적으로 나온다: 라이브와 재생이 같은 열을 지나므로 같은 파트가
   * 선다(리듀서 단일 판정). 봉투가 id 를 주지 않는 이유이기도 하다 — 셀 것이 순서뿐이다.
   */
  private steer(ev: Record<string, unknown>): void {
    const text = str(ev.text);
    if (!text) return;
    const card = this.tool(`steer#${this.steerSeq++}`, STEER_TOOL);
    card.args = { text };
    card.argsText = text;
  }

  /** ask 회송 성공을 카드에 반영한다 — 봉투에는 답변 이벤트가 없으므로(회송은 stdin 제어)
   *  이 전이만은 클라이언트가 찍는다. 결과가 있어야 카드가 대기 상태를 푼다. */
  settleAsk(id: string, answers: unknown): void {
    const pos = this.toolPos[id];
    if (pos == null) return;
    const card = this.parts[pos] as ToolPart;
    try {
      card.result = JSON.stringify(answers);
    } catch {
      card.result = "";
    }
    if (this.pendingAsk === id) this.pendingAsk = "";
  }

  private file(ev: Record<string, unknown>): void {
    const p = str(ev.path);
    if (!p) return;
    const files = this.meta.files ?? (this.meta.files = []);
    if (!files.includes(p)) files.push(p);
  }

  private reply(ev: Record<string, unknown>): void {
    const text = str(ev.text);
    this.settledText = text.trim();
    this.landText(text);
    const usage = ev.usage as Record<string, unknown> | undefined;
    const context = ev.context as Record<string, unknown> | undefined;
    if (usage) this.settledUsage = usage as unknown as TurnUsage;
    if (context) this.settledContext = context as unknown as TurnContext;
    this.meta.usage = projectUsage(usage);
    this.meta.contextUsage = projectContext(context);
    this.meta.contextWindow = num(context?.window) || num(usage?.context_window) || null;
    if (typeof usage?.cost_usd === "number") this.meta.costUsd = usage.cost_usd;
    const model = str(ev.model);
    if (model) this.meta.model = model;
    this.meta.harnessSession = str(ev.session) || null;
    if (str(ev.origin) === "task") this.meta.origin = "task";
    this.meta.ended = "ok";
    this.stampDuration(typeof ev.t === "number" ? ev.t : 0);
  }

  private error(ev: Record<string, unknown>): void {
    this.meta.error = str(ev.message) || "하네스 오류";
    this.meta.ended = "error";
    this.stampDuration(typeof ev.t === "number" ? ev.t : 0);
  }

  /** reply.text 와 흘러온 delta 의 합류. delta 는 같은 답변의 조각이므로 기본은 유지고,
   *  reply 가 더 많이 말하는 경우만 반영한다 — 어댑터가 앞에 붙이는 안내(대화 만료 후 새
   *  대화 시작 등)는 델타로 흐르지 않아 여기서만 화면에 닿는다. */
  private landText(text: string): void {
    const t = text.trim();
    if (!t) return;
    const runs: TextPart[] = this.parts.filter((p): p is TextPart => p.type === "text");
    const streamed = runs.map((p) => p.text).join("").trim();
    if (!streamed) {
      this.text().text = text;
      this.textIdx = -1;
      return;
    }
    if (t === streamed) return;
    if (t.endsWith(streamed)) {
      // 접두만 다르다 = 델타 앞에 붙은 안내 — 첫 런 앞에 얹는다(멱등: 두 번 접어도 같다).
      runs[0].text = t.slice(0, t.length - streamed.length) + runs[0].text;
      return;
    }
    // 그 외에는 마지막 런을 최종 문장으로 덮는다 — 부분 델타보다 종결 본문이 정본이다.
    runs[runs.length - 1].text = text;
    this.textIdx = -1;
  }

  private stampDuration(t: number): void {
    if (typeof this.meta.durationMs === "number") return;
    const end = t || this.lastT || Date.now();
    // 장부 재생은 기록 시각(t)으로, 라이브는 벽시계로 잰다. started 를 못 본 관찰
    // (중간 attach)에서는 재지 않는다 — 없는 값이 0초로 보이면 안 된다.
    if (this.startedAt > 0 && end > this.startedAt) this.meta.durationMs = end - this.startedAt;
  }

  /** 사용자 중단 — 봉투는 취소와 실패를 구분하지 않으므로(어댑터는 error + exit 130)
   *  중단을 아는 쪽은 interrupt 를 부른 클라이언트뿐이다. */
  markCancelled(): void {
    this.meta.ended = "cancelled";
  }

  /** settled 없이 스트림이 끝났다 — 서버 턴은 계속 돌 수 있다(client-protocol §5.2-20).
   *  성공으로 위장하지 않고 '미완료'로 남긴다. */
  markCut(): void {
    if (this.meta.ended !== "ok") this.meta.ended = "cut";
  }

  /** 미완 백그라운드 수 — 유휴 중 자발 턴을 기다릴 근거(구 core.js bgCount 의 후계). */
  get backgroundCount(): number {
    return this.tasks.size;
  }

  /** 이력에 앉힐 본문. 종결이 말한 문장이 1순위다 — 기판도 같은 값을 이력에 적으므로
   *  (runner/session.ts 의 appendBot(ev.text)), 델타 런을 이어붙인 값을 쓰면 새로고침 전후로
   *  같은 턴이 다르게 보인다. 종결을 못 본 관찰에서만 흘러온 조각으로 대신한다. */
  get replyText(): string {
    if (this.settledText) return this.settledText;
    return this.parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("").trim();
  }

  /** 렌더가 소비하는 파트 배열. 호출마다 새 배열·새 카드 객체 — 소비자가 이전 스냅샷과
   *  참조 동일성으로 비교해도 갱신을 놓치지 않는다. */
  snapshot(): Part[] {
    return this.parts.map((p) => {
      if (p.type === "text") return { type: "text", text: p.text } as TextPart;
      if (p.type === "reasoning") return { type: "reasoning", text: p.text } as ReasoningPart;
      const card: ToolPart = {
        type: "tool-call",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args || {},
        argsText: p.argsText || "",
        result: p.result,
        isError: p.isError,
      };
      if (p.parent) card.parent = p.parent;
      return card;
    });
  }
}

/**
 * reduceEnvelope — 이벤트 열 한 벌을 파트+메타로 접는다(장부 재생 진입점).
 * 라이브 스트림과 같은 리듀서를 지나므로 재생 결과와 라이브 결과가 정의상 같다.
 * 종결 이벤트가 없는데 내용은 있으면 '미완료'다 — 중도에 끊긴 턴이 조용히 완료처럼
 * 보이면 안 된다(runtime.ts:338-340 의 판정 계승).
 */
export function reduceEnvelope(
  events: readonly EnvelopeEvent[],
  opts: ReducerOptions = {},
): { parts: Part[]; meta: EnvelopeTurnMeta } {
  const r = new EnvelopeReducer(opts);
  for (const ev of events || []) r.push(ev);
  const parts = r.snapshot();
  if (!r.meta.ended && parts.length > 0) r.markCut();
  return { parts, meta: r.meta };
}
