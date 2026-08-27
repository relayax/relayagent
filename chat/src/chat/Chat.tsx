/*!
 * Chat.tsx — RelayOS live agent chat, composed from assistant-ui primitives and styled with the
 * RelayOS chat tokens (builder-ux 프로토타입 룩 — teal 억양·쿨그레이 램프). assistant-ui gives
 * the runtime: streaming, auto-scroll, message lifecycle. We supply the look: 내레이션 산문(잉크)
 * 과 대비되는 보더리스 스텝 타임라인, TodoWrite 플랜 카드, 스폰 내레이션, 마크다운 본문.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useMessage,
  useThread,
  useThreadRuntime,
  ThreadPrimitive,
} from "@assistant-ui/react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { RelayCtx, ReplayMessage } from "./runtime";
import { makeAdapter, getCtx, loadHistory, loadActiveTurn, setAttachTurn, takeConversationCancelled, watchServerTurns, injectedCoords } from "./runtime";
import type { ActiveTurn } from "./runtime";
import { displayBinding } from "./routematch";
import { RelayCtxContext, ActivePaneCtx, useAuthWatch } from "./ctx";
import { isAskTool } from "./parts";
import { HistorySkeleton } from "./Trace";
import { ChatHeader } from "./Menus";
import { UserMessage, AssistantMessage } from "./Messages";
import { Composer, AttachOnMount } from "./Composer";
// shadcn 프리미티브(base-ui) — 버튼·배지·입력·팝오버. 룩은 Tailwind 변형이 칠하고, 배치가 필요한
// 자리는 기존 rc-* 클래스를 함께 단다(chat.css 는 레이어 밖이라 배치 규칙이 항상 이긴다).
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import {
  MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerButton,
} from "@/components/ui/message-scroller";

// 영역 파일로 옮긴 셸 공용 컨텍스트 — ChatTabs 등 바깥 임포터는 계속 "./Chat" 에서 읽는다.
export { OpenConversationCtx, PaneTargetCtx, type PaneTarget } from "./ctx";

/** 서버 스폰 턴(schedule_wakeup 재진입·📬 위임 완료 배달)의 라이브 반영 — 이 클라이언트가
 *  시작하지 않은 턴을 발견하면 재부착한다. 부착 후 렌더는 AttachOnMount 와 동일 기계 —
 *  "생각 중" 스트리밍부터 완료까지 그대로 흐른다.
 *
 *  발견 계기(§5.8 — 상시 폴링 금지, 구 3.5초 setInterval 은퇴):
 *   · push 선언 기판 — push.subscribe 공유 커넥션의 이벤트마다 프로브(watchServerTurns).
 *   · push 미선언 기판 — 문서 visibility 복귀·창 포커스·사용자 행위(pointerdown/keydown)
 *     시점의 history.get 1회 프로브로 따라잡는다("다음 사용자 행위 시점 따라잡기").
 *  프로브는 idle 일 때만 산다(스트리밍 중 불필요) + 최소 간격 스로틀로 행위 연타를 흡수한다. */
