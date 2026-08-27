/*!
 * Trace.tsx — 어시스턴트 턴의 흐름 표시: 마크다운 본문, 스텝 타임라인(StepRow·ThoughtRow), 플랜 카드,
 * 실행 중 상태·종료 상태 칩, 히스토리 스켈레톤, 헤더 점, 공용 아이콘(PhIcon·CheckIcon).
 * 타임라인 행은 shadcn Marker(아이콘 + 내용) 로, 펼침은 Collapsible 로, 진행 중은 Spinner 로 표현한다.
 */
import { useEffect, useRef, useState } from "react";
import { useMessage, ThreadPrimitive } from "@assistant-ui/react";
import { CheckIcon as LCheck, XIcon, ChevronRightIcon, ChevronDownIcon, CircleIcon, CircleDotIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { Marker, MarkerIcon, MarkerContent } from "@/components/ui/marker";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Item, ItemGroup, ItemMedia, ItemContent, ItemTitle } from "@/components/ui/item";
import { cn } from "@/lib/utils";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TurnMeta, TurnUsageLive } from "./runtime";
import { stepMeta, onTurnPhase, onTurnUsage, loadConversationsOf } from "./runtime";
import { useRelayCtx } from "./ctx";
import { resultText, fmtTok, modelLabelOf, type AnyPart } from "./parts";

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

export function MdBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={"rc-md" + (streaming ? " rc-streaming" : "")}>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</Markdown>
    </div>
  );
}

/** 진행 중 스피너 — 장식이라 접근성 이름을 떼고(행의 라벨이 이미 "생각 중…"·"실행" 을 말한다),
 *  강조색 하나로 살아있음만 보인다. */
function Busy({ className }: { className?: string }) {
  return <Spinner role={undefined} aria-label={undefined} aria-hidden className={cn("text-[var(--rc-accent)]", className)} />;
}

