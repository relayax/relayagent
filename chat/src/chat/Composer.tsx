/*!
 * Composer.tsx — 입력 영역: 대상 칩과 피커(ContextChips·TargetPicker·TargetAddPicker), 모델·추론 강도
 * 피커(ModelPicker·EffortRow), 첨부·대기열·슬래시/@ 자동완성을 가진 Composer, 진행 중 턴 재부착(AttachOnMount).
 *
 * 그릇은 shadcn(base-ui) — InputGroup(입력 카드) · Popover(대상 피커·슬래시 목록) · DropdownMenu(모델)
 * · ToggleGroup(추론 강도) · Attachment(첨부 칩) · Item(대기열·피커 줄) · Command(슬래시 목록) · Kbd.
 * 팝오버·메뉴는 body 로 포탈되므로 도크 패널의 overflow 에 잘리지 않는다 — 옛 `stack` 측정이 사라진 이유.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useThread, useThreadRuntime } from "@assistant-ui/react";
import type { RelayCtx, ModelOption, AgentEntry, SlashCommand, ActiveTurn, NavInstance } from "./runtime";
import { loadEffort, setEffort, loadAttTotalLimit, EFFORT_LEVELS, loadModel, setModel, modelOptions, loadModelOptions, lastConnectedModel, contextWindowFor, setPendingAttachments, uploadAttachment, loadCommands, loadAgents, setAttachTurn, parseBuiltin, executeBuiltin, onOverridesChanged, notifyOverridesChanged, hasSteer, steerTurn,
  loadHarnessVariants,
  loadHarnessName,
  loadModelOptionsFor,
  setHarnessAndModel,
  hasEffort,
  serverAgentOf,
  serverParamOf,
  loadInbox, loadInstances } from "./runtime";
import { threadFamily, siblingThread, displayBinding, paramTargets, withTargets, targetCandidates } from "./routematch";
import { useRelayCtx, ActivePaneCtx, OpenConversationCtx, PaneTargetCtx, type PaneTarget } from "./ctx";
import { modelLabelOf, providerLabelOf, harnessShortOf, withRo, fmtSize, fmtTok, attToPayload, loadQueue, saveQueue, type Chip, type PendingAtt, type QItem } from "./parts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ArrowUpIcon, ArrowUpRightIcon, CheckIcon, ChevronDownIcon, DownloadIcon, FileIcon, PlusIcon, SlidersHorizontalIcon, SquareIcon, XIcon } from "lucide-react";

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

/** 피커 카드 안의 안내 한 줄 — 목록 위·빈 목록·불러오는 중 모두 같은 톤 */
function PickNote({ children }: { children: React.ReactNode }) {
  return <p className="m-0 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">{children}</p>;
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
  // 피커는 칩에 붙는 Popover 다(모델 메뉴와 같은 자리) — 밖을 누르거나 Esc 면 닫는 건 Popover 가 맡는다.
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  // 대상 축은 에이전트에 바인딩된 대화에만 있다(main 대화엔 워크벤치 개념이 없다).
  const hasTargetAxis = !!(displayBinding(ctx.conversationId).agent || serverAgentOf(ctx.conversationId));
  if (!derived.length && !host.length) return null;

  const chipBody = derived.map((c, i) => (
    <span className="inline-flex min-w-0 items-center gap-1.5" key={i}>
      {c.icon === "slash"
        ? <span className="rc-chip-slash" aria-hidden>/</span>
        : <span className="rc-chip-dot" aria-hidden />}
      <span className="rc-chip-tx">{c.text}</span>
    </span>
  ));
  const label = derived.map((c) => c.text).join(" / ");
  const pickCard = "w-max min-w-60 max-w-[min(340px,calc(100vw-40px))] max-h-[300px] overflow-y-auto gap-0 rounded-xl p-1.5";

  return (
    <div className="rc-chips">
      {derived.length > 0 && (target ? (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <Popover open={picking} onOpenChange={(o) => { setPicking(o); if (o) setAdding(false); }}>
            {/* 칩 버튼 — Badge 와 같은 높이(h-5)로 맞춰 정적 칩과 한 줄에 선다 */}
            <PopoverTrigger render={<Button type="button" variant="secondary" size="xs" className="rc-chip h-5 max-w-full cursor-pointer gap-2 rounded-full px-2 text-xs" />}
                            title={label + " — 클릭해서 대상 바꾸기"} aria-haspopup="listbox">
              {chipBody}
              <ChevronDownIcon className="size-3! opacity-45" aria-hidden />
            </PopoverTrigger>
            {picking && (
              <PopoverContent side="top" align="start" sideOffset={6} className={pickCard}>
                <TargetPicker ctx={ctx} target={target} onSend={onSend} onClose={() => setPicking(false)} />
              </PopoverContent>
            )}
          </Popover>
          {hasTargetAxis && (
            <Popover open={adding} onOpenChange={(o) => { setAdding(o); if (o) setPicking(false); }}>
              {/* [+] 대상 추가 — 칩과 같은 알약이되 정사각(아이콘 자리). 교체(▾)와 시각적으로 분리한다. */}
              <PopoverTrigger render={<Button type="button" variant="secondary" size="xs" className="rc-chip h-5 cursor-pointer rounded-full px-2 text-xs text-muted-foreground hover:text-foreground" />}
                              title="작업 대상 추가 — 이 대화에서 함께 볼 워크벤치" aria-haspopup="listbox">
                <PlusIcon className="size-3!" aria-hidden />
              </PopoverTrigger>
              {adding && (
                <PopoverContent side="top" align="start" sideOffset={6} className={pickCard}>
                  <TargetAddPicker ctx={ctx} target={target} onSend={onSend} onClose={() => setAdding(false)} />
                </PopoverContent>
              )}
            </Popover>
          )}
        </span>
      ) : (
        <Badge variant="secondary" className="rc-chip" title={label}>{chipBody}</Badge>
      ))}
      {host.map((c, i) => (
        <Badge variant="secondary" className="rc-chip" key={"h" + i} title={c.text}>
          <span className="rc-chip-slash" aria-hidden>/</span>
          <span className="rc-chip-tx">{c.text}</span>
        </Badge>
      ))}
    </div>
  );
}