function ServerTurnWatch({ ctx, attach }: { ctx: RelayCtx; attach: ActiveTurn | null }) {
  const rt = useThreadRuntime();
  const running = useThread((t) => t.isRunning);
  // 마운트 재부착분(AttachOnMount)과 중복 부착 방지 + 같은 턴 재발견 no-op.
  const seen = useRef<string>(attach?.turnId ?? "");
  useEffect(() => {
    if (running) return;
    let alive = true;
    let inflight = false;
    let last = 0;
    // 이 idle 진입이 사용자 Stop 로 인한 것이면(abort 리스너가 동기적으로 표시), 첫 프로브는
    // interrupt 레이스로 아직 반환되는 그 좀비 턴을 재부착하지 않는다(=같은 프롬프트 재전송 방지).
    // 첫 프로브 완료 후 무장 해제 — 이후 프로브는 진짜 서버 스폰 턴을 정상 포착한다.
    let skipCancelled = takeConversationCancelled(ctx.conversationId);
    const probe = async () => {
      if (!alive || inflight) return;
      const now = Date.now();
      if (now - last < 1500) return; // 행위 연타 흡수 — 프로브는 계기당 1회면 충분하다
      last = now;
      inflight = true;
      try {
        const act = await loadActiveTurn(ctx).catch(() => null);
        if (!alive) return;
        const skipThis = skipCancelled;
        skipCancelled = false; // interrupt 가 빨라 act=null 이어도 첫 프로브에서 해제
        if (!act || act.turnId === seen.current) return;
        if (skipThis) { seen.current = act.turnId; return; }
        seen.current = act.turnId;
        setAttachTurn(act);
        rt.append({ role: "user", content: [{ type: "text", text: act.prompt }] });
      } finally {
        inflight = false;
      }
    };
    void probe(); // idle 진입 즉시 1회 — 발화 직후 종결·재진입 레이스 커버
    const unwatch = watchServerTurns(ctx, () => void probe()); // push 있으면 이벤트가 계기
    const onVis = () => { if (!document.hidden) void probe(); };
    const onFocus = () => void probe();
    const onAct = () => void probe();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onAct, true);
    window.addEventListener("keydown", onAct, true);
    return () => {
      alive = false;
      unwatch();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onAct, true);
      window.removeEventListener("keydown", onAct, true);
    };
  }, [running, ctx.conversationId, rt]);
  return null;
}

// ── 데스크 탭 상태 (멀티 에이전트 데스크 — Desk.tsx 소비) ────────────────────────
//
// keep-alive 페인마다 이 리포터가 붙어, 백그라운드 탭도 실행 상태를 탭 뱃지로 계속 알린다.
// 질문 대기(ask)는 미응답 AskUserQuestion tool-call 로 판정 — 그 도구가 턴을 블록하므로
// 항상 running 중에 온다(우리가 stdio can_use_tool 채널로 회송하는 그 질문 카드).

export type DeskTurnStatus = "idle" | "running" | "ask";

/** 최신 assistant 메시지에 미응답 AskUserQuestion(tool-call·결과 없음)이 있는가. */
function hasPendingAsk(messages: readonly any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    for (const p of content) {
      if (p?.type === "tool-call" && isAskTool(p.toolName) && p.result === undefined && !p.isError) return true;
    }
    return false; // 최신 assistant 메시지만 — 블록 중이라 그 뒤엔 아무 것도 없다
  }
  return false;
}

/** 탭 뱃지용 상태 리포터 — 원시값(문자열) selector 라 t.messages identity 변화에 안전
 *  (배열을 구독하면 빈 스레드에서 무한 렌더 — ScrollItem 주석 참조). 전이 시에만 보고. */
function TurnStatusReporter({ onStatus }: { onStatus?: (s: DeskTurnStatus) => void }) {
  const status = useThread((t): DeskTurnStatus =>
    !t.isRunning ? "idle" : hasPendingAsk(t.messages) ? "ask" : "running");
  const prev = useRef<DeskTurnStatus | null>(null);
  useEffect(() => {
    if (prev.current === status) return;
    prev.current = status;
    onStatus?.(status);
  }, [status, onStatus]);
  return null;
}

/** 스크롤 항목 래퍼 — MessageScroller 는 Content 의 **직계 자식**만 항목으로 센다(data-message-id).
 *  ThreadPrimitive.Messages 는 래퍼 DOM 없이 컴포넌트를 바로 그리므로, 여기서 Item 으로 한 겹 감싼다.
 *  user 메시지는 scrollAnchor — 새 질문이 오면 그 질문을 뷰포트 상단에 앉히고(하단 스페이서로 자리
 *  확보), 답이 스트리밍되는 동안 그 자리에 머문다(ChatGPT 식). 예전의 CSS sticky(.is-pinned) +
 *  AnchorController(DOM 클래스 토글)는 은퇴 — Item 래퍼 안에서는 sticky 가 움직일 공간이 없다.
 *
 *  주의: t.messages 같은 배열을 구독하면 안 된다 — @assistant-ui 는 selector 결과를 Object.is 로
 *  비교하는데 빈 스레드에선 매 스냅샷 새 [] 라 무한 재렌더(React #185). 원시값(id)만 구독한다. */