/** 펼침 카랫 — 트리거 안에서만 쓰고, hover·펼침 상태에서만 드러난다(터치는 chat.css 가 상시 노출). */
function Caret({ open }: { open: boolean }) {
  return (
    <span className="rc-step-caret ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/marker:opacity-80 group-data-[panel-open]/marker:opacity-80" aria-hidden>
      {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
    </span>
  );
}

/** 행 트리거의 공통 모양 — 마커를 버튼으로 렌더(Collapsible 트리거), 옅은 12.5px 글씨, hover 배경. */
const ROW = "w-full cursor-pointer rounded-md px-1 py-1.5 text-[12.5px] hover:bg-muted data-disabled:cursor-default data-disabled:hover:bg-transparent";

/** 타임라인 스텝 한 행 — [아이콘] [동사 · 대상] [· 결과 요약] [›]. 클릭하면 원시 상세 펼침.
 *  실행 중엔 아이콘 자리에 스피너, 끝나면 체크(오류면 X). 카드 박스 없음(레퍼런스: 조용한 타임라인). */
/** 위임(agent_dispatch)의 대화를 찾아 탭으로 연다 — 서브에이전트는 별도 대화에서 돌아, 그 탭이
 *  열려 있지 않으면 보고와 질문을 놓친다. 세션 목록의 (agent, param) 으로 맞추고, 아직 목록에
 *  없으면 잠시 기다린다(위임 직후 세션 디렉토리가 생기는 사이). 착지는 크롬의 relay:chat-open. */
export async function openDispatchConversation(instanceId: string, principal: string, sub: string, target: string): Promise<boolean> {
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

export function StepRow({ part, running }: { part: AnyPart; running: boolean }) {
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
  const live = running && !done;
  const liveTick = useLiveTick(live);
  const err = !!part.isError;
  return (
    <Collapsible open={open} onOpenChange={setOpen} disabled={!hasDetail}
      className={cn("rc-step motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-200", err && "err")}>
      <Marker render={<CollapsibleTrigger />} className={ROW}>
        <MarkerIcon className={cn("inline-flex items-center justify-center text-xs", err ? "text-[var(--rc-err)]" : "text-muted-foreground")}>
          {live ? <Busy /> : err ? <XIcon /> : done ? <LCheck /> : meta.icon}
        </MarkerIcon>
        <MarkerContent className={cn("truncate", live ? "font-medium text-foreground/70" : err ? "text-[var(--rc-err)]" : "text-muted-foreground")}>
          {meta.label}
          {meta.target && <span> · {meta.target}</span>}
        </MarkerContent>
        {done && meta.summary && <span className={cn("min-w-0 shrink truncate text-xs", err ? "text-[var(--rc-err)]" : "text-muted-foreground")}>· {meta.summary}</span>}
        {live && (liveTick.elapsed >= 3 || liveTick.tick) ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
            {liveTick.elapsed >= 3 ? <span>{liveTick.elapsed}s</span> : null}{liveTick.tick}
          </span>
        ) : null}
        {hasDetail && <Caret open={open} />}
      </Marker>
      <CollapsibleContent className="rc-step-body">
        <div className="rc-step-raw">{part.toolName}</div>
        {argDisplay && <pre className="rc-step-args">{argDisplay}</pre>}
        {done && <pre className="rc-step-res">{resultText(part.result).slice(0, 8000) || "(결과 없음)"}</pre>}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** reasoning 파트 — 레퍼런스의 접힌 "Thought" 행. 스트리밍 중(live)엔 사고 꼬리를 미리보기로
 *  흘려 보여주고(살아있음 신호), 다음 스텝으로 넘어가면 접힌 행으로 수렴한다. 클릭해 전문 열람. */
export function ThoughtRow({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}
      className="rc-step rc-think motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-200">
      <Marker render={<CollapsibleTrigger />} className={ROW}>
        <MarkerIcon className="inline-flex items-center justify-center text-muted-foreground">
          {live ? <Busy /> : <CircleIcon className="size-2 fill-current" />}
        </MarkerIcon>
        <MarkerContent className={cn("truncate italic", live ? "font-medium text-foreground/70" : "text-muted-foreground")}>
          {live ? "생각 중…" : "생각"}
        </MarkerContent>
        <Caret open={open} />
      </Marker>
      <CollapsibleContent className="rc-step-body rc-think-tx">{text}</CollapsibleContent>
      {!open && live && text && <div className="rc-think-live">{text.length > 280 ? "…" + text.slice(-280) : text}</div>}
    </Collapsible>
  );
}

/** 스텝 타임라인 — 실행 중엔 펼쳐져 스텝이 흘러내리고, 턴이 끝나면 "✓ 작업 N개 · Ns" 한
 *  행으로 자동 접힘(히스토리 replay 는 접힌 채 시작). 접힘/펼침 토글. */
export function TraceTimeline({ steps, running, durationMs }: { steps: AnyPart[]; running: boolean; durationMs?: number }) {
  const [collapsed, setCollapsed] = useState(!running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setCollapsed(true);
    wasRunning.current = running;
  }, [running]);
  const tools = steps.filter((s) => s.type === "tool-call").length;
  const label = tools > 0 ? `작업 ${tools}개` : "생각 정리";
  const dur = typeof durationMs === "number" && durationMs >= 100 ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
  // 요약 행 — 마커를 버튼으로. 완료 체크는 초록 원 안에.
  const summary = (open: boolean) => (
    <Marker render={<button type="button" />} onClick={() => setCollapsed(open)}
      className="w-auto cursor-pointer self-start rounded-md py-1 pr-2 pl-0.5 text-[12.5px] tabular-nums hover:bg-muted hover:text-foreground/70 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
      <MarkerIcon className="inline-flex items-center justify-center rounded-full bg-[var(--rc-ok-bg)] text-[var(--rc-ok)]">
        <LCheck className="size-2.5" strokeWidth={3} />
      </MarkerIcon>
      <MarkerContent>{label}{dur}</MarkerContent>
      <span className="shrink-0 opacity-70" aria-hidden>{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}</span>
    </Marker>
  );
  if (collapsed) return summary(false);
  return (
    <div className="flex flex-col gap-0.5">
      {!running && summary(true)}
      <div className="flex flex-col">
        {steps.map((s, i) =>
          s.type === "reasoning"
            ? <ThoughtRow key={i} text={s.text || ""} live={running && i === steps.length - 1} />
            : <StepRow key={s.toolCallId || i} part={s} running={running} />)}
      </div>
    </div>
  );
}

/** TodoWrite 플랜 카드(프로토타입 Stepper 이식) — 체크리스트 + 진행도. 진행 행은 activeForm.
 *  Card 안에 Item 행 — 완료는 체크, 진행 중은 스피너(턴 진행 중) 또는 점, 대기는 빈 원. */
export function PlanCard({ todos, active }: { todos: any[] | null; active: boolean }) {
  const list = Array.isArray(todos) ? todos : [];
  const doneN = list.filter((t) => t?.status === "completed").length;
  const row = (key: React.Key, icon: React.ReactNode, text: string, tone: "done" | "run" | "todo") => (
    <Item key={key} size="xs" className="flex-nowrap px-0 py-0.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-200">
      <ItemMedia variant="icon" className={cn("w-4", tone === "done" ? "text-[var(--rc-ok)]" : tone === "run" ? "text-[var(--rc-accent)]" : "text-muted-foreground")}>{icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className={cn("w-full text-[12.5px]", tone === "done" ? "font-normal text-muted-foreground" : tone === "run" ? "font-medium text-foreground" : "font-normal text-foreground/70")}>
          <span className="truncate">{text}</span>
        </ItemTitle>
      </ItemContent>
    </Item>
  );
  return (
    <Card size="sm" className="max-w-[520px] gap-1.5 py-2.5 shadow-none ring-border motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
      <CardHeader className="flex flex-row items-center gap-2 px-3">
        <CardTitle className="text-xs font-semibold">계획</CardTitle>
        {list.length > 0 && <Badge variant="secondary" className="h-4 px-1.5 text-[11px] tabular-nums text-muted-foreground">{doneN}/{list.length}</Badge>}
      </CardHeader>
      <CardContent className="px-3">
        <ItemGroup className="gap-0">
          {list.length === 0
            ? row("empty", <Busy />, "계획 세우는 중…", "run")
            : list.map((t, i) => {
                const st = t?.status === "completed" ? "done" : t?.status === "in_progress" ? "run" : "todo";
                const tx = (st === "run" ? t?.activeForm || t?.content : t?.content) || "";
                const icon = st === "done" ? <LCheck strokeWidth={2.5} />
                  : st === "run" && active ? <Busy />
                  : st === "run" ? <CircleDotIcon />
                  : <CircleIcon />;
                return row(i, icon, tx, st);
              })}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

/** 히스토리 로딩 스켈레톤 — 죽은 3-dot 대신 콘텐츠 형태의 pulse. */
export function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-3 px-[18px] py-[22px]" role="status" aria-label="대화 불러오는 중">
      <Skeleton className="h-3 w-[40%]" /><Skeleton className="h-3 w-[85%]" /><Skeleton className="h-3 w-[70%]" /><Skeleton className="h-3 w-[55%]" />
    </div>
  );
}

/** 살아있음 신호 — 경과 초·연결 여부·토큰 티커. 실행 중인 단계 줄(StepRow)과 상태 줄(RunningStatus)이
 *  같은 것을 두 번 보이지 않도록 한 곳에서 잰다(피드백 2026-08-27: 같은 문장·스피너가 둘). */
function useLiveTick(active: boolean): { elapsed: number; connected: boolean; tick: React.ReactNode } {
  const [connected, setConnected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // 라이브 토큰 티커 — 업로드 단계 ↑(스텝 입력·캐시 포함), 생성 중 ↓(출력 누적). 마지막으로
  // 움직인 방향의 화살표를 보여준다( 패턴 — 살아있음 신호).
  const [usage, setUsage] = useState<TurnUsageLive | null>(null);
  const startRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (!startRef.current) startRef.current = Date.now();
    const iv = window.setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 1000);
    const off = onTurnPhase((phase) => { if (phase === "connected") setConnected(true); });
    const offUsage = onTurnUsage(setUsage);
    return () => { window.clearInterval(iv); off(); offUsage(); };
  }, [active]);
  const tick = usage
    ? (usage.dir === "up" && usage.inTok > 0
        ? <span className="rc-running-tok up" aria-label="입력 토큰">↑ {fmtTok(usage.inTok)}</span>
        : usage.outTok > 0
          ? <span className="rc-running-tok" aria-label="출력 토큰">↓ {fmtTok(usage.outTok)}</span>
          : null)
    : null;
  return { elapsed, connected, tick };
}

