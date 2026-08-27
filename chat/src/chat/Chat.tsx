/*!
 * Chat.tsx — RelayOS live agent chat, composed from assistant-ui primitives and styled with the
 * RelayOS chat tokens (builder-ux 프로토타입 룩 — teal 억양·쿨그레이 램프). assistant-ui gives
 * the runtime: streaming, auto-scroll, message lifecycle. We supply the look: 내레이션 산문(잉크)
 * 과 대비되는 보더리스 스텝 타임라인, TodoWrite 플랜 카드, 스폰 내레이션, 마크다운 본문.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useMessage,
  useThread,
  useThreadRuntime,
  ThreadPrimitive,
  MessagePrimitive,
} from "@assistant-ui/react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { TurnMeta, RelayCtx, ReplayMessage, ModelOption } from "./runtime";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeAdapter, getCtx, loadHistory, loadEffort, setEffort, loadAttTotalLimit, EFFORT_LEVELS, loadModel, setModel, modelOptions, loadModelOptions, lastConnectedModel, contextWindowFor, setPendingAttachments, uploadAttachment, loadCommands, loadAgents, loadActiveTurn, setAttachTurn, takeConversationCancelled, parseBuiltin, executeBuiltin, onOverridesChanged, notifyOverridesChanged, onTurnPhase, onTurnUsage, respondAsk, hasSteer, steerTurn, stepMeta, loadConversations, renameConversation, deleteConversation, fileDownloadUrl, watchServerTurns, iconUrlForInstance,
  loadHarnessVariants,
  loadHarnessName,
  loadModelOptionsFor,
  setHarnessAndModel,
  hasEffort,
  serverAgentOf,
  serverParamOf,
  loadConversationsOf, injectedCoords } from "./runtime";
import type { AgentEntry } from "./runtime";
import type { Attachment, SlashCommand, ActiveTurn, TurnUsageLive, ConversationRow, ConversationsInfo, InboxRow } from "./runtime";
import { loadInbox, loadInstances, type NavInstance } from "./runtime";
import { threadFamily, siblingThread, displayBinding, paramTargets, withTargets, targetCandidates } from "./routematch";
import { STEER_TOOL } from "./envelope-reducer";
import { broadcastLogout, installAuthWatch } from "../auth-sync";

function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

// ── 위젯 컨텍스트 — 전역 getCtx() 직결 해체 (컴포넌트화 1단계) ────────────────
// RelayChat.mount(el, {instanceId, conversation, …})가 위젯 인스턴스별 ctx 를 내려보내고,
// 슬롯 전환(setConversation·대화 메뉴 onSwitch)도 여기(convId) 반영된다. Provider 는 ChatThread 가 세우며
// 컴포저·셀렉터·질문 카드는 전역 대신 이걸 읽는다 — 턴 귀속·히스토리·오버라이드의 대화 축이
// 항상 화면에 보이는 스레드와 일치한다(브리지 표면에선 값이 기존 getCtx()와 동일).
const RelayCtxContext = createContext<RelayCtx | null>(null);
function useRelayCtx(): RelayCtx {
  const c = useContext(RelayCtxContext);
  return useMemo(() => c ?? getCtx(), [c]);
}

// 이 pane 이 "활성 탭"인가 — 탭 셸(ChatTabs)이 keep-alive 로 여러 pane 을 함께 마운트할 때,
// 프리필/자동전송(postMessage 브로드캐스트·모듈 싱글턴)을 활성 pane 하나만 소비하게 게이팅한다.
// 단일 마운트(전용 /chat 문서·비탭)는 항상 true. (탭 없으면 항상 활성.)
const ActivePaneCtx = createContext<boolean>(true);

// ── 파트 그룹화 — 커스텀 assistant 렌더의 심장 ──────────────────────────────
// 연속된 reasoning/tool-call 파트를 하나의 타임라인으로 묶고, text 파트가 run 을 끊는다
// (네이티브 TraceGroupView·renderItems 와 같은 규칙). TodoWrite 는 타임라인에서 빼서 플랜
// 카드로 — 한 턴에 여러 번 오면 마지막 호출만 렌더한다(최신 상태가 곧 계획).
type AnyPart = any;
type Group =
  | { kind: "md"; text: string }
  | { kind: "trace"; steps: AnyPart[] }
  | { kind: "plan"; todos: any[] | null }
  | { kind: "ask"; part: AnyPart }
  | { kind: "steer"; part: AnyPart }
  | { kind: "choice"; part: AnyPart }
  | { kind: "files"; part: AnyPart };

/** 질문 카드 도구 — 네이티브 AskUserQuestion(세션 pod 가 stdio can_use_tool 채널에서
 *  답변 회송을 대기). 구 MCP 재구현명(mcp__ask__ask_user)은 은퇴 — 과거 대화 리플레이
 *  렌더용으로만 매칭한다. */
function isAskTool(name: unknown): boolean {
  return name === "AskUserQuestion" || name === "mcp__ask__ask_user";
}

/** 얹기 카드 — 진짜 도구가 아니라 리듀서가 봉투 `steer` 이벤트로 세운 예약 파트다
 *  (envelope-reducer 의 STEER_TOOL). 이름 문자열은 리듀서가 정본이라 여기서 다시 쓰지 않는다. */
function isSteerPart(name: unknown): boolean {
  return name === STEER_TOOL;
}

/** @relay/builder ask 스크립트(논블로킹 선택지) — scripts-engine 이 script_ask 로 합성하고
 *  (TOOL_PREFIX='script_'·mcpServers 키 'scripts'), claude 스트림·저장 프레임엔
 *  mcp__scripts__script_ask 로 찍힌다. 정확명과 MCP 프리픽스명(suffix) 둘 다 매칭. */
function isChoiceTool(name: unknown): boolean {
  return typeof name === "string" && (name === "script_ask" || name.endsWith("__script_ask"));
}

/** deliver_file 파일 카드 도구 — 세션 pod MCP("ask" 서버)라 스트림·저장 프레임엔
 *  mcp__ask__deliver_file 로 찍힌다(정확명은 방어 매칭). */
function isDeliverTool(name: unknown): boolean {
  return name === "mcp__ask__deliver_file" || name === "deliver_file";
}

function groupParts(content: readonly AnyPart[]): Group[] {
  let lastPlan = -1;
  content.forEach((p, i) => { if (p?.type === "tool-call" && p.toolName === "TodoWrite") lastPlan = i; });
  const groups: Group[] = [];
  let trace: AnyPart[] = [];
  const flush = () => { if (trace.length) { groups.push({ kind: "trace", steps: trace }); trace = []; } };
  content.forEach((p, i) => {
    if (!p) return;
    if (p.type === "tool-call" && p.toolName === "TodoWrite") {
      // 이전 플랜 호출은 렌더 생략(trace run 도 안 끊음) — 마지막 것만 카드로.
      if (i === lastPlan) {
        flush();
        groups.push({ kind: "plan", todos: Array.isArray(p.args?.todos) ? p.args.todos : null });
      }
      return;
    }
    if (p.type === "tool-call" && isAskTool(p.toolName)) {
      flush();
      groups.push({ kind: "ask", part: p });
      return;
    }
    // 얹기 — 턴이 도는 중에 사용자가 더한 말. 타임라인(trace)에 접어 넣지 않고 흐름을 끊어
    // 제 자리에 세운다: 이 말이 들어간 지점이 곧 이후 도구 호출들이 갈린 이유다.
    if (p.type === "tool-call" && isSteerPart(p.toolName)) {
      flush();
      groups.push({ kind: "steer", part: p });
      return;
    }
    // script_ask 는 턴을 끝내고 답을 다음 사용자 메시지로 받는 논블로킹 카드 —
    // 질문마다 카드 하나, 같은 턴에 여러 번 오면 각각 렌더한다.
    if (p.type === "tool-call" && isChoiceTool(p.toolName)) {
      flush();
      groups.push({ kind: "choice", part: p });
      return;
    }
    // deliver_file — 에이전트가 건넨 파일의 다운로드 카드(호출마다 카드 하나).
    if (p.type === "tool-call" && isDeliverTool(p.toolName)) {
      flush();
      groups.push({ kind: "files", part: p });
      return;
    }
    if (p.type === "reasoning" || p.type === "tool-call") { trace.push(p); return; }
    if (p.type === "text") { flush(); if (p.text) groups.push({ kind: "md", text: p.text }); return; }
    // 그 외 파트(이미지 등)는 assistant 어댑터가 생성하지 않는다 — 무시.
  });
  flush();
  return groups;
}

/** 마크다운 본문 — 산문은 진한 잉크(스텝의 옅음과 대비). 스트리밍 중엔 blinking caret.
 *  링크는 전부 새 탭 — 챗 문서는 sandboxed iframe(deployd 셸)/WKWebView(씬클라) 안이라
 *  제자리 네비게이션하면 패널이 다른 문서로 잠겨 되돌아올 수 없다(/connect 딥링크 사고).
 *  씬클라는 createWebViewWith 가 target=_blank 를 외부 브라우저로, 셸은 chat-frame sandbox 의
 *  allow-popups 가 새 탭으로 연다(view.go shellTmpl 짝). */
/** 색 리터럴 — #rgb·#rrggbb·#rrggbbaa. 견본을 붙일지 판정하는 유일한 문(gate)이자, 그
 *  문자열이 style 로 흘러가기 전의 유일한 검증이다(모델이 쓴 텍스트 → CSS 주입 방지). */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const mdComponents = {
  a: ({ node: _n, ...props }: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // 인라인 코드 내용이 통째로 색이면 앞에 견본 한 조각 — 대화에서 "#1E5BD6" 이 무슨 색인지
  // 눈으로 확인하게 한다(브랜딩 대화가 hex 나열이 되던 문제). 내용 **전체**가 hex 일 때만
  // 걸리므로 코드펜스·산문은 대상이 아니고, span 은 여기서 직접 만든다(모델 문자열이
  // 마크업이 되는 경로 없음).
  code: ({ node: _n, children, ...props }: any) => {
    const hex = (Array.isArray(children) ? children.join("") : String(children ?? "")).trim();
    if (!HEX_RE.test(hex)) return <code {...props}>{children}</code>;
    return (
      <code {...props}>
        <span className="rc-swatch" style={{ background: hex }} aria-hidden="true" />
        {children}
      </code>
    );
  },
};

function MdBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={"rc-md" + (streaming ? " rc-streaming" : "")}>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</Markdown>
    </div>
  );
}

/** 타임라인 스텝 한 행 — [아이콘] [동사 · 대상] [· 결과 요약] [›]. 클릭하면 원시 상세 펼침.
 *  실행 중엔 아이콘 자리에 teal ring 스피너. 카드 박스 없음(레퍼런스: 조용한 타임라인). */
/** 위임(agent_dispatch)의 대화를 찾아 탭으로 연다 — 서브에이전트는 별도 대화에서 돌아, 그 탭이
 *  열려 있지 않으면 보고와 질문을 놓친다. 세션 목록의 (agent, param) 으로 맞추고, 아직 목록에
 *  없으면 잠시 기다린다(위임 직후 세션 디렉토리가 생기는 사이). 착지는 크롬의 relay:chat-open. */