function ScrollUserMessage() {
  const id = useMessage((m) => m.id);
  return <MessageScrollerItem messageId={id} scrollAnchor><UserMessage /></MessageScrollerItem>;
}
function ScrollAssistantMessage() {
  const id = useMessage((m) => m.id);
  return <MessageScrollerItem messageId={id}><AssistantMessage /></MessageScrollerItem>;
}
// ThreadPrimitive.Messages 는 components 의 identity 로 memo 한다 — 모듈 상수로 고정.
const SCROLL_COMPONENTS = { UserMessage: ScrollUserMessage, AssistantMessage: ScrollAssistantMessage };

/** 빈 시작 화면 — 이 대화가 무엇을 위한 것인지 한 줄로. "무엇이든 물어보세요"는 에이전트를
 *  손보는 대화(agent-builder)인지 알 수 없었고, 슬래시 칩(/packages·/compact…)은 시작에 도움이
 *  안 됐다 — 둘 다 은퇴. 바인딩된 에이전트가 있으면 그 이름으로 안내한다. */
function EmptyStarter({ ctx }: { ctx: RelayCtx }) {
  const bind = displayBinding(ctx.conversationId);
  const builder = bind.agent === "agent-builder";
  const creating = builder && !bind.param; // 손볼 패키지가 없는 빌더 = 새로 만드는 자리
  const onDraft = injectedCoords().draft;
  const title = creating ? "무엇을 만들까요?"
    : builder ? `${bind.param} 에이전트를 손보는 대화`
    : onDraft ? "수정본과 대화 중 · 아직 적용 전"
    : bind.agent ? `${bind.agent} 와의 대화` : "무엇이든 물어보세요";
  const hint = creating
    ? "하고 싶은 일을 한 줄로 적어 주세요. 아래 예시를 누르면 입력칸에 채워져요."
    : builder
    ? "바꾸고 싶은 것을 적어 주세요. 성격, 기능, 스케줄, 연결 무엇이든 됩니다. 적용을 누르기 전까지 실제 에이전트는 바뀌지 않아요."
    : onDraft ? "수정본으로 대화 중입니다. 마음에 들면 위의 [적용]을 누르세요. 적용 전까지 실제 에이전트는 바뀌지 않아요."
    : null;
  // 예시 — 누르면 입력칸에 들어간다(전송은 사람이). 탑바의 [＋ 만들기]를 은퇴시키며 그
  // 자리를 여기로 옮겼다: 버튼이 아니라 글이라 가볍고, 무엇을 말하면 되는지가 보인다.
  // 새로 만드는 자리는 v0 식으로 — 짧은 키워드 칩 + [다른 예시] 로 묶음을 돌린다.
  const [page, setPage] = useState(0);
  const examples = creating ? CREATE_EXAMPLES[page % CREATE_EXAMPLES.length]
    : builder ? EDIT_EXAMPLES.map((t) => ({ label: t, text: t })) : [];
  const prefill = (text: string) => {
    try { window.postMessage({ type: "relay:chat-prefill", text, nonce: String(Date.now()) }, window.location.origin); } catch { /* 무시 */ }
  };
  return (
    <Empty className="border-0 p-8">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-primary" aria-hidden>✦</EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {hint && <EmptyDescription className="text-xs/relaxed">{hint}</EmptyDescription>}
      </EmptyHeader>
      {examples.length ? (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-1.5">
            {examples.map((e) => (
              <Button key={e.label} type="button" variant="outline" size="xs" className="rounded-full" title={e.text} onClick={() => prefill(e.text)}>{e.label}</Button>
            ))}
            {creating && (
              <Button type="button" variant="outline" size="icon-xs" className="rc-empty-more rounded-full" aria-label="다른 예시" title="다른 예시"
                onClick={() => setPage((p) => p + 1)}>↻</Button>
            )}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/** 새로 만들기 예시 — 칩은 짧은 이름, 채워지는 글은 한 줄 요청. 묶음 단위로 돌린다. */
const CREATE_EXAMPLES: { label: string; text: string }[][] = [
  [
    { label: "아침 요약 알림", text: "매일 아침 9시에 오늘 일정과 할 일을 요약해서 알려주는 에이전트를 만들어줘" },
    { label: "슬랙 답변 봇", text: "슬랙 채널에서 질문이 오면 사내 문서를 찾아 답해주는 에이전트를 만들어줘" },
    { label: "메모 정리", text: "내가 적어두는 메모를 매주 주제별로 정리해주는 에이전트를 만들어줘" },
    { label: "일정 비서", text: "캘린더를 보고 회의 전에 준비할 것을 미리 알려주는 에이전트를 만들어줘" },
  ],
  [
    { label: "문의 접수 폼", text: "고객 문의를 받는 폼 화면을 만들고, 접수되면 나에게 알려주는 에이전트를 만들어줘" },
    { label: "가계부", text: "지출을 적으면 월별로 합계와 그래프를 보여주는 가계부 에이전트를 만들어줘" },
    { label: "뉴스 브리핑", text: "관심 키워드의 뉴스를 매일 저녁 모아서 짧게 브리핑해주는 에이전트를 만들어줘" },
    { label: "독서 기록", text: "읽은 책과 감상을 기록하고 검색할 수 있는 화면을 가진 에이전트를 만들어줘" },
  ],
  [
    { label: "습관 체크", text: "매일 저녁 오늘의 습관 체크를 물어보고 주간 달성률을 보여주는 에이전트를 만들어줘" },
    { label: "번역 도우미", text: "붙여넣은 글을 자연스러운 한국어·영어로 번역해주는 에이전트를 만들어줘" },
    { label: "회의록 정리", text: "회의 녹취 텍스트를 넣으면 결정 사항과 할 일로 정리해주는 에이전트를 만들어줘" },
    { label: "미니 게임", text: "간단한 퀴즈 게임 화면을 가진 에이전트를 만들어줘" },
  ],
];
const EDIT_EXAMPLES = ["매일 아침 9시에 요약을 보내줘", "슬랙 채널을 연결해줘", "화면에 검색 기능을 넣어줘"];

/** The chat thread + runtime. Split out from ChatApp so useLocalRuntime can be
 *  SEEDED with the conversation's prior turns (initialMessages) — assistant-ui only
 *  accepts those at construction, so this mounts AFTER history has loaded. */
function ChatThread({ ctx, initialMessages, attach, onSwitch, onStatus, embedded, active = true }: { ctx: RelayCtx; initialMessages: readonly ThreadMessageLike[]; attach: ActiveTurn | null; onSwitch?: (c: string) => void; onStatus?: (s: DeskTurnStatus) => void; embedded?: boolean; active?: boolean }) {
  // initialMessages is captured once (useMemo []) — a route change remounts ChatApp
  // (new conversationId), which remounts this with the new history.
  // 어댑터는 mount 1회 생성이지만 컨텍스트는 ref 로 최신을 본다 — 전역 getCtx() 직결을 끊어
  // mount API 오버라이드·슬롯 전환(convId)이 턴 생성의 conversation_id 에 그대로 귀속된다
  // (히스토리는 슬롯으로 읽고 턴은 전역으로 쏘던 twin-drift 봉합).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const runtime = useLocalRuntime(useMemo(() => makeAdapter(() => ctxRef.current), []), {
    initialMessages: useMemo(() => initialMessages, []),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RelayCtxContext.Provider value={ctx}>
       <ActivePaneCtx.Provider value={active}>
        <AttachOnMount attach={attach} />
        <ServerTurnWatch ctx={ctx} attach={attach} />
        <TurnStatusReporter onStatus={onStatus} />
        <ThreadPrimitive.Root className="rc-root">
          {/* embedded=탭 셸이 통합 헤더를 소유 → per-pane 헤더 억제(이중 헤더 방지) */}
          {!embedded && <ChatHeader ctx={ctx} live onSwitch={onSwitch} />}
          {/* 스크롤은 MessageScroller 가 소유한다(ThreadPrimitive.Viewport 의 내장 autoScroll 과 겹치면
              바닥추적이 둘이 되어 서로 싸운다 — Viewport 는 쓰지 않는다). autoScroll=바닥에 있을 때만
              스트리밍을 따라가고, 새 user 메시지(scrollAnchor)는 상단에 앉힌다. 열 때는 맨 아래(end). */}
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="rc-logwrap">
              <MessageScrollerViewport className="rc-log" aria-label="대화">
                <MessageScrollerContent className="gap-[18px]">
                  <ThreadPrimitive.Empty>
                    <EmptyStarter ctx={ctx} />
                  </ThreadPrimitive.Empty>
                  <ThreadPrimitive.Messages components={SCROLL_COMPONENTS} />
                </MessageScrollerContent>
              </MessageScrollerViewport>
              {/* 과거 스크롤 중 최신으로 — 하단 중앙 플로팅 원형. 표시/숨김은 스크롤러가 판단한다. */}
              <MessageScrollerButton aria-label="맨 아래로" title="맨 아래로" className="rounded-full shadow-md">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </MessageScrollerButton>
            </MessageScroller>
          </MessageScrollerProvider>
          <Composer resumingTurn={!!attach} onSwitch={onSwitch} />
        </ThreadPrimitive.Root>
       </ActivePaneCtx.Provider>
      </RelayCtxContext.Provider>
    </AssistantRuntimeProvider>
  );
}

/** ctxOverrides — RelayChat.mount(el, {instanceId, conversation, title})가 주입하는 위젯별
 *  컨텍스트(부재 필드는 전역 __RELAY_CONTEXT 폴백 — 기존 자동 마운트는 인자 없이 호출). */
export function ChatApp({ ctxOverrides, onStatus, embedded, active = true }: { ctxOverrides?: Partial<RelayCtx>; onStatus?: (s: DeskTurnStatus) => void; embedded?: boolean; active?: boolean } = {}) {
  const base = useMemo(() => getCtx(ctxOverrides), []);
  // 로그아웃 크로스뷰 동기화 — 전용 /chat 문서(relayjs 부재)도 커버해야 해서 위젯이 직접 건다.
  useAuthWatch();
  // conversationId 는 동적 — 바인딩 전환은 mount 계약(setConversation — relayjs AgentScope 파생)과
  // 헤더 대화 메뉴(onSwitch)만 바꾼다. 구 chat-follows-route(셸 relay:route 중계 + manifest routes
  // 매칭)는 2026-07-13 은퇴 — 라우트→에이전트 매핑의 SoT 는 뷰 소스의 AgentScope 다.
  const [convId, setConvId] = useState(base.conversationId);
  const ctx = useMemo(() => ({ ...base, conversationId: convId }), [base, convId]);

  // Load the conversation's prior turns before mounting the runtime, so refresh /
  // agent-switch restores the visible thread (the brain keeps the data; the UI just
  // never re-fetched it). null = still loading; [] = no history / load failed.
  const [initial, setInitial] = useState<ReplayMessage[] | null>(null);
  // Alongside history, probe for an in-flight turn to re-attach to (see runtime.loadActiveTurn).
  const [attach, setAttach] = useState<ActiveTurn | null>(null);
  useEffect(() => {
    let alive = true;
    setInitial(null); setAttach(null); // 슬롯 전환 시 로딩 상태로(옛 스레드 잔상 방지 + ChatThread 재마운트)
    // SEQUENTIAL (history → active), never concurrent: if a turn completes in the gap it lands
    // in history and the later active-probe returns null, so a just-finished turn is shown once
    // (via history), never duplicated as both a replayed AND a re-attached message.
    (async () => {
      const msgs = await loadHistory(ctx).catch(() => [] as ReplayMessage[]);
      const act = await loadActiveTurn(ctx).catch(() => null);
      // 선영속으로 in-flight 턴의 프롬프트가 이력에도 실려 온다 — 재부착(AttachOnMount)이
      // 같은 프롬프트를 다시 붙이므로, 그 턴의 이력 행은 제외해 중복 말풍선을 막는다.
      const dedup = act ? msgs.filter((m) => m.turnId !== act.turnId) : msgs;
      if (alive) { setInitial(dedup); setAttach(act); }
    })();
    return () => { alive = false; };
  }, [ctx.conversationId]);

  if (initial === null) {
    return (
      <div className="rc-root">
        {!embedded && <ChatHeader ctx={ctx} live={false} onSwitch={setConvId} />}
        <div className="rc-log">
          <HistorySkeleton />
        </div>
      </div>
    );
  }
  return <ChatThread ctx={ctx} initialMessages={initial as readonly ThreadMessageLike[]} attach={attach} onSwitch={setConvId} onStatus={onStatus} embedded={embedded} active={active} />;
}