/** Live running status — 턴 내내 살아있는 내레이션(원칙 1: 죽은 침묵 금지).
 *  콘텐츠가 오기 전엔 스폰 스테이지(보내는 중 → 연결하는 중 → 연결됨·생각 중 — system
 *  init 프레임이 onTurnPhase 로 전환), 온 뒤엔 마지막 실행 스텝의 활동 라벨. 3초부터 경과 표시. */
export function RunningStatus() {
  const running = useMessage((m) => m.status?.type === "running");
  const content = useMessage((m) => m.content as readonly AnyPart[]);
  const { elapsed, connected, tick } = useLiveTick(running);
  if (!running) return null;
  let label: string;
  if (content.length === 0) {
    label = elapsed < 1 ? "보내는 중…" : connected ? "연결됨 · 생각 중…" : "연결하는 중…";
  } else {
    const last = content[content.length - 1];
    if (last?.type === "tool-call" && last.result === undefined && !last.isError) {
      return null; // 실행 중인 단계 줄이 이미 보인다 — 같은 문장을 두 번 쓰지 않는다
    } else if (last?.type === "reasoning") {
      label = "생각 중…";
    } else {
      label = "응답 중…";
    }
  }
  const suffix = elapsed >= 3 ? ` · ${elapsed}s` : "";
  return (
    <Marker role="status" aria-label="응답 생성 중" className="w-auto px-0.5 py-1 text-[12.5px] text-foreground/70">
      <MarkerIcon><Busy /></MarkerIcon>
      <MarkerContent className="rc-running-tx">{label}{suffix}</MarkerContent>
      {tick}
    </Marker>
  );
}