async function openDispatchConversation(instanceId: string, principal: string, sub: string, target: string): Promise<boolean> {
  const want = target.trim().toLowerCase();
  for (let i = 0; i < 8; i++) {
    const info = await loadConversationsOf(instanceId, principal).catch(() => null);
    const rows = (info?.conversations || []).filter((c) => c.agent === sub && (!want || (c.param || "").toLowerCase() === want));
    rows.sort((a, b) => (b.last_started_at || "").localeCompare(a.last_started_at || ""));
    const hit = rows[0];
    if (hit) {
      try { window.dispatchEvent(new CustomEvent("relay:chat-open", { detail: { instance: instanceId, conversation: hit.conversation_id } })); } catch { /* 미배선 */ }
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
/** 한 위임에 한 번만 연다 — 히스토리 재생·리렌더가 탭을 다시 빼앗지 않게 */
const openedDispatch = new Set<string>();

function StepRow({ part, running }: { part: AnyPart; running: boolean }) {
  const [open, setOpen] = useState(false);
  const done = part.result !== undefined || part.isError;
  const ctx = useRelayCtx();
  useEffect(() => {
    if (!running || done || part.toolName !== "agent_dispatch") return;
    const id = part.toolCallId || "";
    if (!id || openedDispatch.has(id)) return;
    const sub = String(part.args?.agent || "");
    if (!sub || !ctx.instanceId) return;
    openedDispatch.add(id);
    void openDispatchConversation(ctx.instanceId, ctx.principal, sub, String(part.args?.target || ""));
  }, [running, done, part.toolName, part.toolCallId, part.args, ctx.instanceId, ctx.principal]);
  const meta = stepMeta(part.toolName, part.args, part.result, part.isError, part.label);
  const argDisplay = part.argsText && part.argsText.trim()
    ? part.argsText
    : part.args && Object.keys(part.args).length ? JSON.stringify(part.args, null, 2) : "";
  const hasDetail = !!argDisplay || done;
  return (
    <div className={"rc-step" + (part.isError ? " err" : "") + (open ? " open" : "")}>
      <button type="button" className="rc-step-h" onClick={() => hasDetail && setOpen((o) => !o)}>
        {running && !done
          ? <span className="rc-ring" aria-hidden />
          : <span className="rc-step-ic" aria-hidden>{meta.icon}</span>}
        <span className={"rc-step-lb" + (running && !done ? " live" : "")}>
          {meta.label}
          {meta.target && <span className="rc-step-tg"> · {meta.target}</span>}
        </span>
        {done && meta.summary && <span className="rc-step-sum">· {meta.summary}</span>}
        {hasDetail && <span className="rc-step-caret" aria-hidden>{open ? "⌄" : "›"}</span>}
      </button>
      {open && (
        <div className="rc-step-body">
          <div className="rc-step-raw">{part.toolName}</div>
          {argDisplay && <pre className="rc-step-args">{argDisplay}</pre>}
          {done && <pre className="rc-step-res">{resultText(part.result).slice(0, 8000) || "(결과 없음)"}</pre>}
        </div>
      )}
    </div>
  );
}

/** reasoning 파트 — 레퍼런스의 접힌 "Thought" 행. 스트리밍 중(live)엔 사고 꼬리를 미리보기로
 *  흘려 보여주고(살아있음 신호), 다음 스텝으로 넘어가면 접힌 행으로 수렴한다. 클릭해 전문 열람. */
function ThoughtRow({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"rc-step rc-think" + (open ? " open" : "")}>
      <button type="button" className="rc-step-h" onClick={() => setOpen((o) => !o)}>
        <span className="rc-step-ic" aria-hidden>•</span>
        <span className={"rc-step-lb" + (live ? " live" : "")}>{live ? "생각 중…" : "생각"}</span>
        <span className="rc-step-caret" aria-hidden>{open ? "⌄" : "›"}</span>
      </button>
      {open
        ? <div className="rc-step-body rc-think-tx">{text}</div>
        : live && text
          ? <div className="rc-think-live">{text.length > 280 ? "…" + text.slice(-280) : text}</div>
          : null}
    </div>
  );
}

/** 스텝 타임라인 — 실행 중엔 펼쳐져 스텝이 흘러내리고, 턴이 끝나면 "✓ 작업 N개 · Ns" 한
 *  행으로 자동 접힘(히스토리 replay 는 접힌 채 시작). 접힘/펼침 토글. */
function TraceTimeline({ steps, running, durationMs }: { steps: AnyPart[]; running: boolean; durationMs?: number }) {
  const [collapsed, setCollapsed] = useState(!running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setCollapsed(true);
    wasRunning.current = running;
  }, [running]);
  const tools = steps.filter((s) => s.type === "tool-call").length;
  const label = tools > 0 ? `작업 ${tools}개` : "생각 정리";
  const dur = typeof durationMs === "number" && durationMs >= 100 ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
  const summary = (open: boolean) => (
    <button type="button" className={"rc-trace-sum" + (open ? " open" : "")} onClick={() => setCollapsed(open)}>
      <span className="rc-trace-check" aria-hidden>✓</span>
      <span>{label}{dur}</span>
      <span className="rc-step-caret" aria-hidden>{open ? "⌄" : "›"}</span>
    </button>
  );
  if (collapsed) return summary(false);
  return (
    <div className="rc-trace">
      {!running && summary(true)}
      <div className="rc-steps">
        {steps.map((s, i) =>
          s.type === "reasoning"
            ? <ThoughtRow key={i} text={s.text || ""} live={running && i === steps.length - 1} />
            : <StepRow key={s.toolCallId || i} part={s} running={running} />)}
      </div>
    </div>
  );
}

/** TodoWrite 플랜 카드(프로토타입 Stepper 이식) — 체크리스트 + 진행도. 진행 행은 activeForm. */
function PlanCard({ todos, active }: { todos: any[] | null; active: boolean }) {
  const list = Array.isArray(todos) ? todos : [];
  const doneN = list.filter((t) => t?.status === "completed").length;
  return (
    <div className="rc-plan">
      <div className="rc-plan-h">
        <span className="rc-plan-t">계획</span>
        {list.length > 0 && <span className="rc-plan-n">{doneN}/{list.length}</span>}
      </div>
      {list.length === 0
        ? <div className="rc-plan-row run"><span className="rc-ring" aria-hidden /><span className="rc-plan-tx">계획 세우는 중…</span></div>
        : list.map((t, i) => {
            const st = t?.status === "completed" ? "done" : t?.status === "in_progress" ? "run" : "todo";
            const tx = (st === "run" ? t?.activeForm || t?.content : t?.content) || "";
            return (
              <div key={i} className={"rc-plan-row " + st}>
                {st === "done" ? <span className="rc-plan-ic done" aria-hidden>✓</span>
                  : st === "run" && active ? <span className="rc-ring" aria-hidden />
                  : st === "run" ? <span className="rc-plan-ic run" aria-hidden>●</span>
                  : <span className="rc-plan-ic" aria-hidden>○</span>}
                <span className="rc-plan-tx">{tx}</span>
              </div>
            );
          })}
    </div>
  );
}

/** AskUserQuestion 질문 카드 — 세션 pod 가 stdio can_use_tool 채널에서 답변을 기다린다.
 *  즉시 전달은 "질문 1개 + 단일선택"일 때만 — 질문이 여럿이거나 multiSelect 면 모든 질문을
 *  채운 뒤 "답변 보내기"로 한 번에 회송한다(한 질문만 눌러 카드가 조기 완료되는 버그 방지).
 *  답변/타임아웃 후엔 tool result 가 도착해(part.result) 카드가 완료 상태로 굳는다. */
function AskCard({ part, active }: { part: AnyPart; active: boolean }) {
  const ctx = useRelayCtx();
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [tab, setTab] = useState(0); // 다중 질문 탭 — 활성 질문 인덱스
  const [text, setText] = useState<Record<number, string>>({}); // 질문별 자유입력 초안
  const done = part.result !== undefined || part.isError;
  const questions: any[] = Array.isArray(part.args?.questions) ? part.args.questions : [];
  const waiting = active && !done && !sent;
  // 즉시 전달 = 질문 1개 & 단일선택뿐. 그 외는 전부 누적 후 명시 전송(부분 제출 봉쇄).
  const instant = questions.length === 1 && !questions[0]?.multiSelect;

  const submit = async (answers: Array<{ question: string; header?: string; selected: string[] }>) => {
    setSent(true);
    const ok = await respondAsk(ctx, answers);
    if (!ok) { setFailed(true); setSent(false); }
  };
  const pick = (qi: number, q: any, label: string) => {
    if (!waiting) return;
    if (instant) {
      void submit([{ question: q.question, header: q.header, selected: [label] }]);
      return;
    }
    // 누적: multiSelect=토글, 단일선택=라벨 교체(라디오 — 질문당 하나).
    const wasEmpty = (sel[qi]?.length ?? 0) === 0;
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      if (q.multiSelect) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
    // 단일선택은 답 하나로 확정 → 처음 답한 경우 다음 미응답 질문 탭으로 자동 이동.
    if (questions.length > 1 && !q.multiSelect && wasEmpty) {
      const next = questions.findIndex((_, i) => i !== qi && (sel[i]?.length ?? 0) === 0);
      if (next >= 0) setTab(next);
    }
  };
  // 자유입력(직접 입력) — 네이티브 AskUserQuestion "Other" 등가. 임의 문자열을 selected 로
  // 회송(mergeAskAnswers 가 join → {질문:값}). instant 는 즉시 회송, 누적 모드는 이 질문 답으로
  // 굳힌다(단일선택=치환, multiSelect=옵션 선택에 덧댐).
  const freeSubmit = (qi: number, q: any) => {
    if (!waiting) return;
    const v = (text[qi] ?? "").trim();
    if (!v) return;
    if (instant) {
      void submit([{ question: q.question, header: q.header, selected: [v] }]);
      return;
    }
    const wasEmpty = (sel[qi]?.length ?? 0) === 0;
    setSel((prev) => ({
      ...prev,
      [qi]: q.multiSelect ? [...(prev[qi] ?? []).filter((l) => l !== v), v] : [v],
    }));
    if (questions.length > 1 && !q.multiSelect && wasEmpty) {
      const next = questions.findIndex((_, i) => i !== qi && (sel[i]?.length ?? 0) === 0);
      if (next >= 0) setTab(next);
    }
  };
  const sendMulti = () => {
    void submit(questions.map((q, qi) => ({ question: q.question, header: q.header, selected: sel[qi] ?? [] })));
  };
  const answered = questions.filter((_, qi) => (sel[qi]?.length ?? 0) > 0).length;
  const allAnswered = answered === questions.length;

  if (questions.length === 0) return null;
  const tabbed = questions.length > 1; // 다중 질문은 탭으로 접어 카드 높이를 한 질문만큼으로 유지
  return (
    <div className={"rc-ask" + (waiting ? " live" : "")}>
      {tabbed && (
        <div className="rc-ask-tabs" role="tablist">
          {questions.map((q, qi) => {
            const on = (sel[qi]?.length ?? 0) > 0;
            return (
              <button type="button" key={qi} role="tab" aria-selected={qi === tab}
                      className={"rc-ask-tab" + (qi === tab ? " sel" : "") + (on ? " done" : "")}
                      onClick={() => setTab(qi)}>
                <span className="rc-ask-tab-lb">{q.header || `질문 ${qi + 1}`}</span>
                {on && <span className="rc-ask-tab-dot" aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      )}
      {questions.map((q, qi) => (
        <div key={qi} className="rc-ask-q" hidden={tabbed && qi !== tab}>
          <div className="rc-ask-head">
            {!tabbed && q.header && <span className="rc-ask-chip">{q.header}</span>}
            <span className="rc-ask-tx">{q.question}</span>
          </div>
          <div className="rc-ask-opts">
            {(Array.isArray(q.options) ? q.options : []).map((o: any, oi: number) => {
              const on = (sel[qi] ?? []).includes(o?.label);
              return (
                <button type="button" key={oi} disabled={!waiting}
                        className={"rc-ask-opt" + (on ? " on" : "")}
                        onClick={() => pick(qi, q, o?.label ?? "")}>
                  <span className="rc-ask-opt-lb">{o?.label}</span>
                  {o?.description && <span className="rc-ask-opt-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <div className={"rc-ask-free" + (!instant && (text[qi] ?? "").trim() && (sel[qi] ?? []).includes((text[qi] ?? "").trim()) ? " on" : "")}>
            <input type="text" className="rc-ask-free-in" placeholder="또는 직접 입력…"
                   value={text[qi] ?? ""} disabled={!waiting}
                   onChange={(e) => setText((prev) => ({ ...prev, [qi]: e.target.value }))}
                   onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); freeSubmit(qi, q); } }} />
            <button type="button" className="rc-ask-free-go" disabled={!waiting || !(text[qi] ?? "").trim()}
                    onClick={() => freeSubmit(qi, q)}>{instant ? "전달" : "입력"}</button>
          </div>
        </div>
      ))}
      <div className="rc-ask-foot">
        {waiting && instant && <span className="rc-ask-hint">선택하면 바로 전달돼요</span>}
        {waiting && !instant && (
          <button type="button" className="rc-ask-send" onClick={sendMulti} disabled={!allAnswered}>
            답변 보내기{allAnswered ? "" : ` (${answered}/${questions.length})`}
          </button>
        )}
        {sent && !done && <span className="rc-ask-hint">답변 전송됨 — 이어서 진행 중…</span>}
        {done && <span className="rc-ask-hint done">✓ 답변 완료</span>}
        {failed && <span className="rc-ask-hint err">회송 실패 — 다시 선택해 주세요</span>}
      </div>
    </div>
  );
}

/** script_ask 선택지 카드(논블로킹) — @relay/builder ask 스크립트가 tool_use 로 표시만
 *  요청하고 턴을 끝낸다(핸들러 즉시 반환). AskCard(mid-turn respond 회송)와 달리 답이
 *  "다음 턴의 프롬프트"다: 클릭 = 라벨을 사용자 메시지로 전송 — rt.append 는 idle 스레드에서
 *  새 턴을 시작하는 정본 경로(Composer.sendNow·AttachOnMount 와 동일). 턴 실행 중이거나
 *  이미 답했으면(카드 뒤 user 메시지 존재) 비활성 — 리플레이에선 다음 user 메시지가 옵션
 *  라벨과 일치할 때 선택 표시를 복원한다. */
/** 얹기 카드 — 턴이 도는 중에 사용자가 더한 말을 그 말이 들어간 자리에 세운다.
 *  말풍선이 아니라 흐름 안의 표시인 이유: 이것은 새 턴의 시작이 아니라 **이 턴에 얹힌 것**이고,
 *  화면이 그 차이를 지워 버리면 사용자는 자기 말이 다음 턴으로 밀렸다고 읽는다. */
function SteerCard({ part }: { part: AnyPart }) {
  const text = String(part?.args?.text ?? part?.argsText ?? "");
  if (!text) return null;
  return (
    <div className="rc-steer" role="note">
      <span className="rc-steer-ic" aria-hidden>↳</span>
      <span className="rc-steer-tx">{text}</span>
    </div>
  );
}

function ChoiceCard({ part }: { part: AnyPart }) {
  const rt = useThreadRuntime();
  const running = useThread((t) => t.isRunning);
  const msgId = useMessage((m) => m.id);
  // 카드가 속한 메시지 뒤 첫 user 메시지의 텍스트 = 이미 도착한 답(리플레이 포함). null = 미답.
  const answer = useThread((t) => {
    const idx = t.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return null;
    for (let i = idx + 1; i < t.messages.length; i++) {
      const m: any = t.messages[i];
      if (m.role !== "user") continue;
      const c = m.content;
      return Array.isArray(c)
        ? c.filter((x: any) => x && x.type === "text").map((x: any) => x.text).join("\n")
        : typeof c === "string" ? c : "";
    }
    return null;
  });
  const [picked, setPicked] = useState<string | null>(null);

  // 스트리밍 중엔 args 가 비고 argsText 가 partial JSON 일 수 있다 — 파싱 실패 = 스켈레톤
  // (크래시 금지). 완결 assistant 프레임이 args 를 채우면 자연히 실카드로 전환된다.
  let a: any = part.args && typeof part.args === "object" && Object.keys(part.args).length ? part.args : null;
  if (!a && typeof part.argsText === "string" && part.argsText.trim()) {
    try { a = JSON.parse(part.argsText); } catch { a = null; }
  }
  const options: { label: string; description: string }[] = Array.isArray(a?.options)
    ? a.options
        .filter((o: any) => o && typeof o.label === "string" && o.label)
        .map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" }))
    : [];
  const question = typeof a?.question === "string" ? a.question : "";
  if (!question && options.length === 0) {
    return (
      <div className="rc-ask" role="status" aria-label="선택지 준비 중">
        <div className="rc-ask-pending"><span className="rc-ring" aria-hidden /> 선택지 준비 중…</div>
      </div>
    );
  }
  const header = typeof a?.header === "string" ? a.header : "";
  const chosen = picked ?? (answer != null && options.some((o) => o.label === answer) ? answer : null);
  const disabled = running || picked != null || answer != null;
  const send = (label: string) => {
    if (disabled) return;
    setPicked(label);
    setPendingAttachments([]); // 단일 슬롯 홀더 오염 방지 — 이 턴은 첨부 없음
    rt.append({ role: "user", content: [{ type: "text", text: label }] });
  };
  return (
    <div className={"rc-ask" + (!disabled ? " live" : "")}>
      <div className="rc-ask-head">
        {header && <span className="rc-ask-chip">{header}</span>}
        {question && <span className="rc-ask-tx">{question}</span>}
      </div>
      <div className="rc-ask-opts">
        {options.map((o, i) => (
          <button type="button" key={i} disabled={disabled}
                  className={"rc-ask-opt" + (chosen === o.label ? " on" : "")}
                  onClick={() => send(o.label)}>
            <span className="rc-ask-opt-lb">
              {o.label}
              {chosen === o.label && <span className="rc-ask-opt-check" aria-hidden> ✓</span>}
            </span>
            {o.description && <span className="rc-ask-opt-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      {!disabled && (
        <div className="rc-ask-foot"><span className="rc-ask-hint">선택하면 메시지로 전송돼요</span></div>
      )}
    </div>
  );
}

/** deliver_file 파일 카드 — 에이전트가 건넨 workspace 파일(스냅샷)의 다운로드 표면.
 *  카드 데이터의 정본은 tool result(control JSON {ok, files:[{name,path,bytes}]} 원문) —
 *  결과 전(스트리밍)엔 args.paths 로 스켈레톤을 그린다. 링크는 deployd /api/fs/download
 *  프록시(세션 쿠키 인가 — control WorkspaceFsScopeGuard 판정)라 같은 URL 이라도 남의
 *  파일은 열리지 않는다. 스냅샷은 .uploads GC(7일) 뒤 만료 — 그 후 클릭은 404. */
function FileCard({ part }: { part: AnyPart }) {
  const ctx = useRelayCtx();
  let files: Array<{ name: string; path: string; bytes: number }> = [];
  if (!part.isError && part.result !== undefined) {
    try {
      const j = JSON.parse(resultText(part.result));
      if (Array.isArray(j?.files)) files = j.files.filter((f: any) => f && f.name && f.path);
    } catch { /* 결과 미완/비정형 — 스켈레톤 유지 */ }
  }
  if (part.isError) {
    const msg = resultText(part.result);
    return (
      <div className="rc-file err">
        <span aria-hidden>⚠</span> 파일 전달 실패{msg ? ` — ${msg.slice(0, 200)}` : ""}
      </div>
    );
  }
  if (files.length === 0) {
    const names = Array.isArray(part.args?.paths)
      ? part.args.paths.map((p: any) => String(p).split("/").pop()).filter(Boolean).join(", ")
      : "";
    return (
      <div className="rc-file pending" role="status">
        <span className="rc-ring" aria-hidden /> 파일 전달 중{names ? ` — ${names}` : ""}…
      </div>
    );
  }
  // file.download(§5.4-27) — path 는 불투명 참조, URL 조립은 transport 소유(구 /api/fs/download 은퇴).
  const href = (f: { path: string }) => fileDownloadUrl(ctx, f.path);
  return (
    <div className="rc-file">
      {files.map((f, i) => (
        <a key={i} className="rc-file-row" href={href(f)} download={f.name} title={`${f.name} 다운로드`}>
          <span className="rc-file-ic" aria-hidden>📄</span>
          <span className="rc-file-name">{f.name}</span>
          <span className="rc-file-size">{fmtSize(f.bytes || 0)}</span>
          <span className="rc-file-dl" aria-hidden>⬇</span>
        </a>
      ))}
    </div>
  );
}

/** 무대 산출물 카드 — 에이전트가 이 턴에 파일 교환 무대에 놓은 파일(봉투 `file` 이벤트 §6-35,
 *  기판이 턴 전후 무대 diff 로 발견해 알린다). 위의 FileCard 와 달리 **툴콜이 없다**: 파일을
 *  건네는 데 도구가 필요하지 않은 기판(무대에 놓기만 하면 되는 기판)에서는 알림이 턴 메타로 온다.
 *
 *  이걸 안 그리던 동안 기판은 알리고 계약은 날랐는데 화면만 버렸다 — 그래서 에이전트가 만든
 *  파일을 사용자가 받을 길이 없었고, "터미널에서 cp 해 주세요"가 유일한 안내였다(2026-08-25). */
function StageFiles({ paths }: { paths: readonly string[] }) {
  const ctx = useRelayCtx();
  if (!paths.length) return null;
  return (
    <div className="rc-file">
      {paths.map((p, i) => {
        const name = p.split("/").pop() || p;
        return (
          <a key={i} className="rc-file-row" href={fileDownloadUrl(ctx, p)} download={name} title={`${name} 다운로드`}>
            <span className="rc-file-ic" aria-hidden>📄</span>
            <span className="rc-file-name">{name}</span>
            <span className="rc-file-dl" aria-hidden>⬇</span>
          </a>
        );
      })}
    </div>
  );
}

/** 히스토리 로딩 스켈레톤 — 죽은 3-dot 대신 콘텐츠 형태의 shimmer. */
function HistorySkeleton() {
  return (
    <div className="rc-skl-wrap" role="status" aria-label="대화 불러오는 중">
      <div className="rc-skl w40" /><div className="rc-skl w85" /><div className="rc-skl w70" /><div className="rc-skl w55" />
    </div>
  );
}

/** Live running status — 턴 내내 살아있는 내레이션(원칙 1: 죽은 침묵 금지).
 *  콘텐츠가 오기 전엔 스폰 스테이지(전달 중 → 에이전트 깨우는 중 → 연결됨·생각 중 — system
 *  init 프레임이 onTurnPhase 로 전환), 온 뒤엔 마지막 실행 스텝의 활동 라벨. 3초부터 경과 표시. */
function RunningStatus() {
  const running = useMessage((m) => m.status?.type === "running");
  const content = useMessage((m) => m.content as readonly AnyPart[]);
  const [connected, setConnected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // 라이브 토큰 티커 — 업로드 단계 ↑(스텝 입력·캐시 포함), 생성 중 ↓(출력 누적). 마지막으로
  // 움직인 방향의 화살표를 보여준다( 패턴 — 살아있음 신호).
  const [usage, setUsage] = useState<TurnUsageLive | null>(null);
  const startRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    if (!startRef.current) startRef.current = Date.now();
    const iv = window.setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 1000);
    const off = onTurnPhase((phase) => { if (phase === "connected") setConnected(true); });
    const offUsage = onTurnUsage(setUsage);
    return () => { window.clearInterval(iv); off(); offUsage(); };
  }, [running]);
  if (!running) return null;
  let label: string;
  if (content.length === 0) {
    label = elapsed < 1 ? "전달 중…" : connected ? "연결됨 · 생각 중…" : "에이전트 깨우는 중…";
  } else {
    const last = content[content.length - 1];
    if (last?.type === "tool-call" && last.result === undefined && !last.isError) {
      const m = stepMeta(last.toolName, last.args, undefined, undefined, last.label);
      label = m.target ? `${m.label} · ${m.target}` : `${m.label} 중…`;
    } else if (last?.type === "reasoning") {
      label = "생각 중…";
    } else {
      label = "응답 중…";
    }
  }
  const suffix = elapsed >= 3 ? ` · ${elapsed}s` : "";
  const tick = usage
    ? (usage.dir === "up" && usage.inTok > 0
        ? <span className="rc-running-tok up" aria-label="입력 토큰">↑ {fmtTok(usage.inTok)}</span>
        : usage.outTok > 0
          ? <span className="rc-running-tok" aria-label="출력 토큰">↓ {fmtTok(usage.outTok)}</span>
          : null)
    : null;
  return (
    <div className="rc-running" role="status" aria-label="응답 생성 중">
      <span className="rc-running-dots" aria-hidden><span /><span /><span /></span>
      <span className="rc-running-tx">{label}{suffix}</span>
      {tick}
    </div>
  );
}

/** Header status dot — pulses (accent color) while the thread is running, steady green
 *  when idle. Driven by ThreadPrimitive.If (real runtime state), not a CSS ancestor class. */
function HeadDot() {
  return (
    <>
      <ThreadPrimitive.If running={false}><span className="rc-dot" /></ThreadPrimitive.If>
      <ThreadPrimitive.If running><span className="rc-dot rc-dot-run" /></ThreadPrimitive.If>
    </>
  );
}

/** "방금 · n분 전 · n시간 전 · n일 전 · M/D" — 대화 목록의 마지막 활동 시각. */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  if (s < 7 * 86400) return Math.floor(s / 86400) + "일 전";
  try { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; } catch { return ""; }
}

/** 대화 전환 메뉴 — 현재 레인 패밀리의 스레드 목록 + "새 대화" (agent-package-layout.md §4 다중세션).
 *  수렴이 기본: 분기는 여기 "새 대화" 명시 클릭에서만. 다중세션은 상수 능력(2026-07-22 —
 *  구 manifest sessions/session_policy 게이트 은퇴, FDE·end-user 동일 뷰).
 *  목록은 열 때마다 재조회 — best-effort(실패=현재 대화만, "새 대화"도 잠김).
 *  행별 이름변경(연필)·삭제(휴지통) — VS Code 세션 목록 패리티. 이름은 세션 row 의 title
 *  (host.conversations.rename), 삭제는 세션+메시지 replay 파기(host.conversations.delete).
 *  seed(기본 대화)는 되돌아갈 자리라 삭제 불가 — 초기화는 /clear 가 담당. */
/** 대화함 — 내 신원이 가진 **전 인스턴스**의 대화 목록(출처 라벨 동반). 행 클릭 =
 *  같은 인스턴스면 대화 전환(onSwitch), 다른 인스턴스면 대상 전환(ctx.onRetarget — mount
 *  API 재마운트) 폴백은 그 인스턴스 채팅 문서로 이동. 데이터는 읽기 합성(사본 없음). */
function InboxMenu({ ctx, onSwitch }: { ctx: RelayCtx; onSwitch?: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRows(null);
    loadInbox(ctx).then((r) => { if (alive) setRows(r); });
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => { alive = false; document.removeEventListener("pointerdown", onDown); };
  }, [open, ctx.instanceId, ctx.principal]);
  const label = (r: InboxRow) => {
    if (r.title) return r.title;
    const id = r.conversation_id;
    if (id.startsWith("chat-")) return "기본 대화";
    return id.length > 22 ? id.slice(0, 22) + "…" : id;
  };
  const go = (r: InboxRow) => {
    setOpen(false);
    if (r.instance === ctx.instanceId) {
      if (r.conversation_id !== ctx.conversationId) onSwitch?.(r.conversation_id);
      return;
    }
    // 다른 인스턴스로의 전환은 onRetarget(호스트 주입)만 — 구 "/i/<id>/chat" 이동 폴백은
    // 클라이언트의 마운트 문법 조립이라 은퇴했다(§2-6). 미주입 마운트에서는 조용히 유지.
    if (ctx.onRetarget) ctx.onRetarget(r.instance, r.conversation_id);
  };
  return (
    <div className="rc-sess" ref={boxRef}>
      <button type="button" className="rc-head-btn" onClick={() => setOpen((o) => !o)}
              aria-haspopup="menu" aria-expanded={open} aria-label="대화함" title="대화함 — 내 모든 에이전트 대화">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 6h14l2 7v5a1 1 0 01-1 1H4a1 1 0 01-1-1v-5z" />
        </svg>
      </button>
      {open && (
        <div className="rc-sess-menu rc-inbox" role="menu">
          {rows === null ? (
            <div className="rc-sess-note">불러오는 중…</div>
          ) : rows.length === 0 ? (
            <div className="rc-sess-note">대화가 없습니다</div>
          ) : (
            rows.map((r) => {
              const on = r.instance === ctx.instanceId && r.conversation_id === ctx.conversationId;
              return (
                <div key={r.instance + "|" + r.conversation_id} role="menuitemradio" tabIndex={0}
                     aria-checked={on} className={"rc-sess-item" + (on ? " on" : "")}
                     title={r.instance + " · " + r.conversation_id}
                     onClick={() => go(r)}
                     onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(r); } }}>
                  <span className="rc-inbox-src">{r.instance}</span>
                  <span className="rc-sess-name">{label(r)}</span>
                  {r.last_started_at && <span className="rc-sess-time">{relTime(r.last_started_at)}</span>}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function SessionMenu({ ctx, onSwitch }: { ctx: RelayCtx; onSwitch: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ConversationsInfo | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // 이름 편집 중인 대화 id
  const [confirming, setConfirming] = useState<string | null>(null); // 삭제 확인 중인 대화 id
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const refresh = () => loadConversations(ctx).then(setInfo);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEditing(null); setConfirming(null); setErr(null);
    loadConversations(ctx).then((i) => { if (alive) setInfo(i); });
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => { alive = false; document.removeEventListener("pointerdown", onDown); };
  }, [open, ctx.instanceId, ctx.principal]);
  useEffect(() => { if (editing) editRef.current?.select(); }, [editing]);

  const family = threadFamily(ctx.conversationId);
  const rows = useMemo(() => {
    const byId = new Map<string, ConversationRow>();
    // seed(패밀리 기본 스레드)는 히스토리가 없어도 항상 목록에 — 되돌아갈 자리.
    const seed = family === "main" && ctx.conversationId.startsWith("chat-") ? ctx.conversationId : family;
    byId.set(seed, { conversation_id: seed });
    for (const c of info?.conversations ?? []) {
      if (threadFamily(c.conversation_id) !== family) continue;
      byId.set(c.conversation_id, c);
    }
    if (!byId.has(ctx.conversationId)) byId.set(ctx.conversationId, { conversation_id: ctx.conversationId });
    const list = [...byId.values()];
    list.sort((a, b) => {
      if (a.conversation_id === seed) return -1;
      if (b.conversation_id === seed) return 1;
      return Date.parse(b.last_started_at || "") - Date.parse(a.last_started_at || "") || 0;
    });
    return { seed, list };
  }, [info, family, ctx.conversationId]);

  // 목록 로드 실패(info=null)면 잠금 — 선민팅/전환이 헛돌 수 있는 상태라 분기만 보수적으로 막는다.
  const canBranch = info != null;
  const label = (c: ConversationRow) => {
    if (c.title) return c.title;
    if (c.conversation_id === rows.seed) return "기본 대화";
    const suffix = c.conversation_id.slice(c.conversation_id.lastIndexOf(c.conversation_id.includes("~") ? "~" : "-") + 1);
    return "대화 " + suffix.slice(0, 6);
  };

  const saveRename = async (c: ConversationRow, value: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    const ok = await renameConversation(ctx, c.conversation_id, value.trim());
    setBusy(false);
    if (!ok) { setErr("이름을 저장하지 못했어요"); return; }
    setEditing(null);
    await refresh();
  };

  const doDelete = async (c: ConversationRow) => {
    if (busy) return;
    setBusy(true); setErr(null);
    const ok = await deleteConversation(ctx, c.conversation_id);
    setBusy(false);
    if (!ok) { setErr("대화를 삭제하지 못했어요"); return; }
    setConfirming(null);
    if (c.conversation_id === ctx.conversationId) {
      // 보고 있던 대화를 지웠으면 seed 로 복귀(빈 스레드 잔상 방지).
      setOpen(false);
      onSwitch(rows.seed);
      return;
    }
    await refresh();
  };

  return (
    <div className="rc-sess" ref={boxRef}>
      <button type="button" className="rc-head-btn" onClick={() => setOpen((o) => !o)}
              aria-haspopup="menu" aria-expanded={open} aria-label="대화 목록" title="대화 목록 · 새 대화">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 5h16M4 12h16M4 19h10" />
        </svg>
      </button>
      {open && (
        <div className="rc-sess-menu" role="menu">
          {info === null ? (
            <div className="rc-sess-note">불러오는 중…</div>
          ) : (
            <>
              {rows.list.map((c) => {
                const id = c.conversation_id;
                if (editing === id) {
                  return (
                    <div key={id} className="rc-sess-item rc-sess-edit">
                      <input
                        ref={editRef}
                        className="rc-sess-input"
                        defaultValue={c.title || ""}
                        placeholder={label({ ...c, title: undefined })}
                        maxLength={120}
                        disabled={busy}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveRename(c, (e.target as HTMLInputElement).value); }
                          if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                      <button type="button" className="rc-sess-act" title="저장" aria-label="이름 저장" disabled={busy}
                              onClick={() => { const v = editRef.current?.value ?? ""; void saveRename(c, v); }}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M2.5 8.5l3.5 3.5 7.5-8" />
                        </svg>
                      </button>
                    </div>
                  );
                }
                if (confirming === id) {
                  return (
                    <div key={id} className="rc-sess-item rc-sess-confirm">
                      <span className="rc-sess-name">"{label(c)}" 삭제?</span>
                      <button type="button" className="rc-sess-act rc-sess-danger" disabled={busy}
                              onClick={() => void doDelete(c)}>{busy ? "삭제 중…" : "삭제"}</button>
                      <button type="button" className="rc-sess-act" disabled={busy} onClick={() => setConfirming(null)}>취소</button>
                    </div>
                  );
                }
                // 행 자체는 전환, 우측 hover 액션 = 이름변경·삭제(seed 는 삭제 없음 — 되돌아갈 자리).
                return (
                  <div key={id} role="menuitemradio" tabIndex={0}
                       aria-checked={id === ctx.conversationId}
                       className={"rc-sess-item" + (id === ctx.conversationId ? " on" : "")}
                       title={id}
                       onClick={() => { setOpen(false); if (id !== ctx.conversationId) onSwitch(id); }}
                       onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(false); if (id !== ctx.conversationId) onSwitch(id); } }}>
                    <span className="rc-sess-name">{label(c)}</span>
                    {c.last_started_at && <span className="rc-sess-time">{relTime(c.last_started_at)}</span>}
                    <span className="rc-sess-acts">
                      <button type="button" className="rc-sess-act" title="이름 바꾸기" aria-label="이름 바꾸기"
                              onClick={(e) => { e.stopPropagation(); setConfirming(null); setErr(null); setEditing(id); }}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M11.3 2.3a1.6 1.6 0 012.4 2.4L5.5 12.9l-3 .6.6-3z" />
                        </svg>
                      </button>
                      {id !== rows.seed && (
                        <button type="button" className="rc-sess-act" title="대화 삭제" aria-label="대화 삭제"
                                onClick={(e) => { e.stopPropagation(); setEditing(null); setErr(null); setConfirming(id); }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M2.5 4.5h11M6.5 2.5h3M5 4.5l.5 9h5l.5-9M6.8 7v4M9.2 7v4" />
                          </svg>
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              {err && <div className="rc-sess-note rc-sess-err">{err}</div>}
              {canBranch ? (
                <button type="button" className="rc-sess-new"
                        onClick={() => {
                          setOpen(false);
                          // 로컬 드래프트 좌표 — 서버 세션은 첫 발화 직전 session.create 가
                          // 발급한다(지연 민팅, §5.3-22). 그 전까지 목록에는 없다(빈 로컬 상태).
                          const next = siblingThread(ctx.conversationId);
                          onSwitch(next);
                        }}>
                  ＋ 새 대화
                </button>
              ) : (
                <div className="rc-sess-note">이 앱은 단일 대화입니다</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── 로그아웃 크로스뷰 동기화 ─────────────────────────────────────────────────
// 규약·구현은 @relay/chat auth-sync.ts 단일 소스(뷰 크롬 AuthWatch 와 공유 — 구 쌍둥이 수렴).

// 다중 pane 이 함께 떠도 감시는 1벌 — refcount 싱글턴.
let authWatchRefs = 0;
let authWatchCleanup: (() => void) | null = null;
function useAuthWatch(): void {
  useEffect(() => {
    if (authWatchRefs++ === 0) authWatchCleanup = installAuthWatch();
    return () => { if (--authWatchRefs === 0) { authWatchCleanup?.(); authWatchCleanup = null; } };
  }, []);
}

/** 계정 메뉴 — 현재 신원(email/principal) + 로그아웃. 위젯 헤더가 단일 소유라 core·저작 패키지
 *  전 인스턴스 뷰에 자동 노출된다(전송은 same-origin deployd 파사드 /api/me·/api/logout — 앱은
 *  토큰을 모른다). relay_edge 는 도메인 전역 쿠키 → 로그아웃은 모든 인스턴스 세션을 함께 종료한다.
 *  주의 — 인증 표면은 계약 밖·기판 소유다(client-protocol §2-5): 이 메뉴의 /api/me·/api/logout
 *  는 org 기판 잔류 어휘이고, principal 을 주입한 기판(org)에서만 렌더된다 — 무신원 loopback
 *  기판(OSS 기본, principal "local")은 헤더에서 이 메뉴 자체가 빠진다. */
function AccountMenu({ ctx }: { ctx: RelayCtx }) {
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<{ email?: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((m) => { if (alive) setMe(m || {}); }).catch(() => { if (alive) setMe({}); });
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => { alive = false; document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  const who = me?.email || (ctx.principal && ctx.principal !== "local" ? ctx.principal : "") || me?.id || "로그인됨";
  const logout = () => {
    if (busy) return;
    setBusy(true);
    // 쿠키 파기는 서버가 정본(POST 실패해도 로그인 화면으로). 게이트가 미인증을 302 /login 처리하므로
    // location 을 /login 으로 보내 즉시 재로그인 표면을 연다.
    fetch("/api/logout", { method: "POST" })
      .catch(() => { /* best-effort */ })
      .finally(() => {
        // relay_edge 는 도메인 전역 쿠키라 서버 세션은 전 뷰가 함께 끝난다 — 같은 브라우징
        // 컨텍스트의 다른 뷰(탭·다른 인스턴스)에도 즉시 알려 로그인 화면으로 보낸다
        // (수신 = relayjs AuthWatch + 이 위젯 installAuthWatch; 씬클라 분리 웹뷰는
        //  BroadcastChannel 이 안 닿아 focus 시 /api/me 재검사가 커버).
        broadcastLogout();
        window.location.href = "/login";
      });
  };

  return (
    <div className="rc-sess" ref={boxRef}>
      <button type="button" className="rc-head-btn" onClick={() => setOpen((o) => !o)}
              aria-haspopup="menu" aria-expanded={open} aria-label="계정" title="계정 · 로그아웃">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
        </svg>
      </button>
      {open && (
        <div className="rc-sess-menu" role="menu">
          <div className="rc-acct-id" title={who}>{who}</div>
          <button type="button" className="rc-sess-item rc-acct-out" onClick={logout} disabled={busy}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            <span className="rc-sess-name">{busy ? "로그아웃 중…" : "로그아웃"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 패널 헤더 — 위젯이 단일 소유(연결 상태 표시 + 대화 전환 + 계정 + 접기, agent-package-layout.md §4).
 *  "어떤 에이전트와 연결됐는가"를 항상 보여준다: main=인스턴스 제목(통합/front), 도킹=에이전트
 *  이름 + 스레드 키(param) 배지. live=false 는 히스토리 로딩 스켈레톤 단계(runtime 밖 — 정적 점). */
function ChatHeader({ ctx, live, onSwitch }: { ctx: RelayCtx; live: boolean; onSwitch?: (c: string) => void }) {
  // 로컬 스레드 문법 > 서버가 밝힌 세션 정체성(위임 대화 — §5.3-24 agent). 서버 발급 슬롯은
  // 문법을 못 실으므로(디렉토리명 제약) 이 폴백이 없으면 위임 대화가 착지 행세를 한다
  const rawBind = displayBinding(ctx.conversationId);
  const bind = rawBind.agent
    ? rawBind
    : { ...rawBind, agent: serverAgentOf(ctx.conversationId), param: serverParamOf(ctx.conversationId) };
  return (
    <header className="rc-head">
      {live ? <HeadDot /> : <span className="rc-dot" />}
      {/* 대상 칩 — 지금 누구와 말하는가(인스턴스 + 서브에이전트 도킹이면 :param 까지).
          대화함으로 대상을 바꿔도 ctx 가 정본이라 칩이 따라온다. */}
      {/* 칩에 ● 를 넣지 않는다 — 라이브 상태점(HeadDot)이 바로 왼쪽에 있어 중복. */}
      <span className="rc-head-target" title={ctx.instanceId + " · " + ctx.conversationId}>
        <span className="rc-chip"><span className="rc-chip-tx">{ctx.instanceId || ctx.title || "agent"}</span></span>
        {bind.agent && (
          <span className="rc-chip"><span className="rc-chip-slash" aria-hidden>/</span><span className="rc-chip-tx">{bind.agent}{bind.param ? ":" + bind.param : ""}</span></span>
        )}
      </span>
      <span className="rc-head-sp" />
      <InboxMenu ctx={ctx} onSwitch={onSwitch} />
      {onSwitch && <SessionMenu ctx={ctx} onSwitch={onSwitch} />}
      {/* 신원을 주입한 기판만 계정 표면이 있다(§2-5) — 무신원 기판에서 죽은 메뉴를 그리지 않는다. */}
      {ctx.principal && ctx.principal !== "local" && <AccountMenu ctx={ctx} />}
      {ctx.onClose && (
        <button type="button" className="rc-head-btn" onClick={ctx.onClose} aria-label="채팅 닫기" title="닫기">
          {/* X — "패널을 닫는다"를 직관적으로(구 chevron 은 '접기'로 읽히지 않았다). */}
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </header>
  );
}

/** 턴 종료 상태 칩 — 완료 / 중지됨 / 오류 / 미완료(끊김)를 어시스턴트 메시지 끝에 남긴다. 완료의
 *  신뢰 증거는 터미널 result 프레임(metadata.custom.durationMs/usage)으로, 라이브·히스토리 리플레이
 *  양쪽에서 동일하게 판정된다(브레인에 종료-상태 컬럼 없이 저장된 프레임만으로). result 프레임이
 *  없는데 실행 중도 아니면 = 깨끗이 끝나지 않은 것 → '미완료'로 표시해, 리플레이된 죽은 턴이
 *  "완료"처럼 조용히 보이던 문제(멈춘 건지 끝난 건지 구분 불가)를 메운다. 완료 칩은 토큰/시간도 겸한다.
 *  status 가 undefined 인 경우(리플레이 초기 메시지)는 터미널로 취급 — running 만 제외. */
function TurnStatusChip() {
  const statusType = useMessage((m) => m.status?.type);
  const reason = useMessage((m) => (m.status as any)?.reason as string | undefined);
  const meta = useMessage((m) => (m.metadata?.custom as TurnMeta | undefined));
  const hasContent = useMessage((m) => (m.content as readonly AnyPart[]).length > 0);
  if (statusType === "running") return null;
  // 정본은 어댑터/리플레이가 명시한 meta.ended — 라이브에선 result 프레임이 reducer 를 안 거쳐
  // usage/durationMs 로는 완료를 못 가리므로(그래서 예전엔 완료 턴이 늘 '미완료'로 찍혔다).
  // ended 가 없는 구(舊) 데이터만 usage/status.reason 휴리스틱으로 폴백한다.
  let kind: "ok" | "cancel" | "error" | "cut";
  if (meta?.ended) {
    kind = meta.ended === "ok" ? "ok" : meta.ended === "cancelled" ? "cancel" : meta.ended === "error" ? "error" : "cut";
  } else {
    const completed = !!meta && (typeof meta.durationMs === "number" || !!meta.usage);
    kind = completed ? "ok" : reason === "cancelled" ? "cancel" : reason === "error" ? "error" : "cut";
  }
  // 완료 프레임도 내용도 없는 빈 자리표시엔 칩을 달지 않는다(잡음 방지).
  if (kind === "cut" && !hasContent) return null;
  const dur = typeof meta?.durationMs === "number" ? ` · ${(meta!.durationMs! / 1000).toFixed(1)}s` : "";
  const out = meta?.usage?.output_tokens ?? 0;
  const icon = kind === "ok" ? "✓" : kind === "cancel" ? "■" : "⚠";
  const label =
    kind === "ok" ? `완료${dur}${out ? ` · ↓ ${out.toLocaleString()} tokens` : ""}`
    : kind === "cancel" ? "중지됨"
    : kind === "error" ? "오류로 중단됨"
    : "미완료 — 응답이 끊겼거나 중단됐어요";
  const title = kind === "ok" ? undefined
    : "이어서 진행하려면 이 대화에 메시지를 다시 보내세요 — 에이전트가 직전 작업 맥락을 이어받습니다.";
  // 실행 모델 배지 — 이 턴이 실제로 돈 모델(init 프레임 → 리플레이 turn row 폴백). 피커를
  // 중간에 바꿔도 "이 응답이 어느 모델이었는지"를 메시지에서 직접 확인하는 근거.
  const modelBadge = meta?.model ? (
    <span className="rc-ts-model" title={`${meta.model}${meta.effort ? ` · effort ${meta.effort}` : ""}`}>
      {modelLabelOf(meta.model)}
    </span>
  ) : null;
  return (
    <div className={"rc-turn-status " + kind} role="status" title={title}>
      <span className="rc-ts-ic" aria-hidden>{icon}</span>
      <span className="rc-ts-lb">{label}</span>
      {modelBadge}
    </div>
  );
}

/** 모델 id → 피커 라벨("Fable 5"). init 프레임 id 는 날짜 접미가 붙을 수 있어(claude-haiku-4-5-2025…)
 *  프리픽스 일치까지 허용한다. 목록 밖 id(BYO·신모델·카탈로그 미로드)는 id 에서 라벨을
 *  파생한다("claude-opus-5" → "Opus 5") — raw id 배지와 라벨 배지가 턴마다 섞이던 표시
 *  불일치(07-29 실측: claude-opus-5 vs Sonnet 5)의 봉합. 파생 불가 형태만 id 그대로. */
function modelLabelOf(id: string): string {
  const opts = modelOptions();
  const exact = opts.find((m) => m.id === id);
  if (exact) return exact.label;
  const pre = opts.find((m) => id.startsWith(m.id) || m.id.startsWith(id));
  if (pre) return pre.label;
  const m = /^claude-([a-z]+)((?:-\d+)*)$/.exec(id);
  if (m) {
    // 버전 세그먼트만 점 표기로(날짜 접미 8자리는 제외): claude-haiku-4-5-20251001 → "Haiku 4.5".
    const ver = m[2].split("-").filter((s) => s !== "" && s.length < 4).join(".");
    return m[1].charAt(0).toUpperCase() + m[1].slice(1) + (ver ? " " + ver : "");
  }
  return id;
}

/** "오후 3:24" — local time the message was sent. Live messages get createdAt on append;
 *  replayed history carries the stored turn time (runtime.loadHistory). */
function fmtTime(d?: Date): string {
  if (!d) return "";
  try { return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

/** 서버 주입 프롬프트 봉투 헤더(control 이 붙임 — turn.service 쌍둥이) — 이 프리픽스면
 *  사용자 말풍선 대신 시스템 칩으로 렌더한다(본문=모델 자기지시는 기계용이라 숨김).
 *  ⏰ = ScheduleWakeup 재진입 · 📬 = 위임 완료 배달 · 📋 = 백그라운드 continuation/유실
 *  (구 "📋 작업 완료"=task_dispatch 배달은 은퇴 — 히스토리 렌더 하위호환으로 유지). */
const SYSTEM_PROMPT_PREFIXES = ["⏰ 예약된 wake-up", "📬 위임 완료", "📋 작업 완료", "📋 백그라운드"] as const;

/** "+ 패키지" 착지 요청(author-request 프롬프트) — 말풍선 대신 전용 카드. 마커가 출처
 *  (호출 인스턴스)를 나른다: "[저작 요청 · monitor]" → 헤더 칩 [● monitor] 에서 온 저작 요청.
 *  본문 = 마커 다음 줄부터 구분선(--- 또는 골든패스 보일러플레이트) 전까지, "이름 제안:" 은 칩.
 *  (구 마커 "[지도에서 착지한 저작 요청]" 은 하위호환 — 출처 monitor 로 폴백.) */
const AUTHOR_REQUEST_RE = /^\[저작 요청 · ([^\]]+)\]/;
const AUTHOR_REQUEST_LEGACY = "[지도에서 착지한 저작 요청]";
function authorRequestOrigin(text: string): string | null {
  const m = text.match(AUTHOR_REQUEST_RE);
  if (m) return m[1].trim();
  if (text.startsWith(AUTHOR_REQUEST_LEGACY)) return "monitor";
  return null;
}
function AuthorRequestCard({ text, time, origin }: { text: string; time: string; origin: string }) {
  const marker = text.match(AUTHOR_REQUEST_RE)?.[0] ?? AUTHOR_REQUEST_LEGACY;
  const rest = text.slice(marker.length).replace(/^\n/, "");
  const cut = (() => {
    const sep = rest.indexOf("\n---\n");
    if (sep >= 0) return rest.slice(0, sep);
    const bp = rest.indexOf("\n그래프 델타 골든패스");
    return bp >= 0 ? rest.slice(0, bp) : rest;
  })().trim();
  const nameM = cut.match(/^이름 제안:\s*(.+)$/m);
  const body = cut.replace(/^이름 제안:.*$/m, "").trim();
  return (
    <MessagePrimitive.Root className="rc-msg rc-author">
      <div className="rc-author-card" title={origin + " 에서 착지한 저작 요청 — 산출물은 그래프 델타(패키지 diff + Edge 신청 + publish)"}>
        <div className="rc-author-head">
          <span className="rc-chip"><span className="rc-chip-dot" aria-hidden /><span className="rc-chip-tx">{origin}</span></span>
          <span className="rc-author-badge">에서 온 저작 요청</span>
          {time ? <span className="rc-wake-time">· {time}</span> : null}
        </div>
        <div className="rc-author-body">{body}</div>
        {nameM ? <div className="rc-author-meta"><span className="rc-chip"><span className="rc-chip-slash" aria-hidden>#</span><span className="rc-chip-tx">{nameM[1].trim()}</span></span></div> : null}
      </div>
    </MessagePrimitive.Root>
  );
}

/** a2a 위임 요청 마커(turn.service dispatchDelegate 쌍둥이) — 다른 에이전트가 mission 계약으로
 *  보낸 요청이다. 사용자 말풍선 대신 발신 에이전트 아이콘 칩 카드로 렌더해, ①누가 ②무슨 mission
 *  으로 보냈는지 + ③사용자가 직접 친 게 아님을 명시한다. origin=발신 인스턴스 slug —
 *  아이콘은 열거 닫힌 shape 의 icon 값(§5.6-32)만 쓴다(구 /i/<slug>/f/assets 경로 조립 은퇴). */
const A2A_REQUEST_RE = /^\[에이전트 요청 · ([^\]→]+?)(?:\s*→\s*([^\]]+))?\]/;
function a2aRequest(text: string): { origin: string; mission: string | null } | null {
  const m = text.match(A2A_REQUEST_RE);
  if (!m) return null;
  return { origin: m[1].trim(), mission: m[2]?.trim() || null };
}
/** 발신 에이전트 패키지 아이콘 — instances.list 행의 icon(기판 제공 값)만. 없으면 생략
 *  (칩은 이름만 남음). 클라이언트 자산 경로 조립 금지(§2-6). */
function AgentIcon({ slug }: { slug: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void iconUrlForInstance(slug).then((u) => { if (alive) setSrc(u); });
    return () => { alive = false; };
  }, [slug]);
  if (!src) return null;
  return (
    <img
      className="rc-agent-ic"
      src={src}
      alt=""
      aria-hidden
      onError={(e) => { e.currentTarget.style.display = "none"; }}
    />
  );
}
/** 서브에이전트 디스패치 마커(turn.service dispatch 쌍둥이) — 오케스트레이터가 같은 인스턴스의
 *  서브에이전트에게 agent_dispatch 로 자동 전달한 지시(사용자 직접 입력이 아님). 인스턴스 slug 로
 *  아이콘을, 서브에이전트 이름을 라벨로 띄운다. [서브에이전트 · <instanceSlug> · <subAgent>] */
const SUBAGENT_RE = /^\[서브에이전트 · ([^\]·]+?) · ([^\]]+)\]/;
function subAgentDispatch(text: string): { inst: string; agent: string } | null {
  const m = text.match(SUBAGENT_RE);
  if (!m) return null;
  return { inst: m[1].trim(), agent: m[2].trim() };
}
function SubAgentDispatchCard({ text, time, inst, agent }: { text: string; time: string; inst: string; agent: string }) {
  const marker = text.match(SUBAGENT_RE)?.[0] ?? "";
  const body = text.slice(marker.length).replace(/^\n/, "").trim();
  const ctx = useRelayCtx();
  const [seeking, setSeeking] = useState(false);
  return (
    <MessagePrimitive.Root className="rc-msg rc-author">
      <div className="rc-author-card" title={`${inst} 오케스트레이터가 서브에이전트 ${agent} 에게 자동 전달한 지시 · 사용자가 직접 입력한 메시지가 아닙니다`}>
        <div className="rc-author-head">
          <span className="rc-chip"><AgentIcon slug={inst} /><span className="rc-chip-tx">{agent}</span></span>
          <span className="rc-author-badge">서브에이전트 위임</span>
          {time ? <span className="rc-wake-time">· {time}</span> : null}
        </div>
        {body ? <div className="rc-author-body">{body}</div> : null}
        {ctx.instanceId ? (
          <button type="button" className="rc-author-act" disabled={seeking}
            title="이 위임이 진행되는 대화를 탭으로 엽니다 — 보고와 질문이 거기 뜹니다"
            onClick={async () => {
              setSeeking(true);
              const ok = await openDispatchConversation(ctx.instanceId, ctx.principal, agent, "");
              setSeeking(false);
              if (!ok) alert("이 위임의 대화를 아직 찾지 못했습니다 — 잠시 뒤 다시 눌러 주세요");
            }}>
            {seeking ? "찾는 중…" : "이 작업의 대화 열기"}
          </button>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}
function A2ARequestCard({ text, time, origin, mission }: { text: string; time: string; origin: string; mission: string | null }) {
  const marker = text.match(A2A_REQUEST_RE)?.[0] ?? "";
  let rest = text.slice(marker.length).replace(/^\n/, "");
  // "왜" 줄(↳ …) — 마커 다음 줄에 실려 온 edge.reason(있을 때만). 본문과 분리해 부제로 띄운다.
  let reason: string | null = null;
  const rm = rest.match(/^↳ (.+?)(?:\n|$)/);
  if (rm) { reason = rm[1].trim(); rest = rest.slice(rm[0].length); }
  const body = rest.trim();
  return (
    <MessagePrimitive.Root className="rc-msg rc-author">
      <div className="rc-author-card" title={`${origin} 에이전트가 보낸 요청${mission ? ` — ${mission} 미션` : ""}${reason ? `\n왜: ${reason}` : ""}\n· 사용자가 직접 입력한 메시지가 아닙니다`}>
        <div className="rc-author-head">
          <span className="rc-chip"><AgentIcon slug={origin} /><span className="rc-chip-tx">{origin}</span></span>
          <span className="rc-author-badge">에이전트 요청{mission ? ` · ${mission}` : ""}</span>
          {time ? <span className="rc-wake-time">· {time}</span> : null}
        </div>
        {reason ? <div className="rc-author-why">↳ {reason}</div> : null}
        {body ? <div className="rc-author-body">{body}</div> : null}
      </div>
    </MessagePrimitive.Root>
  );
}

/** 스킬 호출 마커 — 스튜디오 "스킬에서 시작" 류가 자동 전송하는 턴. 사용자 말풍선 대신
 *  전용 카드(✦ 스킬 칩 + 지시 본문)로 렌더한다(AuthorRequestCard 문법 재사용 — 본문은
 *  기계용 지시라 접지 않고 그대로 보여 준다: 파일이 정본 교리와 같은 투명성). */
const SKILL_INVOKE_RE = /^\[스킬 · ([^\]]+)\]\s*/;
function SkillInvokeCard({ text, time }: { text: string; time: string }) {
  const m = text.match(SKILL_INVOKE_RE)!;
  const name = m[1].trim();
  const body = text.slice(m[0].length).trim();
  return (
    <MessagePrimitive.Root className="rc-msg rc-author">
      <div className="rc-author-card" title="스킬 호출 — 빌더가 이 스킬의 저작 지식으로 스캐폴드합니다">
        <div className="rc-author-head">
          <span className="rc-chip"><span className="rc-chip-slash" aria-hidden>✦</span><span className="rc-chip-tx">{name}</span></span>
          <span className="rc-author-badge">스킬로 시작</span>
          {time ? <span className="rc-wake-time">· {time}</span> : null}
        </div>
        {body ? <div className="rc-author-body">{body}</div> : null}
      </div>
    </MessagePrimitive.Root>
  );
}

/** 사용자 메시지의 이미지 파트(+저작 시 실은 filename 확장) — 첨부 칩·라이트박스가 소비. */
type UserImagePart = { type: "image"; image: string; filename?: string };

/** 첨부 이미지 칩 — [썸네일][파일명][실측 W×H]. 클릭 = 라이트박스(크게 보기). */
function AttOpenChip({ part, onOpen }: { part: UserImagePart; onOpen: () => void }) {
  const [dim, setDim] = useState("");
  return (
    <button type="button" className="rc-att-open" title={(part.filename || "이미지") + " — 클릭해서 크게 보기"} onClick={onOpen}>
      <img src={part.image} alt="" aria-hidden
           onLoad={(e) => { const im = e.currentTarget; if (im.naturalWidth) setDim(im.naturalWidth + "×" + im.naturalHeight); }} />
      <span className="rc-att-open-name">{part.filename || "image"}</span>
      {dim && <span className="rc-att-open-dim">{dim}</span>}
    </button>
  );
}

/** 이미지 라이트박스 — body 포털 전체 덮개. 우상단 X·배경 클릭·Escape 로 닫는다. */
function ImageLightbox({ src, name, onClose }: { src: string; name?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="rc-lightbox" role="dialog" aria-modal="true" aria-label={name || "이미지 크게 보기"} onClick={onClose}>
      <button type="button" className="rc-lightbox-x" aria-label="닫기" onClick={onClose}>×</button>
      <img className="rc-lightbox-img" src={src} alt={name || ""} onClick={(e) => e.stopPropagation()} />
      {name && <div className="rc-lightbox-name">{name}</div>}
    </div>,
    document.body,
  );
}

/** Parts 의 기본 이미지 렌더 억제 — 첨부는 위 칩 행이 전담(세로 나열 방지). */
const NullImagePart = () => null;

function UserMessage() {
  const time = useMessage((m) => fmtTime(m.createdAt));
  const text = useMessage((m) => {
    const p = (m.content as readonly AnyPart[] | undefined)?.[0] as { type?: string; text?: string } | undefined;
    return p?.type === "text" ? String(p.text ?? "") : "";
  });
  const content = useMessage((m) => m.content as readonly AnyPart[] | undefined);
  const images = useMemo(
    () => ((content ?? []) as any[]).filter((p): p is UserImagePart => p?.type === "image" && typeof p.image === "string"),
    [content],
  );
  const [lightbox, setLightbox] = useState<UserImagePart | null>(null);
  if (SKILL_INVOKE_RE.test(text)) return <SkillInvokeCard text={text} time={time} />;
  const a2a = a2aRequest(text);
  if (a2a) return <A2ARequestCard text={text} time={time} origin={a2a.origin} mission={a2a.mission} />;
  const sub = subAgentDispatch(text);
  if (sub) return <SubAgentDispatchCard text={text} time={time} inst={sub.inst} agent={sub.agent} />;
  const authorOrigin = authorRequestOrigin(text);
  if (authorOrigin) return <AuthorRequestCard text={text} time={time} origin={authorOrigin} />;
  if (SYSTEM_PROMPT_PREFIXES.some((p) => text.startsWith(p))) {
    const head0 = text.split("\n", 1)[0];
    // "📬 위임 완료 — ↳ agent-builder · diary(완료)" 같은 기계 머리는 사람 말로 — 내부 이름(세션
    // 라벨·서브에이전트 slug)을 화면에 내지 않는다. 성패만 남긴다
    const delivered = head0.startsWith("📬 위임 완료");
    const head = delivered
      ? `📬 맡긴 작업이 끝났습니다${/\(실패\)\s*$/.test(head0) ? " — 실패" : /\(중단\)\s*$/.test(head0) ? " — 중단됨" : ""}`
      : head0;
    return (
      <MessagePrimitive.Root className="rc-msg rc-wake">
        <div className="rc-wake-chip" title={delivered ? "다른 대화에서 맡긴 작업의 결과가 이 대화로 배달됐습니다 — 아래 답이 그 결과입니다" : "예약된 시각에 에이전트가 스스로 깨어난 턴입니다"}>
          {head}
          {time ? <span className="rc-wake-time"> · {time}</span> : null}
        </div>
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className="rc-msg rc-user">
      <div className="rc-row">
        {time && <span className="rc-time">{time}</span>}
        <div className="rc-bubble">
          {images.length > 0 && (
            <div className="rc-att-row">
              {images.map((p, i) => <AttOpenChip key={i} part={p} onOpen={() => setLightbox(p)} />)}
            </div>
          )}
          <MessagePrimitive.Parts components={{ Image: NullImagePart }} />
        </div>
      </div>
      {lightbox && <ImageLightbox src={lightbox.image} name={lightbox.filename} onClose={() => setLightbox(null)} />}
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  // MessagePrimitive.Parts(파트별 독립 렌더) 대신 파트 배열을 직접 그룹화해 렌더한다 —
  // 연속 스텝을 한 타임라인으로 묶고 완료 시 접으려면 파트 간 관계를 봐야 하기 때문.
  const content = useMessage((m) => m.content as readonly AnyPart[]);
  const running = useMessage((m) => m.status?.type === "running");
  const durationMs = useMessage((m) => (m.metadata?.custom as TurnMeta | undefined)?.durationMs);
  // 이 턴에 무대에 앉은 산출물 — 실황은 봉투 file 이벤트, 재생은 이력의 files 가 채운다
  const stageFiles = useMessage((m) => (m.metadata?.custom as TurnMeta | undefined)?.files);
  const groups = useMemo(() => groupParts(content), [content]);
  const lastTrace = groups.reduce((acc, g, i) => (g.kind === "trace" ? i : acc), -1);
  return (
    <MessagePrimitive.Root className="rc-msg rc-assistant">
      {groups.map((g, i) => {
        const isLast = i === groups.length - 1;
        if (g.kind === "md") return <MdBlock key={i} text={g.text} streaming={running && isLast} />;
        if (g.kind === "plan") return <PlanCard key={i} todos={g.todos} active={running} />;
        if (g.kind === "ask") return <AskCard key={i} part={g.part} active={running} />;
        if (g.kind === "steer") return <SteerCard key={i} part={g.part} />;
        if (g.kind === "choice") return <ChoiceCard key={i} part={g.part} />;
        if (g.kind === "files") return <FileCard key={i} part={g.part} />;
        return (
          <TraceTimeline key={i} steps={g.steps} running={running && isLast}
                         durationMs={i === lastTrace ? durationMs : undefined} />
        );
      })}
      {stageFiles?.length ? <StageFiles paths={stageFiles} /> : null}
      <RunningStatus />
      <TurnStatusChip />
    </MessagePrimitive.Root>
  );
}

type Chip = { icon: "dot" | "slash"; text: string };

/** ctx → 대상 칩 파생 — [● 인스턴스] + 서브에이전트 도킹이면 [/ 에이전트:param].
 *  헤더·컴포저가 같은 파생을 쓴다: "지금 누구와 말하는가"는 항상 ctx 가 정본
 *  (대화함으로 대상을 바꿔도 칩이 따라온다 — host 주입 칩은 보조). */
function targetChipsOf(ctx: RelayCtx): Chip[] {
  const bind = displayBinding(ctx.conversationId);
  // 로컬 스레드 문법 > 서버가 밝힌 세션 정체성(§5.3-21 agent) — 위임 세션은 기판 발급
  // 슬롯이라 문법을 못 실으므로, 이 폴백이 없으면 컴포저가 [● 인스턴스]만 남아
  // 착지 에이전트 행세를 한다(실사용 보고 2026-08-20 — 헤더만 고치고 이 파생을 놓쳤었다)
  const agent = bind.agent || serverAgentOf(ctx.conversationId);
  const param = bind.param || serverParamOf(ctx.conversationId);
  const chips: Chip[] = [];
  if (ctx.instanceId) chips.push({ icon: "dot", text: ctx.instanceId });
  // 작업 대상이 여럿이면 목록으로 편다 — "agent-builder:task, calendar"(좌표는 쉼표 무공백).
  if (agent) chips.push({ icon: "slash", text: agent + (param ? ":" + paramTargets(param).join(", ") : "") });
  return chips;
}

/** 입력창 위 컨텍스트 칩들 — 대상 칩(ctx 파생, 정본) + host 주입 칩(__relaySetChip — 보조,
 *  대상과 중복되는 dot/slash 는 접는다). */
function ContextChips({ onSend }: { onSend: (text: string) => void }) {
  const ctx = useRelayCtx();
  const [hostChips, setHostChips] = useState<Chip[]>(() => {
    const w = window as unknown as { __RELAY_CONTEXT?: { chips?: Chip[] } };
    const c = w.__RELAY_CONTEXT && w.__RELAY_CONTEXT.chips;
    return Array.isArray(c) ? c : [];
  });
  useEffect(() => {
    const w = window as unknown as { __relaySetChip?: (l: Chip[] | null) => void };
    w.__relaySetChip = (list) => setHostChips(Array.isArray(list) ? list : []);
    return () => { w.__relaySetChip = undefined; };
  }, []);
  const derived = targetChipsOf(ctx);
  const hasSlash = derived.some((c) => c.icon === "slash");
  const host = hostChips.filter((c) => c.icon !== "dot" && !(hasSlash && c.icon === "slash"));
  // 대상 칩은 셸이 전환 훅을 줄 때만 조작 가능하다(전용 /chat 문서 등 셸 없는 마운트는 표시 전용).
  const target = useContext(PaneTargetCtx);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  // 피커는 칩에 붙는 카드다(모델 메뉴와 같은 자리) — 밖을 누르거나 Esc 면 닫는다, 같은 규약.
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!picking && !adding) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setPicking(false); setAdding(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setPicking(false); setAdding(false); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [picking, adding]);
  // 대상 축은 에이전트에 바인딩된 대화에만 있다(main 대화엔 워크벤치 개념이 없다).
  const hasTargetAxis = !!(displayBinding(ctx.conversationId).agent || serverAgentOf(ctx.conversationId));
  if (!derived.length && !host.length) return null;

  const chipBody = derived.map((c, i) => (
    <span className="rc-chip-part" key={i}>
      {c.icon === "slash"
        ? <span className="rc-chip-slash" aria-hidden>/</span>
        : <span className="rc-chip-dot" aria-hidden />}
      <span className="rc-chip-tx">{c.text}</span>
    </span>
  ));
  const label = derived.map((c) => c.text).join(" / ");

  return (
    <div className="rc-chips">
      {derived.length > 0 && (target ? (
        <span className="rc-chip-wrap" ref={wrapRef}>
          <button type="button" className="rc-chip rc-chip-btn" title={label + " — 클릭해서 대상 바꾸기"}
                  aria-haspopup="listbox" aria-expanded={picking} onClick={() => { setAdding(false); setPicking((v) => !v); }}>
            {chipBody}
            <span className="rc-chip-caret" aria-hidden>▾</span>
          </button>
          {picking && <TargetPicker ctx={ctx} target={target} onSend={onSend} onClose={() => setPicking(false)} />}
          {hasTargetAxis && (
            <button type="button" className="rc-chip rc-chip-add" title="작업 대상 추가 — 이 대화에서 함께 볼 워크벤치"
                    aria-haspopup="listbox" aria-expanded={adding} onClick={() => { setPicking(false); setAdding((v) => !v); }}>+</button>
          )}
          {adding && <TargetAddPicker ctx={ctx} target={target} onSend={onSend} onClose={() => setAdding(false)} />}
        </span>
      ) : (
        <span className="rc-chip" title={label}>{chipBody}</span>
      ))}
      {host.map((c, i) => (
        <span className="rc-chip" key={"h" + i} title={c.text}>
          <span className="rc-chip-slash" aria-hidden>/</span>
          <span className="rc-chip-tx">{c.text}</span>
        </span>
      ))}
    </div>
  );
}

/** 대상 피커 — 잘못 열린 대화를 올바른 좌표로 고친다. 항목은 셋: ①지금 보고 있는 페이지의 슬롯
 *  (워크벤치 param 까지 실린 좌표 — @멘션이 못 만드는 형태다) ②relay.yaml 에 선언된 에이전트
 *  ③기본 대화. 빈 대화면 제자리 교체(무손실), 이미 말이 오갔으면 그 좌표의 대화로 이동한다. */
function TargetPicker({ ctx, target, onSend, onClose }: { ctx: RelayCtx; target: PaneTarget; onSend: (text: string) => void; onClose: () => void }) {
  const empty = useThread((t) => t.messages.length === 0);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  useEffect(() => {
    let alive = true;
    loadAgents(ctx).then((a) => { if (alive) setAgents(a); });
    return () => { alive = false; };
  }, [ctx.conversationId]);

  // 다른 인스턴스("포털의 에이전트") — 같은 목록에 올리되 성격이 다르다: 이 인스턴스 안의 교체는
  // 제자리(빈 대화면 무손실)지만, 인스턴스 이동은 워크스페이스·도구·자격이 통째로 다른 곳이라
  // 항상 새 탭이다. 그래서 ↗ 로 표시해 "여기가 바뀐다"와 "저기로 간다"를 눈으로 가른다.
  const [insts, setInsts] = useState<NavInstance[]>([]);
  useEffect(() => {
    let alive = true;
    loadInstances().then((r) => { if (alive) setInsts(r.filter((i) => i.id !== ctx.instanceId)); });
    return () => { alive = false; };
  }, [ctx.instanceId]);

  const cur = displayBinding(ctx.conversationId);
  const curFamily = threadFamily(ctx.conversationId);
  const curTargets = paramTargets(cur.param);
  const page = target.getPageSlot();
  const pageConv = page && page.instanceId === ctx.instanceId ? page.conversationId : "";
  const pageBind = pageConv ? displayBinding(pageConv) : null;
  const label = (conv: string) => {
    const b = displayBinding(conv);
    return b.agent ? b.agent + (b.param ? ":" + paramTargets(b.param).join(", ") : "") : "기본 대화";
  };

  // 대상 **추가**는 여기 없다 — 칩 옆 [+] 버튼(TargetAddPicker)이 소유한다. 이 목록은 교체 전용:
  // 두 동작을 한 목록에 섞으면 "바꾸는 건지 더하는 건지"가 매번 헷갈린다.
  type Item = { key: string; name: string; desc: string; run: () => void };
  const items: Item[] = [];
  if (pageConv && threadFamily(pageConv) !== curFamily) {
    items.push({
      key: "page",
      name: label(pageConv),
      desc: "지금 보고 있는 화면의 대상으로 맞춥니다",
      run: () => target.retarget(pageConv, empty),
    });
  }
  for (const a of agents) {
    const conv = "agent-" + a.name;
    if (threadFamily(conv) === curFamily) continue;
    items.push({
      key: conv, name: a.name,
      desc: (a.default ? "기본 에이전트 · " : "") + "이 에이전트를 대상으로",
      run: () => target.retarget(conv, empty),
    });
  }
  if (curFamily !== "main") {
    items.push({ key: "main", name: "기본 대화", desc: "이 인스턴스의 대표 대화로", run: () => target.retarget("main", empty) });
  }

  return (
    <div className="rc-pick-card rc-target-pick" role="listbox" aria-label="대화 대상 바꾸기">
      <div className="rc-target-note">
        {empty ? "빈 대화라 이 자리에서 대상만 바뀝니다" : "말이 오간 대화는 그대로 두고 그 대상의 대화로 이동합니다"}
      </div>
      {items.length === 0 ? (
        <div className="rc-target-note">이 에이전트 안에서 바꿀 수 있는 다른 대상이 없습니다</div>
      ) : items.map((it) => (
        <button type="button" key={it.key} role="option" aria-selected={false} className="rc-pick-item"
                onPointerDown={(e) => { e.preventDefault(); it.run(); onClose(); }}>
          <span className="rc-pick-text">
            <span className="rc-pick-main">{it.name}</span>
            <span className="rc-pick-sub">{it.desc}</span>
          </span>
        </button>
      ))}
      {insts.length > 0 && (
        <>
          <div className="rc-target-sec">다른 에이전트 — 새 탭으로 열립니다</div>
          {insts.map((i) => (
            <button type="button" key={i.id} role="option" aria-selected={false} className="rc-pick-item"
                    onPointerDown={(e) => { e.preventDefault(); target.openInstance(i.id); onClose(); }}>
              <span className="rc-pick-text">
                <span className="rc-pick-main"><span className="rc-target-out" aria-hidden>↗</span> {i.id}</span>
                <span className="rc-pick-sub">{i.pkg || (i.kind === "base" ? "코어 도구" : "에이전트")}</span>
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** 대상 추가 피커([+]) — 같은 에이전트의 다른 워크벤치를 이 대화에 **더한다**(param 목록).
 *  후보 열거원은 지금 페이지 슬롯 + **내가 대화한 적 있는 워크벤치**(loadInbox) 뿐이다 — 위젯이
 *  부를 수 있는 메서드에 패키지 열거가 없어서다(transport 화이트리스트). 그래서 한 번도 대화하지
 *  않은 패키지는 뜨지 않는다 — 그 갭은 control-ts 열거 엔드포인트로 따로 메운다.
 *  적용: 빈 대화면 좌표에 실어 제자리 교체, 말이 오갔으면 좌표는 그대로 두고 한 줄로 알린다
 *  (대상 추가 때문에 대화가 둘로 갈라지지 않게 — param 은 서버에서 프롬프트 한 줄이라 결과가 같다). */
function TargetAddPicker({ ctx, target, onSend, onClose }: { ctx: RelayCtx; target: PaneTarget; onSend: (text: string) => void; onClose: () => void }) {
  const empty = useThread((t) => t.messages.length === 0);
  const cur = displayBinding(ctx.conversationId);
  const curTargets = paramTargets(cur.param);
  const [rows, setRows] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    loadInbox(ctx)
      .then((rs) => { if (alive) setRows(rs.filter((r) => r.instance === ctx.instanceId).map((r) => r.conversation_id)); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [ctx.instanceId, ctx.conversationId]);

  const page = target.getPageSlot();
  const pageConv = page && page.instanceId === ctx.instanceId ? page.conversationId : "";
  // 선언된 대상(뷰가 아는 "갈 수 있는 곳")이 먼저, 그다음 대화 이력에서 발견한 것("가 본 곳").
  const declared = target.getPageTargets().filter((t) => t && !curTargets.includes(t));
  const found = targetCandidates([pageConv, ...(rows || [])].filter(Boolean), cur.agent, [...curTargets, ...declared]);
  const candidates = [...declared, ...found];
  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const apply = () => {
    if (!picked.length) return;
    if (empty) target.retarget(withTargets(cur.agent, [...curTargets, ...picked]), true);
    else onSend("[작업 대상 추가] " + picked.join(", ") + " — 이 대화에서 함께 다뤄 주세요.");
    onClose();
  };

  return (
    <div className="rc-pick-card rc-target-pick" role="listbox" aria-label="작업 대상 추가" aria-multiselectable>
      <div className="rc-target-note">
        {"지금 대상: " + (curTargets.length ? curTargets.join(", ") : "없음")}
        {empty ? " · 빈 대화라 이 자리에서 더해집니다" : " · 대화는 그대로 두고 대상만 더합니다"}
      </div>
      {rows === null ? (
        <div className="rc-target-note">불러오는 중…</div>
      ) : candidates.length === 0 ? (
        <div className="rc-target-note">더할 수 있는 대상이 없습니다 — 그 워크벤치를 한 번 열어 보면 여기 목록에 잡힙니다</div>
      ) : (
        <>
          {candidates.map((t) => (
            <button type="button" key={t} role="option" aria-selected={picked.includes(t)}
                    className={"rc-pick-item rc-target-opt" + (picked.includes(t) ? " on" : "")}
                    onPointerDown={(e) => { e.preventDefault(); toggle(t); }}>
              <span className="rc-pick-text">
                <span className="rc-pick-main"><span className="rc-target-box" aria-hidden>{picked.includes(t) ? "☑" : "☐"}</span> {t}</span>
              </span>
            </button>
          ))}
          <button type="button" className="rc-target-apply" disabled={!picked.length}
                  onPointerDown={(e) => { e.preventDefault(); apply(); }}>
            {picked.length ? picked.join(", ") + " 함께 보기" : "대상을 고르세요"}
          </button>
        </>
      )}
    </div>
  );
}

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

/** 메뉴 바닥의 추론 강도 줄 — "Effort (High)" + 5점 슬라이더(low→max). 오버라이드가 없으면
 *  노브가 실효 기본(브레인이 보고한 레벨)에 **빈 원**으로 앉고, 점을 누르면 명시(꽉 찬 원),
 *  켜진 명시 점을 다시 누르면 기본으로. ←/→·↑/↓ 로도 옮긴다. 대화별로 브레인에 저장.
 *  effort 는 하네스 capability 의 투영이다(§7) — 안 받는 하네스(codex 등)면 줄 자체를 비운다. */
function EffortRow() {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const ask = () => hasEffort().then((v) => { if (alive) setSupported(v); });
    void ask();
    const off = onOverridesChanged(() => { void ask(); });
    return () => { alive = false; off(); };
  }, []);
  const ctx = useRelayCtx();
  const [effort, setEffortState] = useState("");            // per-conversation override ("" = default)
  const [defaultEffort, setDefaultEffort] = useState("high"); // effective level when unset (from brain)
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => loadEffort(ctx).then((info) => { if (alive) { setEffortState(info.override); setDefaultEffort(info.defaultEffort); setLoaded(true); } });
    void load();
    const off = onOverridesChanged(() => { void load(); }); // /effort 빌트인 반영
    return () => { alive = false; off(); };
  }, [ctx.conversationId]);

  const isDefault = !effort;
  const shownLevel = isDefault ? defaultEffort : effort;
  const shownIdx = EFFORT_LEVELS.indexOf(shownLevel as (typeof EFFORT_LEVELS)[number]);
  // ModelPicker.setModelId 와 같은 규약 — 저장 실패를 표시하고 서버 정본으로 수렴시킨다.
  const [err, setErr] = useState(false);
  const set = (v: string) => {
    setErr(false); setEffortState(v);
    void setEffort(ctx, v).then((ok) => { if (!ok) setErr(true); notifyOverridesChanged(); });
  };
  const label = EFFORT_LABELS[shownLevel] || shownLevel;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault(); set(EFFORT_LEVELS[Math.min(EFFORT_LEVELS.length - 1, shownIdx + 1)]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault(); set(EFFORT_LEVELS[Math.max(0, shownIdx - 1)]);
    }
  };
  if (supported === false) return null;

  return (
    <div className={"rc-pick-foot" + (loaded ? "" : " rc-model-loading")}
         title="추론 강도 — 이 대화에만 적용, 다음 응답부터. 점을 눌러 설정 · 켜진 점을 다시 누르면 기본값(빈 원). 빈 원 위치가 이 대화가 기본으로 실행되는 레벨입니다.">
      <svg className="rc-pick-foot-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 9.5v5M6.5 7v10M17.5 7v10M20 9.5v5M6.5 12h11" />
      </svg>
      <span className="rc-pick-foot-lb">Effort <span className={"rc-pick-foot-val" + (isDefault ? " ghost" : "")}>({label})</span>{err && <span className="rc-save-err">저장 실패</span>}</span>
      <div className="rc-effort-track" role="slider" tabIndex={loaded ? 0 : -1}
           aria-label="추론 강도" aria-valuemin={0} aria-valuemax={EFFORT_LEVELS.length}
           aria-valuenow={shownIdx + 1} aria-valuetext={label} onKeyDown={onKeyDown}>
        {EFFORT_LEVELS.map((lv, i) => {
          const on = i === shownIdx;
          return (
            <button type="button" key={lv} className="rc-effort-step"
              onClick={() => set(effort === lv ? "" : lv)}
              aria-label={EFFORT_LABELS[lv] || lv} title={EFFORT_LABELS[lv] || lv}>
              <span className={"rc-effort-dot" + (i <= shownIdx ? " lit" : "") + (on ? " on" : "") + (on && isDefault ? " ghost" : "")} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 공급자 표시명 — llm.provider 는 소문자 어휘라 화면용으로만 다듬는다. 모르는 값은 그대로. */
const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", vllm: "vLLM", moonshot: "Moonshot", google: "Google" };
function providerLabelOf(v: { name: string; provider?: string }): string {
  if (!v.provider) return v.name;
  return PROVIDER_LABEL[v.provider] ?? v.provider[0].toUpperCase() + v.provider.slice(1);
}
/** 트리거에 보이는 하네스 짧은 이름 — "claude-code" → "Claude", "codex" → "Codex".
 *  피드백(2026-08-26): 바깥엔 "기본"이란 말 없이 무엇으로 도는지 한 단어면 된다. */
function harnessShortOf(name: string): string {
  const w = name.split("-")[0] || name;
  return w[0].toUpperCase() + w.slice(1);
}

/** 한 버튼 안의 모델 선택 — 왼쪽은 공급자(하네스 변형, capability harness-variants), 오른쪽은
 *  호버한 공급자의 모델 카탈로그. 옛 HarnessSelector + ModelSelector 를 합친 것(2026-08-26):
 *  두 버튼이 나란히 있으면 "Harness" 라는 말을 알아야 모델을 바꿀 수 있었다.
 *  - 변형이 하나뿐(또는 미선언)이면 왼쪽 단을 그리지 않고 모델 목록만 편다.
 *  - 오른쪽 단은 공급자에 **호버(포커스)해야** 열린다. 활성이 아닌 공급자도 전환 없이 그 목록을
 *    보여준다(`?variant=` 조회). 거기서 모델을 고르면 전환+지정이 한 요청으로 간다.
 *  - 모델 줄은 이 대화의 오버라이드(다음 응답부터). "기본"은 인스턴스 바인딩을 따른다. */
function ModelPicker() {
  const ctx = useRelayCtx();
  // ── 공급자(하네스) 축 ──
  const [active, setActive] = useState<string | null>(null);
  const [variants, setVariants] = useState<{ name: string; provider?: string }[]>([]);
  const [hErr, setHErr] = useState(false);
  // 전환은 성공했는데 그 하네스가 준비되지 않은 경우(도구 미설치·설치 파손·미로그인).
  // 다음 턴이 실패할 때까지 침묵하지 않는다 — 처방은 어댑터 setup 이 이미 문장으로 준다.
  const [notReady, setNotReady] = useState("");
  // 변형이 하나뿐(capability 미선언)이면 variants 가 비고 active 도 null — 그때는 harness.info 의
  // 이름으로 트리거를 채운다. "기본"만으로는 무엇으로 도는지 모른다는 피드백의 연장.
  const [soloName, setSoloName] = useState<string | null>(null);
  const loadVariants = useCallback(() => {
    void loadHarnessVariants().then((r) => {
      setActive(r.active); setVariants(r.variants);
      if (r.variants.length === 0) void loadHarnessName().then(setSoloName);
    });
  }, []);
  useEffect(() => { loadVariants(); }, [loadVariants]);

  // ── 모델 축 ──
  const [model, setModelState] = useState("");        // per-conversation override ("" = default)
  const [defaultModel, setDefaultModel] = useState(""); // effective model when unset ("" = CLI 기본)
  const [open, setOpen] = useState(false);
  // 오른쪽 단(모델 목록)은 공급자 줄에 호버·포커스해야 편다(피드백 2026-08-26: 열자마자 다 보이면 시끄럽다)
  const [hover, setHover] = useState<string | null>(null);
  // 서브 카드 자리 — 메뉴는 트리거 오른쪽 끝에 맞춰 왼쪽으로 펼쳐진다. 왼쪽에 두 카드가 설 폭이
  // 없으면(도크 폭 ~380px) 위로 쌓는다. 열 때 한 번 잰다.
  const [stack, setStack] = useState(false);
  // 공급자별 카탈로그 — undefined = 아직 안 물음, null = 미도달
  const [byVariant, setByVariant] = useState<Record<string, ModelOption[] | null>>({});
  const [loaded, setLoaded] = useState(false);
  // 활성 하네스 항목 — 서버 카탈로그(가족별 최신). 로드 전/미도달은 정적 폴백(modelOptions 초기값).
  const [options, setOptions] = useState(modelOptions());
  const boxRef = useRef<HTMLDivElement>(null);
  // 카탈로그는 **하네스에 딸린다** — overrides-changed 는 하네스 전환도 실어 나른다.
  useEffect(() => {
    let alive = true;
    const load = () => loadModelOptions().then((o) => { if (alive) setOptions(o); });
    void load();
    const off = onOverridesChanged(() => { void load(); });
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => {
    let alive = true;
    const load = () => loadModel(ctx).then((info) => { if (alive) { setModelState(info.override); setDefaultModel(info.defaultModel); setLoaded(true); } });
    void load();
    const off = onOverridesChanged(() => { void load(); }); // /model 빌트인 반영
    return () => { alive = false; off(); };
  }, [ctx.conversationId]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  useEffect(() => {
    if (!open) { setHover(null); return; }
    // 폭은 화면이 아니라 컴포저(도크 패널) 기준이다 — 패널은 overflow hidden 이라 화면에 자리가
    // 있어도 패널 왼쪽 밖으로 나간 카드는 잘린다(실사고: 도크에서 공급자 카드가 반쯤 잘림).
    const r = boxRef.current?.getBoundingClientRect();
    const host = boxRef.current?.closest(".rc-composer")?.getBoundingClientRect();
    setStack(!!r && r.right - (host?.left ?? 0) < 470);
  }, [open]);
  // 호버한 공급자의 카탈로그를 한 번만 묻는다(runtime 이 변형별로 캐시한다)
  useEffect(() => {
    if (!hover || hover === active || hover in byVariant) return;
    let alive = true;
    void loadModelOptionsFor(hover).then((o) => { if (alive) setByVariant((m) => ({ ...m, [hover]: o })); });
    return () => { alive = false; };
  }, [hover, active, byVariant]);

  const labelOf = modelLabelOf;
  // 저장 실패는 되돌리고 표시한다 — 낙관 표시만 남고 서버엔 저장 안 된 채 다른 모델로 턴이
  // 도는 사고 방지. 성공/실패 모두 overrides-changed 로 서버 정본을 재조회해 수렴시킨다.
  const [err, setErr] = useState(false);
  // 저장은 됐는데 하네스 카탈로그에 없는 id — 다음 턴이 실패한다(§5.5-30). 저장 성공과 다른 축이다
  const [unknownId, setUnknownId] = useState(false);
  // 진행 중 턴 안내 — 전환은 저장 즉시 다음 응답부터 적용되지만, 이미 돌고 있는 턴은 시작
  // 시점 모델로 끝난다. 그 모델의 진짜 값(init 프레임 → 없으면 직전 실효 표시값)을 보여준다.
  const running = useThread((t) => t.isRunning);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  // 실효 기본 — 바인딩/llm_default 가 비면(CLI 기본) 마지막 init 프레임의 실행 모델로 표시.
  // 첫 턴 전엔 둘 다 비어 알 수 없음 — 그때만 맨 "기본".
  const effDefault = defaultModel || lastConnectedModel();

  const noteRunning = (v: string) => {
    if (!running) return;
    const prior = lastConnectedModel() || model || defaultModel;
    const next = v || effDefault;
    if (prior && next && labelOf(prior) !== labelOf(next)) {
      setNotice(`진행 중인 응답은 ${withRo(labelOf(prior))} 완료됩니다`);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(""), 6000);
    }
  };
  /** 활성 하네스의 모델 줄 — 오버라이드만 바꾼다 */
  const setModelId = (v: string) => {
    noteRunning(v);
    setErr(false); setUnknownId(false); setModelState(v); setOpen(false);
    void setModel(ctx, v).then((r) => {
      if (!r.ok) setErr(true);
      else if (r.known === false) setUnknownId(true);
      notifyOverridesChanged();
    });
  };
  /** 다른 공급자의 모델 줄 — 전환 + 지정을 한 요청으로 */
  const setHarnessModel = (name: string, v: string) => {
    noteRunning(v);
    setErr(false); setHErr(false); setUnknownId(false); setNotReady("");
    setActive(name); setModelState(v); setOpen(false);
    void setHarnessAndModel(ctx, name, v).then((r) => {
      if (!r.ok) { setHErr(true); loadVariants(); notifyOverridesChanged(); return; }
      if (r.ready && !r.ready.ok) setNotReady(r.ready.note);
      if (r.known === false) setUnknownId(true);
      notifyOverridesChanged(); // 모델 카탈로그·오버라이드를 새 하네스 것으로 다시 읽힌다
    });
  };

  const twoPane = variants.length >= 2;
  // 바깥(트리거)엔 오버라이드가 있으면 그 모델, 없으면 하네스 한 단어("Claude").
  // 변형 미선언 기판은 실효 모델(알면) — 그때만 "기본".
  const harnessName = active ?? soloName;
  const shown = model ? labelOf(model) : harnessName ? harnessShortOf(harnessName) : (effDefault ? labelOf(effDefault) : "기본");

  /** 한 공급자의 모델 목록 단. own = 활성 하네스(오버라이드 축) / 아니면 전환 축 */
  const rowsFor = (p: { name: string; provider?: string } | null) => {
    const own = !p || p.name === active;
    const list = own ? options : byVariant[p.name];
    const pick = (id: string) => (own ? setModelId(id) : setHarnessModel(p!.name, id));
    return (
      <>
        {list === undefined && <div className="rc-pick-note">모델 목록을 읽는 중…</div>}
        {list === null && <div className="rc-pick-note">모델 목록을 받지 못했습니다 — 고르면 이 공급자로 바꿉니다</div>}
        {list !== undefined && (
          <button type="button" role="option" aria-selected={own && !model}
                  className={"rc-pick-item" + (own && !model ? " on" : "")} onClick={() => pick("")}>
            <span className="rc-pick-text">
              <span className="rc-pick-main">기본</span>
              {own && effDefault && <span className="rc-pick-sub">현재 {labelOf(effDefault)}</span>}
            </span>
            {own && !model && <CheckIcon />}
          </button>
        )}
        {(list ?? []).map((m) => {
          const on = own && model === m.id;
          return (
            <button type="button" role="option" key={m.id} aria-selected={on}
                    className={"rc-pick-item" + (on ? " on" : "")} onClick={() => pick(m.id)}>
              <span className="rc-pick-text">
                <span className="rc-pick-main">{m.label}</span>
                {m.label.toLowerCase() !== m.id.toLowerCase() && <span className="rc-pick-sub">{m.id}</span>}
              </span>
              {on && <CheckIcon />}
            </button>
          );
        })}
      </>
    );
  };
  const hovered = hover ? variants.find((v) => v.name === hover) ?? null : null;

  return (
    <div className={"rc-model" + (loaded ? "" : " rc-model-loading")} ref={boxRef}
         title="AI 모델 — 이 대화에만 적용, 다음 응답부터. '기본'은 인스턴스 바인딩(없으면 CLI 기본)을 따릅니다.">
      <button type="button" className="rc-model-btn" onClick={() => setOpen((o) => !o)}
              aria-haspopup="listbox" aria-expanded={open}>
        <span className="rc-model-lb">
          <span className={"rc-model-val" + (model ? "" : " ghost")}>{shown}</span>
          <svg className="rc-model-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
          {err && <span className="rc-save-err">저장 실패</span>}
          {!err && hErr && <span className="rc-save-err">전환 실패</span>}
          {!err && !hErr && unknownId && <span className="rc-save-err">목록에 없는 id</span>}
        </span>
      </button>
      {open && (
        <div className={"rc-pick" + (stack ? " stack" : "")}>
          <div className="rc-pick-card">
            {twoPane ? (
              <div className="rc-pick-list" role="listbox" aria-label="공급자">
                {variants.map((v) => (
                  <button type="button" role="option" key={v.name} aria-selected={active === v.name}
                          className={"rc-pick-item" + (active === v.name ? " on" : "") + (hover === v.name ? " hov" : "")}
                          onMouseEnter={() => setHover(v.name)} onFocus={() => setHover(v.name)}
                          onClick={() => setHover(v.name)}>
                    <span className="rc-pick-text">
                      <span className="rc-pick-main">{providerLabelOf(v)}</span>
                      {providerLabelOf(v) !== v.name && <span className="rc-pick-sub">{v.name}</span>}
                    </span>
                    {active === v.name && <CheckIcon />}
                    <svg className="rc-pick-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rc-pick-list" role="listbox" aria-label="모델">{rowsFor(null)}</div>
            )}
            <EffortRow />
          </div>
          {twoPane && hovered && (
            <div className="rc-pick-card rc-pick-sub-card">
              <div className="rc-pick-list" role="listbox" aria-label="모델">{rowsFor(hovered)}</div>
            </div>
          )}
        </div>
      )}
      {notice && <div className="rc-model-notice" role="status">{notice}</div>}
      {!notice && notReady && <div className="rc-model-notice" role="status">준비되지 않은 하네스입니다 — {notReady}</div>}
      {!notice && !notReady && unknownId && (
        <div className="rc-model-notice" role="status">
          저장은 됐지만 이 하네스의 모델 목록에 없는 id 입니다 — 다음 턴이 실패할 수 있습니다
        </div>
      )}
    </div>
  );
}

/** Phosphor Icons(MIT) path — 의존성 없이 인라인. 256 뷰박스, fill=currentColor.
 *  글자 아이콘(↑ ■ +)은 폰트마다 굵기·기준선이 달라 버튼 안에서 비뚤어 보였다(피드백 2026-08-26). */
const PH = {
  arrowUp: "M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z",
  stop: "M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z",
  plus: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z",
};
function PhIcon({ d, size }: { d: string; size: number }) {
  // 크기·채움을 속성이 아니라 inline style + .rc-ph 로 못 박는다 — 호스트 페이지(패키지 뷰)의 전역
  // `svg{...}` 리셋(fill:none·stroke·width)이 속성값을 이기면 채움 아이콘이 점처럼 보인다(실사고).
  return (
    <svg className="rc-ph" style={{ width: size, height: size }} viewBox="0 0 256 256" aria-hidden><path d={d} /></svg>
  );
}

function CheckIcon() {
  return (
    <svg className="rc-pick-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
  );
}

/** 조사 "(으)로" — 라벨 끝 글자의 받침으로 고른다(숫자는 독음 기준: 1·7·8=ㄹ→로, 0·3·6=받침→으로).
 *  한글·숫자 밖(라틴 등)은 "로". 모델 라벨("Opus 4.8")이 열린 집합이라 안내문이 어색해지지 않게. */
function withRo(w: string): string {
  const ch = w.charAt(w.length - 1);
  if (/[0-9]/.test(ch)) return w + ("036".includes(ch) ? "으로" : "로"); // 영·삼·육만 ㄹ 아닌 받침
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return w + (jong === 0 || jong === 8 ? "로" : "으로"); // 받침 없음·ㄹ 받침 = 로
  }
  return w + "로";
}

/** A staged attachment held in the composer (before send). 소형(인라인)은 dataUrl 이 프리뷰와
 *  바이트 소스를 겸하고, 대용량(사이드밴드)은 dataUrl 없이 업로드 참조(path)만 갖는다 —
 *  uploading/progress 는 사이드밴드 진행 상태(전송은 업로드 완료 후에만). */
type PendingAtt = {
  id: string; name: string; mime: string; dataUrl: string; size: number;
  path?: string; uploading?: boolean; progress?: number;
};

let _attSeq = 0;
/** Read a File (from any source) into a PendingAtt. A clipboard image often has no name → we
 *  synthesize one (`pasted-…`) so the byte path never depends on a source filesystem path. */
function readFileAsAtt(file: File): Promise<PendingAtt> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let name = file.name;
      if (!name) {
        const ext = (file.type.split("/")[1] || "bin").replace("jpeg", "jpg");
        name = `pasted-${Date.now()}-${_attSeq}.${ext}`;
      }
      resolve({ id: `a${++_attSeq}`, name, mime: file.type || "application/octet-stream",
                dataUrl: String(reader.result || ""), size: file.size });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
/** 토큰 수 → 컴팩트 표기(256_000 → "256k", 1_000_000 → "1M") — 컨텍스트 미터 툴팁용. */
function fmtTok(n: number): string {
  if (n >= 1_000_000) { const v = n / 1_000_000; return (n % 1_000_000 ? v.toFixed(1) : String(v)) + "M"; }
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}
/** 인라인은 "data:<mime>;base64," 프리픽스를 벗겨 raw base64 로, 사이드밴드는 참조(path)로. */
function attToPayload(a: PendingAtt): Attachment {
  if (a.path) return { name: a.name, mime: a.mime, path: a.path };
  const comma = a.dataUrl.indexOf(",");
  return { name: a.name, mime: a.mime, data: comma >= 0 ? a.dataUrl.slice(comma + 1) : a.dataUrl };
}
/** 인라인(파일당) 상한 — 이하이면 base64 인라인(왕복 없음·per-turn Secret ≈1MB etcd 상한 안),
 *  초과하면 사이드밴드 업로드(스트리밍 — Secret 비경유)로 자동 전환. */
const ATT_INLINE_FILE_LIMIT = 500 * 1024;
/** 인라인 합계 상한 — Secret 상한 방어(소형 여러 개도 합치면 넘칠 수 있다). 넘치는 파일은
 *  개별 크기와 무관하게 사이드밴드로 밀어낸다. */
const ATT_INLINE_TOTAL_LIMIT = 700 * 1024;
/** 첨부 총량 상한(인라인+사이드밴드)의 **폴백** — 서버(Setting KV chat_limits, fleet 이 편집)가
 *  정본이고 이 상수는 서버 미도달/미배선 때만 쓰인다(loadEffort 의 CLAUDE_CODE_DEFAULT_EFFORT
 *  폴백과 같은 관용구). control-ts ChatLimitsService.DEFAULT_TOTAL_BYTES 와 같은 값 —
 *  한쪽만 바꾸면 미설정 org 와 오프라인 폴백이 서로 다른 상한을 갖게 된다.
 *
 *  주의: 이건 UX 노브지 보안 경계가 아니다. 바이트 fail-closed 는 서버 안전망
 *  (RELAY_UPLOAD_MAX_BYTES, 기본 1GiB — deployd·엔진·control 3곳)이 따로 집행한다. */
const ATT_TOTAL_LIMIT_FALLBACK = 30 * 1024 * 1024;

// 빈 화면 스타터 칩 → 컴포저 프리필 직결. postMessage 대신 모듈 콜백 — 씬클라 file:// 오리진에선
// same-origin postMessage 검사가 어긋날 수 있고, 웹뷰 하나당 JS 컨텍스트 하나라 모듈 전역이 안전하다.
let _prefillComposer: ((text: string) => void) | null = null;
// 외부(셸 openChat send) 발 자동 전송 — 컴포저와 같은 큐 의미론(턴 실행 중=큐잉)을 태운다.
let _sendExternal: ((text: string) => void) | null = null;

// ── 큐 영속화 ────────────────────────────────────────────────────────────────
// 제출됐지만 앞 턴이 끝나길 기다리는 대기 메시지를 conversationId 단위로 localStorage 에 보존한다.
// 슬롯 전환으로 Composer 가 언마운트되거나(위젯 setConversation·대화 메뉴 onSwitch) 씬클라
// 웹뷰가 파괴돼도 다음 마운트에서 복원된다. 실행 중인 턴은 브레인이 서버에 유지
// (loadActiveTurn 재부착)하지만 큐는 그 대칭짝이 없어 여기서 보존한다. file:// 오리진 등
// localStorage 가 막힌 환경을 대비해 모든 접근을 try/catch — 실패 시 영속화만 포기하고 세션 내
// 동작(기존 인메모리 큐)은 유지한다.
type QItem = { text: string; atts: PendingAtt[] };
const queueStorageKey = (conv: string) => `relay:chat-queue:${conv}`;

function loadQueue(conv: string): QItem[] {
  try {
    const raw = window.localStorage.getItem(queueStorageKey(conv));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((it: any) => it && typeof it.text === "string")
      .map((it: any) => ({ text: it.text as string, atts: Array.isArray(it.atts) ? (it.atts as PendingAtt[]) : [] }));
  } catch { return []; }
}

function saveQueue(conv: string, q: QItem[]): void {
  const key = queueStorageKey(conv);
  try {
    if (q.length === 0) { window.localStorage.removeItem(key); return; }
    window.localStorage.setItem(key, JSON.stringify(q));
  } catch {
    // 첨부 base64 로 쿼터 초과 가능 — 텍스트만이라도 살린다(이미지 미리보기는 유실 감수).
    try { window.localStorage.setItem(key, JSON.stringify(q.map((it) => ({ text: it.text, atts: [] })))); }
    catch { /* localStorage 불가 — 영속화 포기, 세션 내 동작만 유지 */ }
  }
}

/** Composer — 턴이 도는 중에도 입력을 잠그지 않는다. 제출된 말이 가는 길은 둘이고, 갈림은
 *  기판의 capability `steer` 가 정한다(client-protocol §5.1-16-a):
 *
 *  - **얹기**: 진행 중 턴에 발화를 더한다. 턴은 열리지 않고 정산도 하나 그대로다 — 하네스는
 *    다음 샘플링 경계(진행 중 도구가 결과를 낸 뒤)에서 그 말을 읽는다.
 *  - **대기**: 얹기를 모르는 기판·첨부가 붙은 발화·앞에 이미 대기가 있는 경우. 턴이 끝나는
 *    순간 자동 전송되고, 대기 하나가 턴 하나다(동시 턴 없음 — 재개된 세션과 충돌하지 않는다).
 *
 *  두 길 모두 **사용자가 친 말은 잃지 않는다**. 갈리는 것은 언제 전달되는가 하나뿐이고,
 *  그래서 화면은 어느 기판에 붙었는지 몰라도 된다. */
/** 탭 셸이 제공하는 "이 대화를 새 탭으로 열기" 훅 — pane 내부 전환(onSwitch)은 탭 strip 과
 *  desync 되므로(탭 key/제목이 옛 대화에 고정), 셸이 있으면 이 경로가 우선한다. */
export const OpenConversationCtx = createContext<((conv: string) => void) | null>(null);

/** 탭 셸이 제공하는 "이 대화의 대상(칩)을 고친다" 훅 — 칩은 대화 id 의 파생이라 대상을 바꾸려면
 *  좌표를 바꿔야 한다. 잘못 열린 대화는 대개 **아직 빈 대화**이므로 그때는 제자리에서 좌표만
 *  갈아끼워 무손실로 고치고(inPlace), 이미 오간 말이 있으면 그 좌표의 대화로 이동한다.
 *  getPageSlot = 지금 보고 있는 페이지의 슬롯(피커의 "지금 페이지에 맞추기" 항목). */
export type PaneTarget = {
  getPageSlot: () => { instanceId: string; conversationId: string } | null;
  /** 페이지가 선언한 작업 대상 전체(<AgentScope targets>) — 아직 대화한 적 없는 워크벤치도
   *  "대상 추가" 후보로 뜨게 한다(대화 이력 열거의 사각을 메운다). */
  getPageTargets: () => string[];
  retarget: (conversationId: string, inPlace: boolean) => void;
  /** 다른 인스턴스로 — 워크스페이스·도구·자격이 통째로 다른 곳이라 제자리 교체가 성립하지 않는다.
   *  **항상 새 탭**이다(retarget 은 같은 인스턴스 안에서만 좌표를 바꾼다). */
  openInstance: (instanceId: string) => void;
};
export const PaneTargetCtx = createContext<PaneTarget | null>(null);

function Composer({ resumingTurn, onSwitch }: { resumingTurn: boolean; onSwitch?: (c: string) => void }) {
  const rt = useThreadRuntime();
  const running = useThread((t) => t.isRunning);
  // 탭 셸이 여러 pane 을 함께 마운트하면 프리필/자동전송 브로드캐스트를 모든 pane 이 받는다 —
  // 활성 pane 만 소비하도록 게이팅(비탭=항상 true). 핸들러는 []deps 로 1회 등록하고 ref 로 최신값을 본다.
  const active = useContext(ActivePaneCtx);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [text, setText] = useState("");
  // Staged attachments for the NEXT message (file picker / drag-drop / clipboard paste).
  const [atts, setAtts] = useState<PendingAtt[]>([]);
  // 첨부 실패/거절 사유 — sandbox(allow-modals 부재)에서 window.alert 가 무음 증발하던
  // 자리의 대체. 인라인 배너로 항상 보인다.
  const [attError, setAttError] = useState<string | null>(null);
  // 첨부 총량 상한 — 서버(fleet 편집)가 정본. 도달 전/실패 시 폴백 상수로 동작하고 도착하면
  // 갱신된다. state 가 아니라 ref 인 이유: 이 값은 렌더에 안 쓰이고 addFiles(async) 안에서만
  // 읽힌다 — state 로 두면 낡은 클로저를 잡을 뿐 재렌더 이득이 없다.
  const attTotalLimitRef = useRef(ATT_TOTAL_LIMIT_FALLBACK);
  useEffect(() => {
    let alive = true;
    loadAttTotalLimit(ATT_TOTAL_LIMIT_FALLBACK).then((n) => { if (alive) attTotalLimitRef.current = n; });
    return () => { alive = false; };
  }, []);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0); // dragenter/leave fire per child — count to avoid overlay flicker.
  const fileRef = useRef<HTMLInputElement>(null);
  // The queue is a LIST of distinct messages (each becomes its own turn), not one merged
  // string. Each carries its own attachments. queueRef is the source of truth; `queued` mirrors it.
  // 큐는 conversationId(리액티브 슬롯) 단위로 localStorage 에 영속 — 슬롯/pane 전환으로 이 Composer 가
  // 재마운트돼도 복원된다(loadQueue/saveQueue 는 모듈 스코프, QItem 도 승격).
  const ctx = useRelayCtx();
  const convKey = ctx.conversationId;
  const initialQueue = useMemo(() => loadQueue(convKey), [convKey]);
  const queueRef = useRef<QItem[]>(initialQueue);
  const [queued, setQueued] = useState<QItem[]>(initialQueue);
  const prevRunning = useRef(running);
  // running 의 최신값 — 착지 판정(deliver/enqueue)이 await 뒤에서 읽으므로 렌더 클로저로는
  // 늦는다. 매 렌더 갱신하는 ref 가 그 자리다.
  const runningRef = useRef(running);
  runningRef.current = running;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const syncQueued = () => { setQueued([...queueRef.current]); saveQueue(convKey, queueRef.current); };

  // ── slash-command picker ────────────────────────────────────────────────
  // The agent's skills/commands (manifest-declared, assembled into the turn's .claude/) shown
  // as a "/" autocomplete. Fetched once per conversation; the picker opens while the text is a
  // bare "/<query>" (no space yet — once a space is typed we're in args and it closes).
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false); // Esc dismisses until text changes
  // 컨텍스트 미터 분모 — 실효 모델(override||default)의 윈도우. /model 오버라이드도 반영.
  const [ctxWindow, setCtxWindow] = useState(1_000_000);
  useEffect(() => {
    let alive = true;
    const load = () => loadModel(ctx).then((info) => { if (alive) setCtxWindow(contextWindowFor(info.override || info.defaultModel)); });
    void load();
    const off = onOverridesChanged(() => { void load(); });
    return () => { alive = false; off(); };
  }, [ctx]);
  useEffect(() => {
    let alive = true;
    loadCommands(ctx).then((c) => { if (alive) setCommands(c); });
    return () => { alive = false; };
  }, [ctx.conversationId]);
  // 이 기판이 얹기를 아는가(§7 steer). 제출 시점에 동기로 알아야 착지가 한 프레임 안에
  // 정해진다 — 하네스를 바꾸면 capability 집합 자체가 그 하네스 것이라 다시 읽는다.
  const [steerable, setSteerable] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => hasSteer(ctx).then((v) => { if (alive) setSteerable(v); });
    void load();
    const off = onOverridesChanged(() => { void load(); });
    return () => { alive = false; off(); };
  }, [ctx.conversationId]);

  const slashMatch = /^\/([\w-]*)$/.exec(text);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const slashMatches = useMemo(
    () => (slashQuery == null ? [] : commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery))),
    [slashQuery, commands],
  );
  const slashOpen = !slashClosed && slashQuery != null && slashMatches.length > 0;
  useEffect(() => { setSlashSel((s) => (s >= slashMatches.length ? 0 : s)); }, [slashMatches.length]);

  // Accept → fill the input with "/name " (ready for args) and keep focus; Enter then sends.
  const acceptCommand = (c: SlashCommand) => {
    setText("/" + c.name + " ");
    setSlashClosed(true);
    setSlashSel(0);
    requestAnimationFrame(() => { taRef.current?.focus(); grow(); });
  };

  // ── "@" agent picker (대화 단위 바인딩) ─────────────────────────────────
  // relay.yaml agents[] 선언을 "@" 자동완성으로 노출한다. 멘션으로 보내면 그 에이전트에
  // 바인딩된 **새 대화**(agent-<name>:~<id8> — routematch sibling 문법)를 민팅해 메시지를
  // 그쪽 큐로 넘기고 전환한다 — 대화-id 가 곧 바인딩이라 서버 무변경으로 세션 착지·칩·
  // 도구 scope 가 전부 따라온다(A안: 대화=세션=한 에이전트의 맥락). 미선언 패키지는 목록이
  // 비어 피커가 아예 안 열린다(레거시 무영향).
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [atSel, setAtSel] = useState(0);
  const [atClosed, setAtClosed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadAgents(ctx).then((a) => { if (alive) setAgents(a); });
    return () => { alive = false; };
  }, [ctx.conversationId]);

  const atMatch = /^@([\w-]*)$/.exec(text);
  const atQuery = atMatch ? atMatch[1].toLowerCase() : null;
  const atMatches = useMemo(
    () => (atQuery == null ? [] : agents.filter((a) => a.name.toLowerCase().startsWith(atQuery))),
    [atQuery, agents],
  );
  const atOpen = !atClosed && atQuery != null && atMatches.length > 0;
  useEffect(() => { setAtSel((s) => (s >= atMatches.length ? 0 : s)); }, [atMatches.length]);

  const acceptAgent = (a: AgentEntry) => {
    setText("@" + a.name + " ");
    setAtClosed(true);
    setAtSel(0);
    requestAnimationFrame(() => { taRef.current?.focus(); grow(); });
  };

  // "@<agent> <메시지>" 발송 라우팅 — 선언된 에이전트 이름과 정확히 일치할 때만 개입
  // (이메일 등 일반 @텍스트 하이재킹 방지). 같은 에이전트에 이미 바인딩된 대화면 멘션만
  // 벗겨 제자리 전송. 이동은 탭 셸(새 탭) 우선, 없으면 pane 전환(onSwitch), 둘 다 없으면
  // 개입하지 않는다(graceful).
  const openConv = useContext(OpenConversationCtx);
  const routeMention = (t: string, list: PendingAtt[]): boolean => {
    const m = /^@([\w-]+)\s+([\s\S]+)$/.exec(t);
    const go = openConv ?? onSwitch;
    if (!m || !go) return false;
    const agent = agents.find((a) => a.name === m[1]);
    if (!agent) return false;
    const body = m[2].trim();
    if (!body) return false;
    if (displayBinding(ctx.conversationId).agent === agent.name) {
      // 이미 그 에이전트의 대화 — 멘션만 벗겨 일반 경로로.
      deliver(body, list);
      return true;
    }
    // 로컬 드래프트 좌표 — 첫 발화(아래 큐 드레인) 직전에 session.create 가 민팅한다(§5.3-22).
    const next = siblingThread("agent-" + agent.name);
    saveQueue(next, [{ text: body, atts: list }]); // 새 pane 의 유휴-드레인이 자동 전송
    go(next);
    return true;
  };

  // Append a user message + stash its attachments for the adapter to pick up (sequential, so
  // the single-slot pending holder is race-free). Image attachments also render in the user
  // bubble (image parts are display-only; textOf() keeps the prompt text-only).
  const sendNow = (t: string, list: PendingAtt[]) => {
    setPendingAttachments(list.map(attToPayload));
    const content: any[] = [{ type: "text", text: t }];
    // 사이드밴드 첨부는 dataUrl 이 없다(대용량 base64 를 안 안는 게 목적) — 프리뷰 스킵.
    // filename 은 assistant-ui 이미지 파트의 표준 밖 확장 — UserMessage 첨부 칩 라벨이 읽는다.
    for (const a of list) if (a.mime.startsWith("image/") && a.dataUrl) content.push({ type: "image", image: a.dataUrl, filename: a.name });
    rt.append({ role: "user", content });
  };

  // 대기열 착지 — 유휴면 곧장 흘린다. 유휴 분기가 여기 있어야 하는 이유: 얹기 실패처럼
  // falling-edge 가 오지 않는 경로가 있고, 그때 큐에 넣기만 하면 그 말이 다음 턴까지 묶인다.
  const enqueue = (it: QItem) => {
    if (!runningRef.current && queueRef.current.length === 0) { sendNow(it.text, it.atts); return; }
    queueRef.current.push(it);
    syncQueued();
  };

  // 얹기 시도 — 실패는 오류가 아니라 경로 선택이다(그 사이 턴이 끝났거나 기판이 모른다).
  // 어느 쪽이든 말은 버리지 않는다.
  const trySteer = async (t: string) => {
    if (await steerTurn(ctx, t)) return;
    enqueue({ text: t, atts: [] });
  };

  // 제출된 말의 유일한 착지점. 세 조건이 모두 서야 얹는다:
  //  · 기판이 얹기를 안다 — 아니면 얹을 문 자체가 없다
  //  · 첨부가 없다 — 얹기 본문은 {prompt} 단일이라 첨부를 나르지 않는다(§5.1-16-a)
  //  · 앞에 대기가 없다 — 대기를 건너뛰고 얹으면 사용자가 친 순서가 뒤집힌다
  const deliver = (t: string, list: PendingAtt[]) => {
    if (runningRef.current && steerable && !list.length && queueRef.current.length === 0) {
      void trySteer(t);
      return;
    }
    enqueue({ text: t, atts: list });
  };

  // UI 가 사용자를 대신해 보내는 한 줄(대상 피커의 "대상 추가" 등) — 사용자가 친 말과 같은 길.
  const sendOrQueue = (t: string) => deliver(t, []);

  // On the running falling-edge (a turn just finished), send the NEXT queued message —
  // exactly ONE per turn, so each queued message runs as its own sequential turn.
  useEffect(() => {
    const fell = prevRunning.current && !running;
    prevRunning.current = running;
    if (!fell || queueRef.current.length === 0) return;
    const next = queueRef.current.shift()!;
    syncQueued();
    sendNow(next.text, next.atts);
  }, [running, rt]);

  // 복원된 큐가 idle 상태로 마운트되면(대기하던 턴이 자리에 없음 — 슬롯 떠난 사이 완료) falling-edge 가
  // 생기지 않아 자동 전송이 안 걸린다. 재부착 중인 턴이 없고(resumingTurn=false) idle 이면 첫 메시지를
  // 즉시 흘려 드레인을 재개한다. 재부착 중이면 그 턴 완료 시 위 falling-edge 가 처리하므로 건너뛴다.
  useEffect(() => {
    if (resumingTurn || running || queueRef.current.length === 0) return;
    const next = queueRef.current.shift()!;
    syncQueued();
    sendNow(next.text, next.atts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    // 200px(max-height) 을 넘을 때만 스크롤. 한 줄일 땐 scrollHeight 반올림으로 뜨는
    // 헛 세로 스크롤바를 숨긴다(좁은 셸 패널에서 특히 잘 보이던 문제).
    ta.style.overflowY = ta.scrollHeight > 200 ? "auto" : "hidden";
  };

  // deployd 셸의 chat.open prefill 중계 수신 — 셸은 이 앱(React) 마운트 타이밍을 모르므로
  // ack 받을 때까지 같은 메시지를 재시도한다. ack 로 재시도를 멈추고, 같은 nonce 중복
  // 수신은 no-op(재시도 경합으로 입력이 리셋되는 것 방지 — 재클릭은 새 nonce 라 다시
  // 채워진다). 발신자는 같은 origin 의 부모 셸.
  // 스타터 칩(EmptyStarter) 프리필 등록 — 칩 클릭 → 입력창 채우고 포커스. 활성 pane 만 싱글턴을
  // 소유한다(비활성 탭이 마지막에 마운트돼 칩 프리필을 가로채지 않게 — active 전이 시 재등록).
  useEffect(() => {
    if (!active) return;
    _prefillComposer = (t: string) => {
      setText(t);
      setSlashClosed(false);
      requestAnimationFrame(() => { taRef.current?.focus(); grow(); });
    };
    return () => { if (_prefillComposer) _prefillComposer = null; };
  }, [active]);

  const lastPrefillNonce = useRef("");
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (!activeRef.current) return; // 비활성 탭은 프리필 무시(ack 도 안 함 — 활성 pane 이 소비·ack)
      const d: any = ev.data;
      if (!d || d.type !== "relay:chat-prefill" || typeof d.text !== "string") return;
      try { (ev.source as Window | null)?.postMessage({ type: "relay:chat-prefill-ack" }, ev.origin); } catch {}
      const nonce = String(d.nonce || d.text);
      if (nonce === lastPrefillNonce.current) return;
      lastPrefillNonce.current = nonce;
      setText(d.text);
      requestAnimationFrame(() => { taRef.current?.focus(); grow(); });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 외부 자동 전송(셸 openChat send — 스킬 호출 등) 등록 — 컴포저 submit 과 같은 큐
  // 의미론(턴 실행/드레인 중=큐잉, 유휴=즉시 전송). running/sendNow 클로저가 항상 신선해야
  // 하므로 deps 없이 매 렌더 재등록한다(_prefillComposer 는 setter 만 써서 [] 로 충분한
  // 것과 다른 이유).
  useEffect(() => {
    if (!active) return;
    _sendExternal = (t: string) => {
      const promptText = t.trim();
      if (!promptText) return;
      deliver(promptText, []);
    };
    return () => { if (_sendExternal) _sendExternal = null; };
  });

  const lastSendNonce = useRef("");
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (!activeRef.current) return; // 비활성 탭은 자동전송 무시(활성 pane 이 소비·ack)
      const d: any = ev.data;
      if (!d || d.type !== "relay:chat-send" || typeof d.text !== "string") return;
      try { (ev.source as Window | null)?.postMessage({ type: "relay:chat-send-ack" }, ev.origin); } catch {}
      const nonce = String(d.nonce || d.text);
      if (nonce === lastSendNonce.current) return; // 재시도 중복 수신 = no-op(이중 전송 방지)
      lastSendNonce.current = nonce;
      _sendExternal?.(d.text);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 하이브리드 스테이징 — 소형(≤500KB, 인라인 합계 700KB 안)은 base64 인라인, 그 외는
  // 사이드밴드 업로드(진행률 칩 → 완료 시 참조 승격). 거절/실패는 alert 대신 인라인 배너
  // (sandbox allow-modals 부재로 alert 는 무음 증발한다 — 다운로드 차단과 같은 클래스).
  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setAttError(null);

    const current = atts.reduce((s, a) => s + a.size, 0);
    const incoming = arr.reduce((s, f) => s + f.size, 0);
    const limit = attTotalLimitRef.current;
    if (current + incoming > limit) {
      setAttError(`첨부 용량이 너무 큽니다 (합계 최대 ${fmtSize(limit)}). 일부 파일을 빼주세요.`);
      return;
    }

    let inlineTotal = atts.reduce((s, a) => (a.path || a.uploading ? s : s + a.size), 0);
    for (const f of arr) {
      const inline = f.size <= ATT_INLINE_FILE_LIMIT && inlineTotal + f.size <= ATT_INLINE_TOTAL_LIMIT;
      if (inline) {
        inlineTotal += f.size;
        try {
          const att = await readFileAsAtt(f);
          setAtts((prev) => [...prev, att]);
        } catch (e: any) {
          setAttError(`"${f.name || "첨부"}" 읽기 실패: ${e?.message ?? e}`);
        }
        continue;
      }
      // 사이드밴드 — 플레이스홀더 칩을 먼저 올리고 업로드 진행률을 흘린다.
      const id = `a${++_attSeq}`;
      const name = f.name || `pasted-${Date.now()}-${_attSeq}`;
      setAtts((prev) => [...prev, {
        id, name, mime: f.type || "application/octet-stream", dataUrl: "", size: f.size,
        uploading: true, progress: 0,
      }]);
      const patch = (p: Partial<PendingAtt>) =>
        setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a)));
      try {
        const up = await uploadAttachment(f, name, (pct) => patch({ progress: pct }));
        patch({ path: up.path, uploading: false, progress: 100 });
      } catch (e: any) {
        setAtts((prev) => prev.filter((a) => a.id !== id));
        setAttError(`"${name}" 업로드 실패: ${e?.message ?? e}`);
      }
    }
  };
  const removeAtt = (id: string) => setAtts((prev) => prev.filter((a) => a.id !== id));

  // 컨텍스트 미터 — 현재 점유량은 "마지막 스텝"의 프롬프트 크기다. claude -p 의 result.usage 는
  // 턴 전체 누적(툴 왕복마다 cache_read 가 더해짐)이라 실제보다 몇 배 부풀어 100%로 고착됐다 —
  // 그래서 reducer 가 마지막 assistant 프레임의 usage 를 contextUsage 로 따로 담고, 여기선 그걸
  // 쓴다(구 데이터엔 없으니 usage 로 폴백). 분모는 실효 모델의 윈도우(ctxWindow).
  // 클릭 = /compact 패스스루 턴(pod 안 claude 가 세션 jsonl 압축, 히스토리 replay 무관).
  // 점유량 = 순수 프롬프트 크기(input + 캐시 읽기 + 캐시 생성). output_tokens 는 그 스텝의
  // 컨텍스트 점유가 아니라 생성물이므로 더하지 않는다.
  const ctxTokensOf = (u: any) => u
    ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    : 0;
  const lastUsage = useThread((t) => {
    for (let i = t.messages.length - 1; i >= 0; i--) {
      const m: any = t.messages[i];
      if (m.role !== "assistant" || !m.metadata?.custom) continue;
      const cu = m.metadata.custom.contextUsage || m.metadata.custom.usage;
      // /compact 턴은 assistant 스텝이 없어 result.usage(컨텍스트 0)만 남는다 — 점유 0짜리
      // 축퇴 usage 는 건너뛰고 직전 실 assistant 스텝까지 스캔한다(안 그러면 미터가 사라짐).
      if (cu && ctxTokensOf(cu) > 0) return cu;
    }
    return null;
  });
  const ctxUsed = ctxTokensOf(lastUsage);
  const ctxPct = Math.min(100, Math.round((ctxUsed / ctxWindow) * 100));
  const ctxRemain = Math.max(0, 100 - ctxPct); // auto-compact 까지 남은 여유(추정)
  // 터치 2-탭 가드 — 첫 탭=툴팁(armed), 둘째 탭=압축(아래 rc-ctx onClick 참조).
  const [ctxArmed, setCtxArmed] = useState(false);
  const ctxArmedRef = useRef(false);

  // 빌트인 notice — 인터셉트 결과 한 줄을 composer 위에 잠깐 띄운다(턴/히스토리 비오염).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const showNotice = (msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  };

  const submit = () => {
    const t = text.trim();
    if (!t && atts.length === 0) return;
    // 사이드밴드 업로드가 진행 중이면 보내지 않는다 — 참조(path) 없는 첨부가 실리면
    // 그 파일만 조용히 빠진 턴이 된다(무음 유실 금지).
    if (atts.some((a) => a.uploading)) {
      setAttError("파일 업로드가 끝나면 전송할 수 있습니다.");
      return;
    }
    // 빌트인 인터셉트(/clear·/effort·/model) — 턴 없이 제어평면에서 끝난다. 턴 실행 중에도
    // 안전(세션 row/reset 연산 — 다음 턴부터 적용). /compact 는 여기 안 걸려 일반 턴으로 전달.
    const builtin = atts.length === 0 ? parseBuiltin(t) : null;
    if (builtin) {
      setText("");
      requestAnimationFrame(grow);
      void executeBuiltin(ctx, builtin.name, builtin.arg).then(showNotice);
      return;
    }
    const promptText = t || "첨부한 파일을 확인해주세요.";
    const sendAtts = atts;
    setText("");
    setAtts([]);
    requestAnimationFrame(grow);
    // "@에이전트 메시지" — 바인딩 대화로 라우팅(민팅+전환). 개입 안 하면 일반 경로.
    if (routeMention(promptText, sendAtts)) return;
    deliver(promptText, sendAtts);
  };

  const removeQueued = (i: number) => { queueRef.current.splice(i, 1); syncQueued(); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = (e.nativeEvent as { isComposing?: boolean }).isComposing;
    // Slash picker takes the navigation/accept keys first when open.
    if (slashOpen && slashMatches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((s) => (s + 1) % slashMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashSel((s) => (s - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashClosed(true); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !composing) {
        e.preventDefault();
        acceptCommand(slashMatches[slashSel] || slashMatches[0]);
        return;
      }
    }
    // "@" agent picker — 슬래시 피커와 동일 키 계약.
    if (atOpen && atMatches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAtSel((s) => (s + 1) % atMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAtSel((s) => (s - 1 + atMatches.length) % atMatches.length); return; }
      if (e.key === "Escape") { e.preventDefault(); setAtClosed(true); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !composing) {
        e.preventDefault();
        acceptAgent(atMatches[atSel] || atMatches[0]);
        return;
      }
    }
    // Enter sends · Shift+Enter newline. Skip while an IME (한글) composition is active so a
    // composition-confirming Enter doesn't submit a half-typed word.
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      submit();
    }
  };

  // Clipboard paste of an image/file → capture as an attachment (and swallow the paste so a
  // pasted screenshot doesn't drop into the textarea as nothing). Plain text paste is untouched.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files: File[] = [];
    if (dt.files && dt.files.length) { for (let i = 0; i < dt.files.length; i++) files.push(dt.files[i]); }
    else { for (let i = 0; i < dt.items.length; i++) { const it = dt.items[i]; if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); } } }
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };

  // Drag-and-drop onto the composer. Only react when files are being dragged (not text/selection).
  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const onDragEnter = (e: React.DragEvent) => { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true); };
  const onDragOver = (e: React.DragEvent) => { if (dragHasFiles(e)) e.preventDefault(); };
  const onDragLeave = (e: React.DragEvent) => { if (dragDepth.current > 0) { dragDepth.current--; if (dragDepth.current === 0) setDragging(false); } };
  const onDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  };

  return (
    <div className="rc-composer" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragging && (
        <div className="rc-drop" aria-hidden>
          <div className="rc-drop-in"><span className="rc-drop-ic">⬇</span> 여기에 파일을 놓으세요</div>
        </div>
      )}
      {queued.length > 0 && (
        <div className="rc-queued-list">
          {queued.map((q, i) => (
            <div className="rc-queued" role="status" key={i}>
              <span className="rc-queued-ic" aria-hidden>↑</span>
              <span className="rc-queued-tx">전송 대기 중 · {q.text.replace(/\n/g, " ")}{q.atts.length ? ` · 📎${q.atts.length}` : ""}</span>
              <button type="button" className="rc-queued-x" aria-label="대기 취소" onClick={() => removeQueued(i)}>×</button>
            </div>
          ))}
        </div>
      )}
      {attError && (
        <div className="rc-att-error" role="alert">
          <span className="rc-att-error-tx">{attError}</span>
          <button type="button" className="rc-att-error-x" aria-label="닫기" onClick={() => setAttError(null)}>×</button>
        </div>
      )}
      {slashOpen && (
        <div className="rc-slash" role="listbox" aria-label="슬래시 커맨드">
          {slashMatches.map((c, i) => (
            <button
              type="button"
              key={c.name}
              role="option"
              aria-selected={i === slashSel}
              className={"rc-slash-item" + (i === slashSel ? " sel" : "")}
              onPointerEnter={() => setSlashSel(i)}
              // pointerdown (not click) + preventDefault: accept before the textarea blurs.
              // pointer 계열 = 마우스·터치·펜 통합(터치는 합성 mouse 이벤트가 불안정).
              onPointerDown={(e) => { e.preventDefault(); acceptCommand(c); }}
            >
              <span className="rc-slash-nm">/{c.name}</span>
              {c.description && <span className="rc-slash-desc">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      {atOpen && (
        <div className="rc-slash" role="listbox" aria-label="에이전트 지정">
          {atMatches.map((a, i) => (
            <button
              type="button"
              key={a.name}
              role="option"
              aria-selected={i === atSel}
              className={"rc-slash-item" + (i === atSel ? " sel" : "")}
              onPointerEnter={() => setAtSel(i)}
              onPointerDown={(e) => { e.preventDefault(); acceptAgent(a); }}
            >
              <span className="rc-slash-nm">@{a.name}</span>
              <span className="rc-slash-desc">
                {displayBinding(ctx.conversationId).agent === a.name
                  ? "현재 대화의 에이전트"
                  : (a.default ? "기본 에이전트 · " : "") + "이 에이전트와 새 대화를 시작합니다"}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* 입력 카드 — 위는 글, 아래 줄은 왼쪽(+ 첨부 · 모델)·오른쪽(컨텍스트 · 전송). 카드 빈자리를 눌러도 입력으로 */}
      <div className="rc-box" onClick={(e) => { if (e.target === e.currentTarget) taRef.current?.focus(); }}>
        {/* 에이전트(대상) 칩 — 카드 맨 위(레퍼런스: 맥락 칩 → 글 → 도구 줄). 피커는 칩에 붙는 카드 */}
        <ContextChips onSend={sendOrQueue} />
        {atts.length > 0 && (
          <div className="rc-atts">
            {atts.map((a) => (
              <div className="rc-att" key={a.id}>
                {a.mime.startsWith("image/") && a.dataUrl
                  ? <img className="rc-att-thumb" src={a.dataUrl} alt={a.name} />
                  : <span className="rc-att-ic" aria-hidden>▢</span>}
                <span className="rc-att-meta">
                  <span className="rc-att-nm" title={a.name}>{a.name}</span>
                  <span className="rc-att-sz">
                    {a.uploading ? `업로드 ${a.progress ?? 0}%` : fmtSize(a.size)}
                  </span>
                </span>
                <button type="button" className="rc-att-x" aria-label="첨부 제거" onClick={() => removeAtt(a.id)}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="rc-input"
          placeholder={running
            ? "응답 중… 잠시만 기다려주세요"
            : agents.length > 0
            ? "여기에 메시지를 입력하세요 — @로 에이전트 지정"
            : "여기에 메시지를 입력하세요"}
          // 터치 기기는 autoFocus 시 패널이 열리자마자 키보드가 화면 절반을 덮는다 — 데스크톱만.
          autoFocus={typeof window === "undefined" || !window.matchMedia("(hover: none)").matches}
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); setSlashClosed(false); setAtClosed(false); grow(); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="rc-box-foot">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="rc-file-input"
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
          />
          <button type="button" className="rc-attach" aria-label="파일 첨부" title="파일 첨부" onClick={() => fileRef.current?.click()}>
            <PhIcon d={PH.plus} size={16} />
          </button>
          <span style={{ flex: 1 }} />
          {ctxUsed > 0 && (
            <span className={"rc-ctx-wrap" + (ctxArmed ? " rc-armed" : "")}>
              <button type="button"
                className={"rc-ctx" + (ctxPct >= 85 ? " hot" : ctxPct >= 60 ? " warm" : "")}
                onClick={() => {
                  // 터치(hover 없음)에선 hover 툴팁 경고를 볼 수 없다 — 첫 탭은 툴팁만 열고
                  // (rc-armed, 3초 유지) 둘째 탭이 실제 압축. 데스크톱은 기존 한 번 클릭 그대로.
                  if (window.matchMedia("(hover: none)").matches && !ctxArmedRef.current) {
                    ctxArmedRef.current = true;
                    setCtxArmed(true);
                    window.setTimeout(() => { ctxArmedRef.current = false; setCtxArmed(false); }, 3000);
                    return;
                  }
                  ctxArmedRef.current = false;
                  setCtxArmed(false);
                  if (running || queueRef.current.length) { queueRef.current.push({ text: "/compact", atts: [] }); syncQueued(); }
                  else sendNow("/compact", []);
                }}
                aria-label={`컨텍스트 ${fmtTok(ctxUsed)}/${fmtTok(ctxWindow)} (${ctxPct}%) — 클릭하면 압축`}>
                <span className="rc-ctx-ring" style={{ ["--rc-ctx-pct" as any]: `${ctxPct}%` }} aria-hidden />
                <span className="rc-ctx-lb">{ctxPct}%</span>
              </button>
              <span className="rc-ctx-tip" role="tooltip">
                <span className="rc-ctx-tip-h">{ctxRemain}% of context remaining until auto-compact.</span>
                <span className="rc-ctx-tip-sub">Click to compact now.</span>
                <span className="rc-ctx-tip-num">{fmtTok(ctxUsed)}/{fmtTok(ctxWindow)} ({ctxPct}%)</span>
              </span>
            </span>
          )}
          <ModelPicker />
          {running ? (
            <button type="button" className="rc-cancel" aria-label="중지" onClick={() => rt.cancelRun()}>
              <PhIcon d={PH.stop} size={13} />
            </button>
          ) : (
            <button type="button" className="rc-send" aria-label="전송"
              disabled={(!text.trim() && atts.length === 0) || atts.some((a) => a.uploading)}
              title={atts.some((a) => a.uploading) ? "파일 업로드 중…" : undefined}
              onClick={submit}><PhIcon d={PH.arrowUp} size={16} /></button>
          )}
        </div>
      </div>
      {notice && <div className="rc-builtin-notice" role="status">{notice}</div>}

    </div>
  );
}

/** Re-attaches to an in-flight turn on mount: appends the pending prompt as the latest user
 *  message and flags the adapter to stream the EXISTING turn (attachTurnStream) instead of
 *  starting a new one. Runs exactly once. Rendered inside the runtime provider so it can drive
 *  the thread; renders nothing. No attach → no-op. */
function AttachOnMount({ attach }: { attach: ActiveTurn | null }) {
  const rt = useThreadRuntime();
  const done = useRef(false);
  useEffect(() => {
    if (!attach || done.current) return;
    done.current = true;
    setAttachTurn(attach);            // adapter takes this at the top of run() → attach path
    rt.append({ role: "user", content: [{ type: "text", text: attach.prompt }] });
  }, [attach, rt]);
  return null;
}

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
 *  (배열을 구독하면 빈 스레드에서 무한 렌더 — AnchorController 주석 참조). 전이 시에만 보고. */
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

/** The chat thread + runtime. Split out from ChatApp so useLocalRuntime can be
 *  SEEDED with the conversation's prior turns (initialMessages) — assistant-ui only
 *  accepts those at construction, so this mounts AFTER history has loaded. */
/** 스크롤 앵커: 최신 user 메시지에만 .is-pinned 를 부여해 CSS sticky 로 상단에 고정한다(질문 상단 고정).
 *  바닥 추적(스트리밍 따라가기·최대 스크롤=콘텐츠 바닥)은 Viewport 내장 autoScroll 이 담당 — 예전의
 *  하단 스페이서(.rc-tail) 예약은 짧은 응답에서 뷰포트만큼 빈 스크롤 영역을 만들어 은퇴시켰다(VSCode식). */
function AnchorController({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  // 원시 배열(t.messages)을 구독하면 안 된다 — @assistant-ui 는 selector 결과를 Object.is 로 비교하는데
  // convertMessages(WeakKey 메모이즈)가 **빈 스레드에선 매 스냅샷 새 []** 를 반환한다(빈 배열은 메모이즈
  // 무효). Object.is([],[])=false → useSyncExternalStore 가 매 커밋 "바뀜"으로 보고 재렌더 → React #185
  // "Maximum update depth exceeded". 안정 원시값(개수+마지막 id)만 구독해 변화 트리거를 얻는다.
  const msgCount = useThread((t) => t.messages.length);
  const lastId = useThread((t) => (t.messages.length ? t.messages[t.messages.length - 1].id : ""));
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const raf = requestAnimationFrame(() => {
      const log = root.querySelector(".rc-log") as HTMLElement | null;
      if (!log) return;
      // 최근 user 메시지 1개에만 .is-pinned → CSS가 그것만 상단 sticky 헤더로(질문 상단 고정). 나머지는
      // 일반 흐름(모두 sticky면 겹쳐 보임). 스크롤은 Viewport 내장 autoScroll(바닥추적)이 담당한다 —
      // 뷰포트만큼 하단 여백을 예약하던 스페이서 방식은 은퇴(짧은 응답에서 과한 빈 스크롤 영역을 만들던 원인).
      // 최대 스크롤 = 콘텐츠 바닥(VSCode식)이고, 질문은 스크롤을 지나가면 sticky 로 상단에 붙는다.
      const users = log.querySelectorAll<HTMLElement>(".rc-user");
      const last = users[users.length - 1];
      users.forEach((u) => u.classList.toggle("is-pinned", u === last));
    });
    return () => cancelAnimationFrame(raf);
  }, [msgCount, lastId, rootRef]);
  return null;
}

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
    : onDraft ? "고친 판과 대화 — 아직 적용 전"
    : bind.agent ? `${bind.agent} 와의 대화` : "무엇이든 물어보세요";
  const hint = creating
    ? "하고 싶은 일을 한 줄로 적어 주세요. 아래 예시를 누르면 입력칸에 채워집니다."
    : builder
    ? "바꾸고 싶은 것을 말로 적어 주세요 — 성격, 기능, 스케줄, 연결 무엇이든. 적용을 누르기 전까지는 실제 에이전트에 반영되지 않습니다."
    : onDraft ? "고친 성격·기능으로 대화합니다. 마음에 들면 위의 [적용]을 누르세요 — 돌아가는 판은 아직 그대로입니다."
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
    <div className="rc-empty">
      <div className="rc-empty-ic" aria-hidden>✦</div>
      <div className="rc-empty-t">{title}</div>
      {hint && <div className="rc-empty-h">{hint}</div>}
      {examples.length ? (
        <div className="rc-empty-ex">
          {examples.map((e) => (
            <button key={e.label} type="button" className="rc-empty-exb" title={e.text} onClick={() => prefill(e.text)}>{e.label}</button>
          ))}
          {creating && (
            <button type="button" className="rc-empty-exb rc-empty-more" aria-label="다른 예시" title="다른 예시"
              onClick={() => setPage((p) => p + 1)}>↻</button>
          )}
        </div>
      ) : null}
    </div>
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

/** 과거 스크롤 중일 때 최신으로 내려가는 플로팅 버튼(레퍼런스 하단 중앙 원형). */
function JumpToBottom({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const log = rootRef.current?.querySelector(".rc-log") as HTMLElement | null;
    if (!log) return;
    const onScroll = () => setShow(log.scrollHeight - log.scrollTop - log.clientHeight > 400);
    log.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => log.removeEventListener("scroll", onScroll);
  }, [rootRef]);
  if (!show) return null;
  return (
    <button type="button" className="rc-jump" aria-label="맨 아래로"
            onClick={() => {
              const log = rootRef.current?.querySelector(".rc-log") as HTMLElement | null;
              log?.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
            }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

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
  // rootRef 로 이 pane(다중 세션이면 여러 개)의 .rc-log 를 스코프해서 DOM 조회한다.
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RelayCtxContext.Provider value={ctx}>
       <ActivePaneCtx.Provider value={active}>
        <AttachOnMount attach={attach} />
        <ServerTurnWatch ctx={ctx} attach={attach} />
        <TurnStatusReporter onStatus={onStatus} />
        {/* display:contents — 레이아웃엔 영향 없이 ref 스코프만 제공 */}
        <div ref={rootRef} style={{ display: "contents" }}>
          <ThreadPrimitive.Root className="rc-root">
            {/* embedded=탭 셸이 통합 헤더를 소유 → per-pane 헤더 억제(이중 헤더 방지) */}
            {!embedded && <ChatHeader ctx={ctx} live onSwitch={onSwitch} />}
            {/* autoScroll(내장 바닥추적) 복원 — 스페이서 앵커를 걷어내 더는 충돌하지 않는다. 스트리밍은
                바닥을 따라가고(최대 스크롤=콘텐츠 바닥, VSCode식), 질문은 sticky(.is-pinned)로 상단 고정. */}
            <div className="rc-logwrap">
              <ThreadPrimitive.Viewport className="rc-log" autoScroll>
                <ThreadPrimitive.Empty>
                  <EmptyStarter ctx={ctx} />
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
              </ThreadPrimitive.Viewport>
              <JumpToBottom rootRef={rootRef} />
            </div>
            <Composer resumingTurn={!!attach} onSwitch={onSwitch} />
          </ThreadPrimitive.Root>
        </div>
        <AnchorController rootRef={rootRef} />
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
