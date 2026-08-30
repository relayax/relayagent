/*!
 * Messages.tsx — 메시지 한 건의 렌더: 사용자 말풍선(UserMessage)과 그 변종 카드(저작 요청·에이전트 요청·
 * 서브에이전트 위임·스킬 호출·시스템 칩), 어시스턴트 메시지(AssistantMessage — 파트 그룹을 카드로 배치).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMessage, MessagePrimitive } from "@assistant-ui/react";
import type { TurnMeta } from "./runtime";
import { iconUrlForInstance } from "./runtime";
import { useRelayCtx } from "./ctx";
import { fmtTime, groupParts, type AnyPart } from "./parts";
import { MdBlock, TraceTimeline, PlanCard, RunningStatus, TurnStatusChip, TurnLimitNotice, openDispatchConversation } from "./Trace";
import { AskCard, SteerCard, ChoiceCard } from "./Ask";
import { FileCard, StageFiles, AttOpenChip, ImageLightbox, NullImagePart, type UserImagePart } from "./Files";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Marker, MarkerIcon, MarkerContent } from "@/components/ui/marker";
import { AlarmClockIcon, CircleSlashIcon, InboxIcon, TriangleAlertIcon } from "lucide-react";

/** 사용자 턴 자리에 서는 카드(저작 요청·에이전트 요청·서브에이전트 위임·스킬 호출)의 공통 껍데기 —
 *  MessagePrimitive.Root 가 assistant-ui 의 뿌리로 남고(asChild), 그 위에 shadcn Message/Card 를 얹는다.
 *  rc-msg 는 등장 애니메이션(rc-rise)과 첨부 썸네일 규칙(.rc-msg img)이 붙어 있어 유지한다. */
function TurnCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <MessagePrimitive.Root asChild className="rc-msg">
      <Message>
        <MessageContent>
          <Card size="sm" className="max-w-[86%] gap-2 py-3 [--card-spacing:--spacing(3)]" title={title}>
            {children}
          </Card>
        </MessageContent>
      </Message>
    </MessagePrimitive.Root>
  );
}
/** 카드 머리의 "누가 · 무엇" 줄 — 칩 + 라벨 + 시각 */
function TurnCardHead({ chip, label, time }: { chip: ReactNode; label: string; time: string }) {
  return (
    <CardTitle className="flex items-center gap-1.5 text-xs">
      {chip}
      <span className="font-semibold text-foreground">{label}</span>
      {time ? <span className="font-normal text-muted-foreground">· {time}</span> : null}
    </CardTitle>
  );
}
/** 카드 본문 — 기계용 지시를 접지 않고 줄바꿈 그대로 보여 준다 */
function TurnCardBody({ text }: { text: string }) {
  return <CardContent className="text-[13px] leading-[1.55] whitespace-pre-wrap break-words">{text}</CardContent>;
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
    <TurnCard title={origin + " 에서 착지한 저작 요청 — 산출물은 그래프 델타(패키지 diff + Edge 신청 + publish)"}>
      <CardHeader>
        <TurnCardHead time={time} label="에서 온 저작 요청"
          chip={<Badge variant="secondary" className="rc-chip"><span className="rc-chip-dot" aria-hidden /><span className="rc-chip-tx">{origin}</span></Badge>} />
      </CardHeader>
      <TurnCardBody text={body} />
      {nameM ? (
        <CardFooter className="gap-1.5">
          <Badge variant="secondary" className="rc-chip"><span className="rc-chip-slash" aria-hidden>#</span><span className="rc-chip-tx">{nameM[1].trim()}</span></Badge>
        </CardFooter>
      ) : null}
    </TurnCard>
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
  // 이미지가 깨지면 Avatar 폴백(slug 첫 글자)으로 — 예전엔 display:none 으로 숨겼다
  return (
    <Avatar aria-hidden className="size-[15px] rounded-[4px] after:rounded-[4px]">
      <AvatarImage src={src} alt="" className="rounded-[4px]" />
      <AvatarFallback className="rounded-[4px] text-[9px] leading-none">{slug.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
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
  const [notFound, setNotFound] = useState(false);
  return (
    <TurnCard title={`${inst} 오케스트레이터가 서브에이전트 ${agent} 에게 자동 전달한 지시 · 사용자가 직접 입력한 메시지가 아닙니다`}>
      <CardHeader>
        <TurnCardHead time={time} label="맡긴 작업"
          chip={<Badge variant="secondary" className="rc-chip"><AgentIcon slug={inst} /><span className="rc-chip-tx">{agent}</span></Badge>} />
      </CardHeader>
      {body ? <TurnCardBody text={body} /> : null}
      {ctx.instanceId ? (
        <CardFooter>
          {/* 위임 카드 — 그 위임의 대화를 여는 문 */}
          <Button type="button" variant="outline" size="xs" disabled={seeking}
            title="이 작업이 진행되는 대화를 탭으로 열어요. 보고와 질문이 거기에 떠요"
            onClick={async () => {
              setSeeking(true); setNotFound(false);
              const ok = await openDispatchConversation(ctx.instanceId, ctx.principal, agent, "");
              setSeeking(false);
              if (!ok) setNotFound(true);
            }}>
            {seeking ? "찾는 중…" : "이 작업의 대화 열기"}
          </Button>
          {notFound && <span className="text-xs text-destructive">아직 대화를 찾지 못했어요. 잠시 뒤 다시 눌러 주세요</span>}
        </CardFooter>
      ) : null}
    </TurnCard>
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
    <TurnCard title={`${origin} 에이전트가 보낸 요청${mission ? ` — ${mission} 미션` : ""}${reason ? `\n왜: ${reason}` : ""}\n· 사용자가 직접 입력한 메시지가 아닙니다`}>
      <CardHeader>
        <TurnCardHead time={time} label={`에이전트 요청${mission ? ` · ${mission}` : ""}`}
          chip={<Badge variant="secondary" className="rc-chip"><AgentIcon slug={origin} /><span className="rc-chip-tx">{origin}</span></Badge>} />
        {reason ? <CardDescription className="text-xs leading-normal text-foreground break-words">↳ {reason}</CardDescription> : null}
      </CardHeader>
      {body ? <TurnCardBody text={body} /> : null}
    </TurnCard>
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
    <TurnCard title="스킬 호출 — 빌더가 이 스킬의 저작 지식으로 스캐폴드합니다">
      <CardHeader>
        <TurnCardHead time={time} label="스킬로 시작"
          chip={<Badge variant="secondary" className="rc-chip"><span className="rc-chip-slash" aria-hidden>✦</span><span className="rc-chip-tx">{name}</span></Badge>} />
      </CardHeader>
      {body ? <TurnCardBody text={body} /> : null}
    </TurnCard>
  );
}

export function UserMessage() {
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
    const failed = delivered && /\(실패\)\s*$/.test(head0);
    const aborted = delivered && /\(중단\)\s*$/.test(head0);
    // 아이콘이 서므로 머리의 이모지는 뗀다(같은 뜻을 두 번 그리지 않는다)
    const head = delivered
      ? `맡긴 작업이 끝났어요${failed ? " · 실패" : aborted ? " · 중단됨" : ""}`
      : head0.replace(/^[⏰📬📋]\s*/u, "");
    const Icon = failed ? TriangleAlertIcon : aborted ? CircleSlashIcon : delivered ? InboxIcon : AlarmClockIcon;
    // 말풍선도 카드도 아닌 **대화의 눈금** — shadcn Marker(separator): 양옆 실선이 흐름을 끊고
    // 가운데 한 줄만 남는다. 옛 알약 칩(.rc-wake-chip)은 제 상자를 가져 메시지처럼 읽혔다.
    return (
      <MessagePrimitive.Root asChild className="rc-msg">
        <Marker variant="separator" className="my-1 text-xs"
          title={delivered ? "다른 대화에서 맡긴 작업의 결과가 이 대화로 왔어요. 아래 답이 그 결과예요" : "예약된 시각에 에이전트가 스스로 시작한 응답이에요"}>
          <MarkerIcon className="size-3.5 [&_svg:not([class*='size-'])]:size-3.5"><Icon /></MarkerIcon>
          <MarkerContent className="flex-none text-center">
            {head}
            {time ? <span className="opacity-70"> · {time}</span> : null}
          </MarkerContent>
        </Marker>
      </MessagePrimitive.Root>
    );
  }
  // rc-user 는 chat.css 의 등장 애니메이션·썸네일 규칙이 참조하는 이름 — 유지한다(상단 sticky 는 MessageScroller 가 대신한다).
  // 말풍선은 shadcn Bubble(secondary). 보낸 시각은 보이지 않는다(피드백 2026-08-27: 중요도 낮음).
  return (
    <MessagePrimitive.Root asChild className="rc-msg rc-user">
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" align="end">
            <BubbleContent className="whitespace-pre-wrap leading-[1.35]">
              {images.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {images.map((p, i) => <AttOpenChip key={i} part={p} onOpen={() => setLightbox(p)} />)}
                </div>
              )}
              <MessagePrimitive.Parts components={{ Image: NullImagePart }} />
            </BubbleContent>
          </Bubble>
        </MessageContent>
        {lightbox && <ImageLightbox src={lightbox.image} name={lightbox.filename} onClose={() => setLightbox(null)} />}
      </Message>
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage() {
  // MessagePrimitive.Parts(파트별 독립 렌더) 대신 파트 배열을 직접 그룹화해 렌더한다 —
  // 연속 스텝을 한 타임라인으로 묶고 완료 시 접으려면 파트 간 관계를 봐야 하기 때문.
  const content = useMessage((m) => m.content as readonly AnyPart[]);
  const running = useMessage((m) => m.status?.type === "running");
  const durationMs = useMessage((m) => (m.metadata?.custom as TurnMeta | undefined)?.durationMs);
  // 이 턴에 무대에 앉은 산출물 — 실황은 봉투 file 이벤트, 재생은 이력의 files 가 채운다
  const stageFiles = useMessage((m) => (m.metadata?.custom as TurnMeta | undefined)?.files);
  const groups = useMemo(() => groupParts(content), [content]);
  // 스텝 묶음의 접힘은 **턴 하나**의 상태다 — 글이 끼어들어 묶음이 갈려도 요약 칩은 하나,
  // 개수도 턴 전체의 작업 수다(묶음마다 제 개수를 말하면 "작업 1개" 아래에 작업 둘이 보인다).
  const firstTrace = groups.findIndex((g) => g.kind === "trace");
  const toolCount = groups.reduce((n, g) => g.kind === "trace" ? n + g.steps.filter((s) => s.type === "tool-call").length : n, 0);
  // 실행 중엔 늘 펼쳐 흘려 보이고(요약 칩도 그때는 뜨지 않는다), 끝나면 접는다.
  // 히스토리 리플레이(처음부터 running=false)는 접힌 채 시작.
  const [traceOpen, setTraceOpen] = useState(running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setTraceOpen(false);
    wasRunning.current = running;
  }, [running]);
  const stepsOpen = running || traceOpen;
  // 어시스턴트 산문은 말풍선 없이(상자 없는 모습 유지) — MessageContent(gap-2.5)가 파트 간 간격을 잡는다
  return (
    <MessagePrimitive.Root asChild className="rc-msg">
      <Message>
        <MessageContent>
          {groups.map((g, i) => {
            const isLast = i === groups.length - 1;
            if (g.kind === "md") return <MdBlock key={i} text={g.text} streaming={running && isLast} />;
            if (g.kind === "plan") return <PlanCard key={i} todos={g.todos} active={running} />;
            if (g.kind === "ask") return <AskCard key={i} part={g.part} active={running} />;
            if (g.kind === "steer") return <SteerCard key={i} part={g.part} />;
            if (g.kind === "choice") return <ChoiceCard key={i} part={g.part} />;
            if (g.kind === "files") return <FileCard key={i} part={g.part} />;
            return (
              <TraceTimeline key={i} steps={g.steps} running={running && isLast} turnRunning={running}
                             open={stepsOpen} onOpenChange={setTraceOpen}
                             showSummary={i === firstTrace} count={toolCount}
                             durationMs={i === firstTrace ? durationMs : undefined} />
            );
          })}
          {stageFiles?.length ? <StageFiles paths={stageFiles} /> : null}
          <RunningStatus />
          <TurnStatusChip />
          {/* 한도는 턴 결과와 별개다 — 성공한 턴에도 경고는 떠야 다음 발화 전에 읽힌다 */}
          <TurnLimitNotice />
        </MessageContent>
      </Message>
    </MessagePrimitive.Root>
  );
}