/** Header status dot — pulses (accent color) while the thread is running, steady green
 *  when idle. Driven by ThreadPrimitive.If (real runtime state), not a CSS ancestor class. */
export function HeadDot() {
  return (
    <>
      <ThreadPrimitive.If running={false}><span className="rc-dot" /></ThreadPrimitive.If>
      <ThreadPrimitive.If running><span className="rc-dot rc-dot-run" /></ThreadPrimitive.If>
    </>
  );
}

/** 턴 종료 상태 칩 — 완료 / 중지됨 / 오류 / 미완료(끊김)를 어시스턴트 메시지 끝에 남긴다. 완료의
 *  신뢰 증거는 터미널 result 프레임(metadata.custom.durationMs/usage)으로, 라이브·히스토리 리플레이
 *  양쪽에서 동일하게 판정된다(브레인에 종료-상태 컬럼 없이 저장된 프레임만으로). result 프레임이
 *  없는데 실행 중도 아니면 = 깨끗이 끝나지 않은 것 → '미완료'로 표시해, 리플레이된 죽은 턴이
 *  "완료"처럼 조용히 보이던 문제(멈춘 건지 끝난 건지 구분 불가)를 메운다. 완료 칩은 토큰/시간도 겸한다.
 *  status 가 undefined 인 경우(리플레이 초기 메시지)는 터미널로 취급 — running 만 제외.
 *  모양은 Badge(ghost) — 배경 없이 글자색으로만 종류를 가른다. */
export function TurnStatusChip() {
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
  // 정상 종료는 칩을 달지 않는다 — 답이 끝난 것은 답 자체가 말한다. "완료·모델명·토큰"은 읽는 사람에게
  // 중요도가 낮다는 피드백(2026-08-27). 칩은 문제가 있을 때(중지·오류·끊김)만 뜬다.
  if (kind === "ok") return null;
  const icon = kind === "cancel" ? <SquareIcon className="size-2.5! fill-current" /> : <TriangleAlertIcon />;
  const label =
    kind === "cancel" ? "중지됨"
    : kind === "error" ? "오류로 중단됨"
    : "응답이 끊겼어요";
  const title = "메시지를 다시 보내면 이어서 진행해요.";
  const tone = kind === "cancel" ? "text-foreground/70"
    : kind === "error" ? "text-[#d65745] font-medium"
    : "text-[#c9a44a] font-medium";
  return (
    <Badge variant="ghost" role="status" title={title}
      className={cn("h-auto min-h-5 gap-1.5 whitespace-normal px-0 pt-1 pb-0 text-[11.5px] font-normal tabular-nums hover:bg-transparent hover:text-current", tone)}>
      {icon}
      <span>{label}</span>
      
    </Badge>
  );
}

export function PhIcon({ d, size }: { d: string; size: number }) {
  // 크기·채움을 속성이 아니라 inline style + .rc-ph 로 못 박는다 — 호스트 페이지(패키지 뷰)의 전역
  // `svg{...}` 리셋(fill:none·stroke·width)이 속성값을 이기면 채움 아이콘이 점처럼 보인다(실사고).
  return (
    <svg className="rc-ph" style={{ width: size, height: size }} viewBox="0 0 256 256" aria-hidden><path d={d} /></svg>
  );
}

export function CheckIcon() {
  return (
    <svg className="rc-pick-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
  );
}