/** 피커 줄 — Item 을 버튼으로 그린다(role=option). 카드 폭이 좁아 제목은 줄바꿈을 허용한다. */
const pickItemCls = "cursor-pointer rounded-lg text-left hover:bg-muted focus-visible:ring-2 aria-selected:bg-accent";

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

  const curFamily = threadFamily(ctx.conversationId);
  const page = target.getPageSlot();
  const pageConv = page && page.instanceId === ctx.instanceId ? page.conversationId : "";
  const label = (conv: string) => {
    const b = displayBinding(conv);
    return b.agent ? b.agent + (b.param ? ":" + paramTargets(b.param).join(", ") : "") : "기본 대화";
  };

  // 대상 **추가**는 여기 없다 — 칩 옆 [+] 버튼(TargetAddPicker)이 소유한다. 이 목록은 교체 전용:
  // 두 동작을 한 목록에 섞으면 "바꾸는 건지 더하는 건지"가 매번 헷갈린다.
  type Entry = { key: string; name: string; desc: string; run: () => void };
  const items: Entry[] = [];
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
    <div className="flex flex-col gap-px" role="listbox" aria-label="대화 대상 바꾸기">
      <PickNote>
        {empty ? "빈 대화라 이 자리에서 대상만 바뀝니다" : "말이 오간 대화는 그대로 두고 그 대상의 대화로 이동합니다"}
      </PickNote>
      {items.length === 0 ? (
        <PickNote>이 에이전트 안에서 바꿀 수 있는 다른 대상이 없습니다</PickNote>
      ) : items.map((it) => (
        <Item key={it.key} render={<button type="button" />} role="option" aria-selected={false} size="xs" className={pickItemCls}
              onClick={() => { it.run(); onClose(); }}>
          <ItemContent>
            <ItemTitle className="text-xs">{it.name}</ItemTitle>
            <ItemDescription className="m-0">{it.desc}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
      {insts.length > 0 && (
        <>
          {/* 섹션 구분 — "여기가 바뀐다"(위)와 "저기로 간다"(아래)를 눈으로 가른다. */}
          <div className="mt-1 border-t border-border px-2.5 pt-2 pb-1 text-[11px] leading-snug text-muted-foreground">다른 에이전트 — 새 탭으로 열립니다</div>
          {insts.map((i) => (
            <Item key={i.id} render={<button type="button" />} role="option" aria-selected={false} size="xs" className={pickItemCls}
                  onClick={() => { target.openInstance(i.id); onClose(); }}>
              <ItemMedia variant="icon"><ArrowUpRightIcon className="opacity-60" aria-hidden /></ItemMedia>
              <ItemContent>
                <ItemTitle className="text-xs">{i.id}</ItemTitle>
                <ItemDescription className="m-0">{i.pkg || (i.kind === "base" ? "코어 도구" : "에이전트")}</ItemDescription>
              </ItemContent>
            </Item>
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
    <div className="flex flex-col gap-px" role="listbox" aria-label="작업 대상 추가" aria-multiselectable>
      <PickNote>
        {"지금 대상: " + (curTargets.length ? curTargets.join(", ") : "없음")}
        {empty ? " · 빈 대화라 이 자리에서 더해집니다" : " · 대화는 그대로 두고 대상만 더합니다"}
      </PickNote>
      {rows === null ? (
        <PickNote>불러오는 중…</PickNote>
      ) : candidates.length === 0 ? (
        <PickNote>더할 수 있는 대상이 없습니다 — 그 워크벤치를 한 번 열어 보면 여기 목록에 잡힙니다</PickNote>
      ) : (
        <>
          {candidates.map((t) => {
            const on = picked.includes(t);
            return (
              <Item key={t} render={<button type="button" />} role="option" aria-selected={on} size="xs" className={pickItemCls}
                    onClick={() => toggle(t)}>
                <ItemMedia variant="icon" className="opacity-70">{on ? <CheckIcon aria-hidden /> : <SquareIcon aria-hidden />}</ItemMedia>
                <ItemContent><ItemTitle className="text-xs">{t}</ItemTitle></ItemContent>
              </Item>
            );
          })}
          <Button type="button" size="sm" className="mt-1 w-full" disabled={!picked.length} onClick={apply}>
            {picked.length ? picked.join(", ") + " 함께 보기" : "대상을 고르세요"}
          </Button>
        </>
      )}
    </div>
  );
}

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

/** 메뉴 바닥의 추론 강도 줄 — "Effort (High)" + 5단 토글(low→max, ToggleGroup single). 오버라이드가
 *  없으면 아무 단도 눌리지 않고 실효 기본(브레인이 보고한 레벨)에 **점선 밑줄**이 앉는다. 단을 누르면
 *  명시(눌림), 눌린 단을 다시 누르면 기본으로. ←/→·↑/↓ 로도 옮긴다. 대화별로 브레인에 저장.
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
  // 화살표는 단을 옮긴다(옛 슬라이더 계약). 메뉴(↑/↓ 항목 이동)와 토글 그룹(←/→ 포커스 이동)의 기본
  // 처리보다 먼저 잡아 둘 다 막는다 — 값이 옮겨지는 것이 곧 피드백이다.
  const onKeyDown = (e: React.KeyboardEvent & { preventBaseUIHandler?: () => void }) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(EFFORT_LEVELS.length - 1, shownIdx + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, shownIdx - 1);
    if (next < 0) return;
    e.preventDefault(); e.stopPropagation(); e.preventBaseUIHandler?.();
    set(EFFORT_LEVELS[next]);
  };
  if (supported === false) return null;

  return (
    <div className={"mt-1 flex flex-col gap-1.5 border-t border-border px-2 pt-2 pb-1" + (loaded ? "" : " rc-model-loading")}
         title="추론 강도 — 이 대화에만 적용, 다음 응답부터. 단을 눌러 설정 · 눌린 단을 다시 누르면 기본값. 점선 밑줄이 이 대화가 기본으로 실행되는 레벨입니다.">
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground whitespace-nowrap">
        <SlidersHorizontalIcon className="size-3.5 opacity-80" aria-hidden />
        Effort <span className={isDefault ? "font-normal text-muted-foreground" : "text-muted-foreground"}>({label})</span>
        {err && <span className="rc-save-err">저장 실패</span>}
      </span>
      <ToggleGroup variant="outline" spacing={0} className="w-full" aria-label="추론 강도"
                   value={effort ? [effort] : []} onValueChange={(v) => set(String(v[0] ?? ""))} onKeyDown={onKeyDown}>
        {EFFORT_LEVELS.map((lv, i) => (
          <ToggleGroupItem key={lv} value={lv} size="sm" aria-label={EFFORT_LABELS[lv] || lv} title={EFFORT_LABELS[lv] || lv}
            className={"h-6 min-w-0 flex-1 px-1 text-[11px]"
              + (i === shownIdx && isDefault ? " text-foreground underline decoration-dotted underline-offset-4" : "")
              + (i > shownIdx ? " text-muted-foreground" : "")}>
            {EFFORT_LABELS[lv] || lv}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** 한 버튼 안의 모델 선택 — DropdownMenu. 공급자(하네스 변형, capability harness-variants)는 서브메뉴,
 *  그 안이 그 공급자의 모델 카탈로그. 옛 HarnessSelector + ModelSelector 를 합친 것(2026-08-26):
 *  두 버튼이 나란히 있으면 "Harness" 라는 말을 알아야 모델을 바꿀 수 있었다.
 *  - 변형이 하나뿐(또는 미선언)이면 서브메뉴 없이 모델 목록만 편다.
 *  - 서브메뉴는 공급자에 **호버(포커스)해야** 열린다. 활성이 아닌 공급자도 전환 없이 그 목록을
 *    보여준다(`?variant=` 조회). 거기서 모델을 고르면 전환+지정이 한 요청으로 간다.
 *  - 모델 줄은 이 대화의 오버라이드(다음 응답부터). "기본"은 인스턴스 바인딩을 따른다.
 *  서브메뉴 자리는 base-ui 포지셔너가 잡는다(뷰포트 충돌 시 반대쪽) — body 포털이라 도크 패널의
 *  overflow 에 잘리지 않으므로 옛 `stack` 측정은 없다. */
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
  // 서브메뉴(모델 목록)는 공급자 줄에 호버·포커스해야 편다(피드백 2026-08-26: 열자마자 다 보이면 시끄럽다)
  const [hover, setHover] = useState<string | null>(null);
  // 공급자별 카탈로그 — undefined = 아직 안 물음, null = 미도달
  const [byVariant, setByVariant] = useState<Record<string, ModelOption[] | null>>({});
  const [loaded, setLoaded] = useState(false);
  // 활성 하네스 항목 — 서버 카탈로그(가족별 최신). 로드 전/미도달은 정적 폴백(modelOptions 초기값).
  const [options, setOptions] = useState(modelOptions());
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
  useEffect(() => { if (!open) setHover(null); }, [open]);
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

  // 라디오 값 — "" 는 base-ui 라디오 값으로 쓰기 어색해 "기본" 줄은 센티널로 나타낸다.
  const DEFAULT_ROW = " default";
  const NONE = " none";
  /** 한 공급자의 모델 목록 단. own = 활성 하네스(오버라이드 축) / 아니면 전환 축 */
  const rowsFor = (p: { name: string; provider?: string } | null) => {
    const own = !p || p.name === active;
    const list = own ? options : byVariant[p.name];
    const pick = (id: string) => (own ? setModelId(id) : setHarnessModel(p!.name, id));
    const value = own ? (model || DEFAULT_ROW) : NONE;
    return (
      <DropdownMenuRadioGroup value={value} onValueChange={(v) => pick(v === DEFAULT_ROW ? "" : String(v))} aria-label="모델">
        {list === undefined && <PickNote>모델 목록을 읽는 중…</PickNote>}
        {list === null && <PickNote>모델 목록을 받지 못했습니다 — 고르면 이 공급자로 바꿉니다</PickNote>}
        {list !== undefined && (
          <DropdownMenuRadioItem value={DEFAULT_ROW} closeOnClick className="rounded-lg">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-medium">기본</span>
              {own && effDefault && <span className="text-[11px] text-muted-foreground">현재 {labelOf(effDefault)}</span>}
            </span>
          </DropdownMenuRadioItem>
        )}
        {(list ?? []).map((m) => (
          <DropdownMenuRadioItem key={m.id} value={m.id} closeOnClick className="rounded-lg">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-medium">{m.label}</span>
              {m.label.toLowerCase() !== m.id.toLowerCase() && <span className="text-[11px] text-muted-foreground">{m.id}</span>}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    );
  };

  return (
    <div className={"rc-model" + (loaded ? "" : " rc-model-loading")}
         title="AI 모델 — 이 대화에만 적용, 다음 응답부터. '기본'은 인스턴스 바인딩(없으면 CLI 기본)을 따릅니다.">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        {/* 모델 버튼 — 도구 줄 오른쪽의 글자 버튼(레퍼런스의 "Auto"). 테두리 없이 이름과 꺾쇠만 */}
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="xs" className="h-auto cursor-pointer gap-1 px-1.5 py-1 text-[12.5px] text-muted-foreground hover:text-inherit" />}>
          <span className={model ? "font-semibold text-foreground" : "font-medium text-muted-foreground"}>{shown}</span>
          <ChevronDownIcon className="size-2.5! opacity-60" aria-hidden />
          {err && <span className="rc-save-err">저장 실패</span>}
          {!err && hErr && <span className="rc-save-err">전환 실패</span>}
          {!err && !hErr && unknownId && <span className="rc-save-err">목록에 없는 id</span>}
        </DropdownMenuTrigger>
        {open && (
          <DropdownMenuContent side="top" align="end" sideOffset={6} className="w-auto min-w-58 rounded-xl p-1.5">
            {twoPane ? (
              <DropdownMenuGroup aria-label="공급자">
                <DropdownMenuLabel>공급자</DropdownMenuLabel>
                {variants.map((v) => (
                  <DropdownMenuSub key={v.name} onOpenChange={(o) => { if (o) setHover(v.name); }}>
                    <DropdownMenuSubTrigger className="rounded-lg">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-xs font-medium">{providerLabelOf(v)}</span>
                        {providerLabelOf(v) !== v.name && <span className="text-[11px] text-muted-foreground">{v.name}</span>}
                      </span>
                      {active === v.name && <CheckIcon className="text-foreground" aria-hidden />}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-52 rounded-xl p-1.5">
                      <DropdownMenuLabel>모델</DropdownMenuLabel>
                      {rowsFor(v)}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuGroup>
            ) : (
              <DropdownMenuGroup aria-label="모델">
                <DropdownMenuLabel>모델</DropdownMenuLabel>
                {rowsFor(null)}
              </DropdownMenuGroup>
            )}
            <EffortRow />
          </DropdownMenuContent>
        )}
      </DropdownMenu>
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
export function Composer({ resumingTurn, onSwitch }: { resumingTurn: boolean; onSwitch?: (c: string) => void }) {
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


  // 슬래시·@ 목록은 입력 카드 위에 붙는 Popover — 열림은 본문 텍스트가 정하고(트리거는 자리 표시용
  // 0px 앵커), 닫힘만 Popover 에서 받는다: Esc·바깥 클릭. 카드 안(글칸) 클릭은 계속 연 채로 둔다.
  const rootRef = useRef<HTMLDivElement>(null);
  const onPickerOpenChange = (o: boolean, d: { reason: string; event: Event }) => {
    if (o) return;
    const t = d.event?.target as Node | null;
    if (d.reason === "outside-press" && t && rootRef.current?.contains(t)) return;
    if (slashOpen) setSlashClosed(true);
    if (atOpen) setAtClosed(true);
  };
  const pickerOpen = slashOpen || atOpen;
  const uploading = atts.some((a) => a.uploading);

  return (
    <div className="rc-composer" ref={rootRef} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragging && (
        <div className="rc-drop" aria-hidden>
          <Empty className="gap-1 border-0 p-4">
            <EmptyMedia variant="icon" className="mb-0 size-8 bg-transparent text-[var(--rc-accent-strong)]"><DownloadIcon /></EmptyMedia>
            <EmptyTitle className="text-[13px] font-semibold text-[var(--rc-accent-strong)]">여기에 파일을 놓으세요</EmptyTitle>
          </Empty>
        </div>
      )}
      {queued.length > 0 && (
        <ItemGroup className="gap-1.5">
          {queued.map((q, i) => (
            <Item key={i} role="status" variant="muted" size="xs" className="flex-nowrap rounded-[10px] border-dashed border-border py-1.5 text-xs text-muted-foreground">
              <ItemMedia variant="icon" className="text-[var(--rc-accent)]"><ArrowUpIcon aria-hidden /></ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="block w-full truncate text-xs font-normal">전송 대기 중 · {q.text.replace(/\n/g, " ")}{q.atts.length ? ` · 📎${q.atts.length}` : ""}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="대기 취소" onClick={() => removeQueued(i)}><XIcon /></Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {attError && (
        <div className="rc-att-error" role="alert">
          <span className="rc-att-error-tx">{attError}</span>
          <Button type="button" variant="ghost" size="icon-xs" className="rc-att-error-x" aria-label="닫기" onClick={() => setAttError(null)}>×</Button>
        </div>
      )}
      <Popover open={pickerOpen} onOpenChange={onPickerOpenChange}>
        {/* 입력 카드 — 위는 칩·첨부, 가운데 글, 아래 줄은 왼쪽(+ 첨부)·오른쪽(컨텍스트 · 모델 · 전송).
            카드 빈자리를 눌러도 입력으로. 포커스 링은 카드가 진다(has-[control:focus-visible]) */}
        <InputGroup className="h-auto flex-col items-stretch gap-1.5 rounded-2xl border-border bg-background px-3 pt-2.5 pb-2 shadow-none dark:bg-background"
                    onClick={(e) => { if (e.target === e.currentTarget) taRef.current?.focus(); }}>
          {/* 슬래시·@ 목록의 앵커 — 카드 윗변 폭만큼의 0px 줄. 보이지도, 포커스되지도 않는다 */}
          <PopoverTrigger nativeButton={false} render={<span className="pointer-events-none absolute inset-x-0 top-0 h-0" />} aria-hidden tabIndex={-1} />
          {/* 에이전트(대상) 칩 — 카드 맨 위(레퍼런스: 맥락 칩 → 글 → 도구 줄). 그 아래 첨부 칩 */}
          <InputGroupAddon align="block-start" className="flex-col items-stretch gap-1.5 px-0 pt-0 pb-0 font-normal empty:hidden"
                           onClick={(e) => { if (e.target === e.currentTarget) taRef.current?.focus(); }}>
            <ContextChips onSend={sendOrQueue} />
            {atts.length > 0 && (
              <AttachmentGroup className="flex-wrap gap-1.5 overflow-visible py-0">
                {atts.map((a) => {
                  const img = a.mime.startsWith("image/") && !!a.dataUrl;
                  return (
                    <Attachment key={a.id} size="xs" state={a.uploading ? "uploading" : "done"} className="min-w-0 max-w-60">
                      <AttachmentMedia variant={img ? "image" : "icon"}>
                        {img ? <img src={a.dataUrl} alt={a.name} /> : <FileIcon aria-hidden />}
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle title={a.name}>{a.name}</AttachmentTitle>
                        <AttachmentDescription>{a.uploading ? `업로드 ${a.progress ?? 0}%` : fmtSize(a.size)}</AttachmentDescription>
                      </AttachmentContent>
                      <AttachmentActions>
                        <AttachmentAction aria-label="첨부 제거" onClick={() => removeAtt(a.id)}><XIcon /></AttachmentAction>
                      </AttachmentActions>
                    </Attachment>
                  );
                })}
              </AttachmentGroup>
            )}
          </InputGroupAddon>
          <InputGroupTextarea
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
          <InputGroupAddon align="block-end" className="flex-wrap gap-1 gap-y-1.5 px-0 pt-0 pb-0 font-normal cursor-default"
                           onClick={(e) => { if (e.target === e.currentTarget) taRef.current?.focus(); }}>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
            />
            <InputGroupButton size="icon-sm" className="size-7 cursor-pointer text-muted-foreground" aria-label="파일 첨부" title="파일 첨부" onClick={() => fileRef.current?.click()}>
              <PlusIcon />
            </InputGroupButton>
            <span className="flex-1" />
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
            {/* 전송·중지 — 원형 30px. 중지의 회색은 의도한 룩 */}
            {running ? (
              <Button type="button" size="icon-sm" className="size-[30px] cursor-pointer rounded-full bg-[#a9b0b7] hover:bg-[#8f979f]" aria-label="중지" onClick={() => rt.cancelRun()}>
                <SquareIcon className="size-3 fill-current" />
              </Button>
            ) : (
              <Button type="button" size="icon-sm" className="size-[30px] cursor-pointer rounded-full" aria-label="전송"
                disabled={(!text.trim() && atts.length === 0) || uploading}
                title={uploading ? "파일 업로드 중…" : undefined}
                onClick={submit}><ArrowUpIcon strokeWidth={2.5} /></Button>
            )}
          </InputGroupAddon>
        </InputGroup>
        {pickerOpen && (
          <PopoverContent side="top" align="start" sideOffset={6} initialFocus={false} finalFocus={false}
                          className="w-(--anchor-width) max-h-[280px] gap-0 overflow-hidden rounded-xl p-0">
            {/* 목록은 Command — 필터·선택은 글칸이 쥔다(shouldFilter=false, value 제어). 마우스다운을
                막아 글칸 포커스를 지키고, 클릭(onSelect)에서 받아들인다. pointer 계열이라 터치도 같다 */}
            {slashOpen ? (
              <Command shouldFilter={false} value={(slashMatches[slashSel] || slashMatches[0])?.name ?? ""}
                       onValueChange={(v) => { const i = slashMatches.findIndex((c) => c.name === v); if (i >= 0) setSlashSel(i); }}
                       className="rounded-xl! bg-transparent p-1" onMouseDown={(e) => e.preventDefault()}>
                <CommandList aria-label="슬래시 커맨드" className="max-h-56">
                  <CommandEmpty className="py-3 text-xs text-muted-foreground">맞는 커맨드가 없습니다</CommandEmpty>
                  {slashMatches.map((c) => (
                    <CommandItem key={c.name} value={c.name} onSelect={() => acceptCommand(c)}
                                 className="flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 [&>svg:last-child]:hidden">
                      <span className="font-mono text-[13px] font-semibold text-[var(--rc-accent)]">/{c.name}</span>
                      {c.description && <span className="w-full truncate text-xs text-muted-foreground">{c.description}</span>}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            ) : (
              <Command shouldFilter={false} value={(atMatches[atSel] || atMatches[0])?.name ?? ""}
                       onValueChange={(v) => { const i = atMatches.findIndex((a) => a.name === v); if (i >= 0) setAtSel(i); }}
                       className="rounded-xl! bg-transparent p-1" onMouseDown={(e) => e.preventDefault()}>
                <CommandList aria-label="에이전트 지정" className="max-h-56">
                  <CommandEmpty className="py-3 text-xs text-muted-foreground">맞는 에이전트가 없습니다</CommandEmpty>
                  {atMatches.map((a) => (
                    <CommandItem key={a.name} value={a.name} onSelect={() => acceptAgent(a)}
                                 className="flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 [&>svg:last-child]:hidden">
                      <span className="font-mono text-[13px] font-semibold text-[var(--rc-accent)]">@{a.name}</span>
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {displayBinding(ctx.conversationId).agent === a.name
                          ? "현재 대화의 에이전트"
                          : (a.default ? "기본 에이전트 · " : "") + "이 에이전트와 새 대화를 시작합니다"}
                      </span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            )}
            <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <Kbd>↑</Kbd><Kbd>↓</Kbd> 이동 <Kbd>Enter</Kbd> 선택 <Kbd>Esc</Kbd> 닫기
            </div>
          </PopoverContent>
        )}
      </Popover>
      {notice && <div className="rc-builtin-notice" role="status">{notice}</div>}

    </div>
  );
}

/** Re-attaches to an in-flight turn on mount: appends the pending prompt as the latest user
 *  message and flags the adapter to stream the EXISTING turn (attachTurnStream) instead of
 *  starting a new one. Runs exactly once. Rendered inside the runtime provider so it can drive
 *  the thread; renders nothing. No attach → no-op. */
export function AttachOnMount({ attach }: { attach: ActiveTurn | null }) {
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
