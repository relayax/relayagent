/*!
 * ChatTabs.tsx — 공용 멀티 세션 탭 셸(VSCode식). 도킹 채팅(agent.tsx ChatChrome)과 전역
 * 데스크(/desk — Desk.tsx)가 이 하나를 공유한다(구 Desk 인라인 탭 로직에서 추출).
 *
 * 구조:
 *   · 탭마다 <ChatApp embedded active={활성}> 를 전부 마운트하고 보이는 탭만 display:flex, 나머지는
 *     display:none(keep-alive) — 백그라운드 탭 SSE 가 계속 흐르고 onStatus 가 탭 뱃지로 보고된다.
 *   · **탭 그룹(최대 2)**: VSCode 처럼 분할하면 탭 스트립 자체가 그룹별로 분리된다.
 *     - 그룹0(좌) 순서 = 평면 tabs 배열에서 그룹1 소속을 뺀 순서. 그룹1(우) 순서 = g2Keys 배열.
 *     - pane 은 그룹 트리에 **중첩하지 않고 평면 컨테이너에 그대로** 둔다 — 탭을 그룹 간 옮겨도
 *       React 언마운트가 없어 keep-alive(SSE) 가 유지된다. 그룹 헤드 행과 pane 행이 같은
 *       splitPct 를 공유해 경계가 픽셀 정렬된다(스플리터 6px = 헤드 gap 6px).
 *     - 그룹이 비면 자동 병합(좌가 비면 우가 전체를 인수, 우가 비면 분할 해제).
 *   · 헤더는 셸이 단일 소유(per-pane ChatHeader 는 embedded 로 억제 — 이중 헤더 제거):
 *       row1 = 그룹별 탭 스트립([뱃지][이름(더블클릭 rename)][×]) + 우측 [보관함][+새대화] (desk 는 [화면])
 *       row2 = 그룹별 활성 대화 이름 브레드크럼(더블클릭 rename — "칩 자리" 이름 유지)
 *   · 탭 overflow — 스트립이 넘치면 그룹별로 ‹ › 화살표가 나타나 부드럽게 좌우 스크롤(VSCode식).
 *     세로 휠→가로 스크롤, 활성 탭 자동 시야 유지도 그룹별로 동작.
 *   · 이름은 서버 제목이 없으면 첫 사용자 메시지로 자동 생성(Claude 세션식) + 영속. 더블클릭으로 덮어쓰기.
 *   · 보관함 = 전 인스턴스(에이전트 넘나듦) 대화 목록(loadInbox) — 행 클릭=탭 열기, hover=이름변경·삭제.
 *   · +새대화 = 포커스 그룹 활성 탭 인스턴스에 sibling 스레드 민팅 → 새 탭.
 *   · **미리보기 탭(VSCode 식)**: 탭을 만드는 주체는 사람이고, 페이지 이동은 "미리보기" 한 자리만
 *     빌려 쓴다(기울임 라벨). 다음 이동이 그 자리를 재사용하므로 순회해도 빈 탭이 쌓이지 않고,
 *     localStorage 에도 저장되지 않아 새로고침이 빈 탭을 복원하지 않는다. 첫 발화(턴 시작)·이름
 *     변경·드래그처럼 사람이 그 대화에 관여하는 순간 고정 탭으로 승격한다.
 *   · 탭 전부 닫힘 → dock=onAllClosed(패널 닫힘), desk=빈 상태.
 *   · variant="desk" 만 우측 뷰 iframe split(드래그 크기조절) 노출 — 뷰는 포커스 그룹의 활성 탭을 따른다.
 *   · 탭 드래그 = 같은 그룹 안 순서 이동 + **그룹 간 이동**(다른 스트립 위에 놓기 — 놓으면 활성화).
 *   · 탭 우클릭 = 컨텍스트 메뉴(닫기·다른 탭 닫기·오른쪽 탭 닫기·분할/그룹 이동/분할 해제) — shadcn ContextMenu.
 *   · 분할 경계는 드래그로 좌우 크기 조절(splitPct 20~80%, 영속).
 *   · localStorage: tabs/active 는 종전 키 그대로, split 키는 구 "splitKey 문자열" → 신
 *     JSON({keys,active,pct}) 을 모두 읽는다(마이그레이션).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { ChatApp, OpenConversationCtx, PaneTargetCtx, type DeskTurnStatus, type PaneTarget } from "./Chat";
import {
  loadInbox, loadInstances, renameConversation, deleteConversation, loadConversationTitle,
  seedConversation, isLocalConversation, onSessionMinted, viewUrlForInstance,
  type InboxRow, type RelayCtx,
} from "./runtime";
import { displayBinding, siblingThread, threadFamily } from "./routematch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import "./chat.css";

// 탭 바(40px) 안에 서는 아이콘 버튼 — 바 높이를 꽉 채우고 모서리는 세우지 않는다(종전 rc-tabs-* 룩).
const BAR_BTN = "h-full w-auto self-stretch rounded-none px-[11px] text-[var(--rc-soft)]";
// 보관함 행 안의 작은 액션(✎·🗑·✓) — 행 hover 때만 드러나는 20px 아이콘.
const ROW_ACT = "size-5 rounded-[5px] text-[11.5px] text-[var(--rc-faint)] hover:text-[var(--rc-soft)]";

export type ChatTabsVariant = "dock" | "desk";

/** preview = 미리보기 탭(VSCode 식) — 사람이 아니라 **페이지 이동**이 연 탭. 동시에 하나만
 *  존재하고(다음 이동이 같은 자리를 재사용), localStorage 에 저장되지 않으며, 대화가 실제로
 *  시작되는 순간(첫 발화·이름변경·드래그) 고정 탭으로 승격한다. */
export type Tab = { key: string; instanceId: string; conversationId: string; title: string; preview?: boolean };
/** 열기 요청 — 외부(relay:chat-open·도킹 openTab)가 특정 (인스턴스×대화) 탭을 열고 포커스한다.
 *  preview=페이지 이동이 끌어온 슬롯(미리보기로 착지), 생략=사람이 고른 대화(고정 탭). */
export type OpenReq = { instanceId: string; conversationId?: string; title?: string; preview?: boolean; targets?: string[] };

const keyOf = (instanceId: string, conversationId: string) => instanceId + "|" + conversationId;
const tabsKey = (v: ChatTabsVariant) => `relay-${v}-tabs`;
const activeStorageKey = (v: ChatTabsVariant) => `relay-${v}-active`;
const splitStorageKey = (v: ChatTabsVariant) => `relay-${v}-split`;
const VIEW_KEY = "relay-desk-view";
const VIEW_PCT_KEY = "relay-desk-viewpct";

function loadTabs(v: ChatTabsVariant): Tab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(tabsKey(v)) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t && typeof t.instanceId === "string" && t.instanceId && typeof t.conversationId === "string")
      .map((t) => ({ key: keyOf(t.instanceId, t.conversationId), instanceId: t.instanceId, conversationId: t.conversationId, title: String(t.title || "") }))
      // 같은 좌표는 하나만 — key 가 겹치면 pane 의 보임 판정(key === active)이 전부 참이 되어
      // 모든 pane 이 나란히 그려진다. 저장 시점에 이미 합쳐지지만 낡은 저장분도 여기서 막는다
      .filter((t: Tab, i: number, arr: Tab[]) => arr.findIndex((x) => x.key === t.key) === i);
  } catch { return []; }
}

/** 미리보기 자리 규칙(순수 — addTab 의 탭 배열 전이). 세 갈래뿐이다:
 *   · 이미 열린 탭 → 고정 요청이면 승격, 미리보기 요청이면 **무변화**(보던 배치를 건드리지 않는다)
 *   · 새 탭 + 미리보기 요청 → 직전 미리보기를 갈아끼운다(자리 하나 재사용 — 순회해도 안 쌓인다)
 *   · 새 탭 + 고정 요청 → 그냥 추가
 *  무변화면 **같은 배열을 그대로** 돌려준다 — 새 배열을 만들면 탭 스트립이 재렌더되고 영속
 *  effect 가 페이지 이동마다 localStorage 를 다시 쓴다. */
export function nextTabs(prev: Tab[], t: Tab): Tab[] {
  const at = prev.findIndex((x) => x.key === t.key);
  if (at >= 0) {
    if (t.preview || !prev[at].preview) return prev;
    const next = prev.slice();
    next[at] = { ...next[at], preview: false };
    return next;
  }
  return [...(t.preview ? prev.filter((x) => !x.preview) : prev), t];
}

/** 좌표 하나(인스턴스 × 대화) — 페이지 슬롯·새 대화 기준처럼 "탭이 아닌 대상"을 가리킬 때 쓴다. */
export type Slot = { instanceId: string; conversationId: string };

/** "+ 새 대화"가 열 좌표 — **페이지 슬롯이 기준**이고, 페이지가 없는 셸(/desk)에서만 보던 탭이
 *  기준이 된다. 종전에는 인스턴스 축만 페이지를 따르고 에이전트 축은 활성 탭을 따라, A 워크벤치를
 *  보면서 새 대화를 열면 직전에 보던 B 에이전트의 대화가 갈라져 나왔다(반쪽 규칙). */
export function newConversationTarget(page: Slot | null, active: Slot | null): Slot | null {
  const base = page || active;
  if (!base || !base.instanceId) return null; // 열 인스턴스가 없다 — 호출자가 보관함으로 유도
  return { instanceId: base.instanceId, conversationId: siblingThread(base.conversationId || "") };
}

/** 대화 좌표 제자리 교체(빈 대화 한정 — 칩 피커의 "대상 고치기"). 목표 좌표의 탭이 이미 열려
 *  있으면 그걸 남기고 비어 있던 원본만 접는다(같은 대화의 쌍둥이 빈 탭 방지). 제목은 좌표가
 *  바뀌었으니 비워 다시 자동 제목을 받게 한다. */
export function retargetTabs(prev: Tab[], key: string, conversationId: string): Tab[] {
  const i = prev.findIndex((t) => t.key === key);
  if (i < 0 || !conversationId) return prev;
  const src = prev[i];
  if (src.conversationId === conversationId) return prev;
  const nextKey = keyOf(src.instanceId, conversationId);
  if (prev.some((t) => t.key === nextKey)) return prev.filter((t) => t.key !== key);
  const next = prev.slice();
  next[i] = { ...src, key: nextKey, conversationId, title: "" };
  return next;
}

/** localStorage 에 남길 탭 — 미리보기는 저장하지 않는다(새로고침이 "가 보기만 한 빈 대화"를
 *  되살리면 안 된다). 저장 형태는 종전 그대로(key 는 로드 시 재조립). */
export function persistableTabs(tabs: Tab[]): Array<Pick<Tab, "instanceId" | "conversationId" | "title">> {
  return tabs.filter((t) => !t.preview).map(({ instanceId, conversationId, title }) => ({ instanceId, conversationId, title }));
}

/** 분할 영속 상태 — keys=우측 그룹 소속(순서), active=우측 활성, pct=좌측 폭 %. */
type SplitPersist = { keys: string[]; active: string; pct: number };
function loadSplit(v: ChatTabsVariant): SplitPersist {
  const none: SplitPersist = { keys: [], active: "", pct: 50 };
  try {
    const raw = localStorage.getItem(splitStorageKey(v));
    if (!raw) return none;
    if (raw.startsWith("{")) {
      const j = JSON.parse(raw);
      const keys: string[] = Array.isArray(j?.keys) ? j.keys.filter((k: unknown) => typeof k === "string") : [];
      const pct = typeof j?.pct === "number" && j.pct >= 20 && j.pct <= 80 ? j.pct : 50;
      return { keys, active: typeof j?.active === "string" && j.active ? j.active : keys[0] || "", pct };
    }
    return { keys: [raw], active: raw, pct: 50 }; // 구세대: splitKey 문자열 하나
  } catch { return none; }
}

/** 표시 이름 — 서버/자동 제목이 있으면 그대로, 없으면 "기본 대화"/"새 대화". */
function labelOf(t: Pick<Tab, "title" | "conversationId">): string {
  // 외부(임베더·목록)가 붙인 앞 트리 기호("└ ", "├ ")는 탭 안에서 뜻이 없어 표시에서만 뗀다.
  if (t.title && !isPlaceholderTitle(t.title)) return t.title.replace(/^[\u2500-\u257f\s]+/, "") || t.title;
  const id = t.conversationId;
  // main 패밀리(threadFamily)와 로컬 드래프트("c-…" — 지연 민팅 전) 모두 기본 대화로 그린다.
  if (!id || threadFamily(id) === "main") return "기본 대화";
  // 도킹 슬롯은 "새 대화"가 아니라 무엇을 하는 대화인지로 — 빌더 탭이 옆의 "기본 대화"와 무엇이
  // 다른지 알 수 없었다(2026-08-27). 빈 화면(EmptyStarter)과 같은 말.
  const b = displayBinding(id);
  if (b.agent === "agent-builder") return b.param ? `${b.param} 손보기` : "새로 만들기";
  if (b.agent) return `${b.agent} 대화`;
  return "새 대화";
}

/** 자동 제목을 덮어써도 되는 placeholder 인가 — 서버의 진짜 제목은 보존한다.
 *  (초기 시드/피커는 인스턴스 id 를 임시 title 로 심지만, 그건 labelOf 가 아니라 여기 통과 —
 *   인스턴스 id 도 사람이 붙인 제목일 수 있어 placeholder 로 보지 않는다. 자동 제목은 "새/기본/대화 ".) */
function isPlaceholderTitle(title: string): boolean {
  if (!title) return true;
  return title === "새 대화" || title === "기본 대화" || title === "이름 없는 대화";
}

function relTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  const m = Math.floor(s / 60); if (m < 60) return m + "분 전";
  const h = Math.floor(m / 60); if (h < 24) return h + "시간 전";
  const d = Math.floor(h / 24); if (d < 7) return d + "일 전";
  return new Date(t).toLocaleDateString();
}

const tabOf = (r: InboxRow): Tab => ({
  key: keyOf(r.instance, r.conversation_id),
  instanceId: r.instance,
  conversationId: r.conversation_id,
  title: r.title || "", // 서버 제목 없으면 빈 값 — labelOf 가 표시, 자동 제목이 채운다
});

/** 피커 한 줄. display = 화면에 세울 이름(설치 이름 id 는 툴팁에만) — 화면 축이라 wire 행
 *  (InboxRow)에 얹지 않고 여기서만 단다. */
export type PickerRow = InboxRow & { display?: string };

/** 인스턴스 하나의 묶음 — 사람이 연 대화와, 그 아래 접히는 위임.
 *  묶음 순서는 rows 순서(최근순)를 그대로 따른다 — 활발한 것이 위. */
export type PickerGroup = { instance: string; display: string; convs: PickerRow[]; subs: PickerRow[] };

export function groupRows(rows: PickerRow[]): PickerGroup[] {
  const out: PickerGroup[] = [];
  const by = new Map<string, PickerGroup>();
  for (const r of rows) {
    let g = by.get(r.instance);
    // 머리에 세우는 이름은 사람이 붙인 이름(display) — 설치 이름(id)은 툴팁에만 남는다.
    if (!g) { g = { instance: r.instance, display: r.display || r.instance, convs: [], subs: [] }; by.set(r.instance, g); out.push(g); }
    // origin = 기판이 밝힌 "기계가 판 슬롯"(§5.3-25). 슬롯 이름은 불투명이라 여기서 접두를 보지 않는다.
    if (r.origin) g.subs.push(r);
    else g.convs.push(r);
  }
  return out;
}

/** 위임 행의 이름 — 기계 라벨("↳ agent-builder · detail-page")의 화살표를 떼고 사람 말로.
 *  묶음이 이미 "맡긴 일"이라고 말했으므로 행은 누가·무엇을만 남긴다. 사용자가 이름을 바꿨으면
 *  그 이름이 정본이다(라벨 우선순위는 기판 몫 — §5.3-21). */
export function subLabel(r: PickerRow): string {
  const t = (r.title || "").replace(/^↳\s*/, "").trim();
  if (t) return t;
  if (r.agent) return r.param ? `${r.agent} · ${r.param}` : r.agent;
  return r.conversation_id;
}

/** 보관함 피커 행 — 전 인스턴스의 **대화**만(loadInbox).
 *  대화가 없는 에이전트는 여기 서지 않는다: 대화함은 대화를 세는 자리고, 아직 말 걸어본 적 없는
 *  에이전트를 여는 문은 이미 둘(사이드바 · 작성창의 상대 고르기)이다. 셋째 목록으로 겹쳐 놓으면
 *  "대화 없음"이 목록의 대부분을 차지해 정작 대화가 밀린다(2026-08-28 사용자 지적). */
async function loadPickerRows(principal: string): Promise<PickerRow[]> {
  const ctx = { instanceId: "", principal, conversationId: "", title: "" } as RelayCtx;
  const rows: PickerRow[] = await loadInbox(ctx).catch(() => []);
  // 설치 이름(id) 대신 화면에 세울 이름 — 런처·사이드바가 부르는 그 이름이다(NavInstance.pkg = display_name).
  try {
    // 열거는 instances.list 계약 동사(§5.6 — capability enumerate)로 — 구 /api/portal/nav 은퇴.
    const shown = new Map((await loadInstances()).filter((i) => i.pkg).map((i) => [i.id, i.pkg] as const));
    for (const r of rows) { const d = shown.get(r.instance); if (d) r.display = d; }
  } catch { /* 열거 실패 — 설치 이름으로 선다 */ }
  return rows;
}

/** 보관함 피커 — 전 에이전트 대화 나열 + 열기 + 이름변경·삭제(구 SessionMenu list UI 이식).
 *  배치·바깥클릭·Escape 는 Popover 가 맡는다(body 포털 — 도킹 aside 의 transform·overflow 클리핑
 *  탈출은 그대로). 열림 상태는 부모 소유 — "새 대화"가 열 대상이 없을 때 여기로 유도한다. */
function InboxPicker({
  principal, existing, open, onOpenChange, trigger, onOpen, onMutated,
}: {
  principal: string;
  existing: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 트리거 요소 — PopoverTrigger 가 render 로 감싼다(바 아이콘 버튼 · 빈 화면의 큰 버튼). */
  trigger: ReactElement;
  onOpen: (t: Tab) => void;
  onMutated: (instanceId: string, conversationId: string, title: string | null) => void;
}) {
  const [rows, setRows] = useState<PickerRow[] | null>(null);
  // 펼친 위임 묶음(인스턴스 id) — 기본은 접힘. 열 때마다 초기화한다.
  const [openSubs, setOpenSubs] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => loadPickerRows(principal).then(setRows), [principal]);
  // 열릴 때마다 목록을 다시 읽는다 — 편집·확인 상태도 매번 초기화.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRows(null); setEditing(null); setConfirming(null); setOpenSubs(new Set());
    loadPickerRows(principal).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [open, principal]);
  useEffect(() => { if (editing) editRef.current?.select(); }, [editing]);

  const close = () => onOpenChange(false);
  const toggleSubs = (instance: string) => setOpenSubs((prev) => {
    const next = new Set(prev);
    if (!next.delete(instance)) next.add(instance);
    return next;
  });
  const ctxOf = (r: InboxRow): RelayCtx => ({ instanceId: r.instance, principal, conversationId: r.conversation_id, title: r.title || r.instance });
  const label = (r: InboxRow) => (r.title ? r.title : isLocalConversation(r.conversation_id) ? "기본 대화" : r.conversation_id);
  // 시드 = 미민팅 로컬 드래프트 — 서버에 아직 없으니 삭제 버튼을 감춘다.
  const isSeed = (r: PickerRow) => isLocalConversation(r.conversation_id);

  const saveRename = async (r: InboxRow, value: string) => {
    if (busy) return;
    setBusy(true);
    const ok = await renameConversation(ctxOf(r), r.conversation_id, value.trim());
    setBusy(false);
    if (!ok) return;
    setEditing(null);
    onMutated(r.instance, r.conversation_id, value.trim() || null);
    await refresh();
  };
  const doDelete = async (r: InboxRow) => {
    if (busy) return;
    setBusy(true);
    const ok = await deleteConversation(ctxOf(r), r.conversation_id);
    setBusy(false);
    if (!ok) return;
    setConfirming(null);
    onMutated(r.instance, r.conversation_id, null);
    await refresh();
  };

  // 행 공통 — 한 줄(줄바꿈 없음)·12.5px. Item 의 [a]:hover 는 앵커 전용이라 hover 배경을 직접 준다.
  const ROW = "flex-nowrap gap-2 rounded-[7px] px-2 py-1.5 text-[12.5px]";
  const groups = rows === null ? [] : groupRows(rows);

  /** 대화 한 줄 — 이름(또는 편집·삭제확인) + 우측(시간/열림 ↔ 액션).
   *  인스턴스 이름은 묶음 머리가 이미 말했으므로 행에서는 배지를 다시 세우지 않는다. */
  const renderRow = (r: PickerRow, opts?: { indent?: boolean; text?: string }) => {
    const k = keyOf(r.instance, r.conversation_id);
    const pad = opts?.indent ? " pl-6" : "";
    if (editing === k) {
      return (
        <Item key={k} size="xs" className={ROW + pad}>
          <Input ref={editRef} className="h-7 flex-1 px-2 text-[12.5px] md:text-[12.5px] border-[var(--rc-accent)]" defaultValue={r.title || ""} placeholder={label(r)} maxLength={120} disabled={busy}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { e.preventDefault(); void saveRename(r, (e.target as HTMLInputElement).value); }
                   if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                 }} />
          <ItemActions>
            <Button type="button" variant="ghost" size="icon-xs" className={ROW_ACT} title="저장" aria-label="이름 저장" disabled={busy}
                    onClick={() => void saveRename(r, editRef.current?.value ?? "")}>✓</Button>
          </ItemActions>
        </Item>
      );
    }
    if (confirming === k) {
      return (
        <Item key={k} size="xs" className={ROW + pad}>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full font-normal text-[12.5px]">"{opts?.text ?? label(r)}" 삭제?</ItemTitle>
          </ItemContent>
          <ItemActions className="gap-1">
            <Button type="button" variant="destructive" size="xs" className="h-6 px-2 font-semibold" disabled={busy} onClick={() => void doDelete(r)}>{busy ? "삭제 중…" : "삭제"}</Button>
            <Button type="button" variant="ghost" size="xs" className="h-6 px-2 text-[var(--rc-faint)]" disabled={busy} onClick={() => setConfirming(null)}>취소</Button>
          </ItemActions>
        </Item>
      );
    }
    const isOpen = existing.has(k);
    const go = () => { if (!isOpen) onOpen(tabOf(r)); close(); };
    return (
      <Item key={k} role="menuitem" tabIndex={0} size="xs"
            className={cn(ROW + pad, "cursor-pointer hover:bg-muted focus-visible:bg-muted")}
            title={r.instance + " · " + r.conversation_id}
            onClick={go}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }}>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full font-normal text-[12.5px]">{opts?.text ?? label(r)}</ItemTitle>
        </ItemContent>
        {/* 우측 = 시간(평소) ↔ 액션(hover/focus, 터치 기기는 상시) — 같은 자리를 나눠 써 행 폭을 유지. */}
        <ItemActions className="shrink-0 gap-0.5">
          {isOpen
            ? <Badge variant="secondary" className="group-hover/item:hidden group-focus-within/item:hidden [@media(hover:none)]:hidden">열림</Badge>
            : r.last_started_at && (
              <span className="text-[11px] tabular-nums text-muted-foreground group-hover/item:hidden group-focus-within/item:hidden [@media(hover:none)]:hidden">{relTime(r.last_started_at)}</span>
            )}
          <span className="hidden items-center gap-0.5 group-hover/item:inline-flex group-focus-within/item:inline-flex [@media(hover:none)]:inline-flex">
            <Button type="button" variant="ghost" size="icon-xs" className={ROW_ACT} title="이름 바꾸기" aria-label="이름 바꾸기"
                    onClick={(e) => { e.stopPropagation(); setConfirming(null); setEditing(k); }}>✎</Button>
            {!isSeed(r) && (
              <Button type="button" variant="ghost" size="icon-xs" className={ROW_ACT} title="대화 삭제" aria-label="대화 삭제"
                      onClick={(e) => { e.stopPropagation(); setEditing(null); setConfirming(k); }}>🗑</Button>
            )}
          </span>
        </ItemActions>
      </Item>
    );
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} aria-haspopup="menu" aria-expanded={open} />
      {open && (
        <PopoverContent align="end" side="bottom" sideOffset={4}
                        className="w-[300px] max-w-[calc(100vw-16px)] gap-0 rounded-[10px] p-1">
          {rows === null ? (
            <div className="px-2 py-2 text-[11.5px] text-muted-foreground">불러오는 중…</div>
          ) : rows.length === 0 ? (
            <Empty className="gap-1 p-4">
              <EmptyHeader className="gap-1">
                <EmptyTitle className="text-[13px]">아직 대화가 없어요</EmptyTitle>
                <EmptyDescription className="text-[11.5px]">에이전트에게 말을 걸면 여기에 쌓여요</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            // max-h 는 루트(flex 열)에 — 뷰포트(overflow:scroll)가 그 안에서 줄어들며 스크롤한다.
            <ScrollArea className="flex max-h-[60vh] flex-col">
              <ItemGroup role="menu" className="gap-0.5 has-data-[size=xs]:gap-0.5">
                {groups.map((g) => {
                  const subsOpen = openSubs.has(g.instance);
                  return (
                    <Fragment key={g.instance}>
                      {/* 묶음 머리 = 인스턴스 이름 한 번. 행마다 반복되던 배지의 자리다. */}
                      <div className="truncate px-2 pt-2 pb-0.5 text-[10.5px] font-semibold text-muted-foreground" title={g.instance}>{g.display}</div>
                      {g.convs.map((r) => renderRow(r))}
                      {g.subs.length > 0 && (
                        <>
                          {/* 위임은 사람이 연 대화가 아니라 에이전트가 판 대화다 — 기본은 접어 두고,
                              펼치면 "누가 · 무엇을" 로 한 줄씩. */}
                          <Item role="menuitem" tabIndex={0} size="xs" aria-expanded={subsOpen}
                                className={cn(ROW, "cursor-pointer text-muted-foreground hover:bg-muted focus-visible:bg-muted")}
                                onClick={() => toggleSubs(g.instance)}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); toggleSubs(g.instance); } }}>
                            <ItemContent className="min-w-0">
                              <ItemTitle className="w-full font-normal text-[12px] text-muted-foreground">에이전트에게 맡긴 일 {g.subs.length}개</ItemTitle>
                            </ItemContent>
                            <ItemActions className="shrink-0">
                              <span className="text-[10px] text-muted-foreground">{subsOpen ? "▾" : "▸"}</span>
                            </ItemActions>
                          </Item>
                          {subsOpen && g.subs.map((r) => renderRow(r, { indent: true, text: subLabel(r) }))}
                        </>
                      )}
                    </Fragment>
                  );
                })}
              </ItemGroup>
            </ScrollArea>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

type TabMenuItem = { label: string; run: () => void; disabled?: boolean; title?: string } | "sep";

/** 탭 우클릭 메뉴 본문 — 항목 목록을 ContextMenuItem 으로 편다. 닫힘·배치·키보드는 ContextMenu 소관. */
function TabMenuItems({ items }: { items: TabMenuItem[] }) {
  return (
    <>
      {items.map((it, i) =>
        it === "sep" ? (
          <ContextMenuSeparator key={i} />
        ) : (
          // disabled 여도 title 툴팁은 살린다(pointer-events 복원) — "왜 안 되는지"를 hover 로 말해주는 항목이 있다.
          <ContextMenuItem key={i} disabled={it.disabled} title={it.title} onClick={it.run}
                           className={cn("text-[13px]", it.title && "data-disabled:pointer-events-auto")}>
            {it.label}
          </ContextMenuItem>
        ),
      )}
    </>
  );
}

/** 그룹 하나의 탭 스트립 — overflow 시 ‹ › 화살표(부드러운 스크롤), 세로 휠→가로 스크롤,
 *  활성 탭 자동 시야 유지. 상태(활성·드래그·메뉴)는 부모가 소유하고 여기는 표시/이벤트만. */
function TabStrip({
  tabs, activeKey, focused, editingKey, dragTab, style,
  badgeOf, renderRename, menuItemsOf,
  onActivate, onClose, onEditStart,
  onTabDragStart, onTabDragOver, onTabDragEnd, onStripDragOver,
  onFocusGroup,
}: {
  tabs: Tab[];
  activeKey: string;
  focused: boolean;
  editingKey: string | null;
  dragTab: string | null;
  style?: CSSProperties;
  badgeOf: (t: Tab) => { cls: string; text: string } | null;
  renderRename: (t: Tab, cls: string) => ReactNode;
  /** 우클릭 메뉴 항목 — 그룹·분할 상태는 부모가 알므로 항목 계산도 부모 몫. */
  menuItemsOf: (key: string) => TabMenuItem[];
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onEditStart: (key: string) => void;
  onTabDragStart: (e: React.DragEvent, key: string) => void;
  onTabDragOver: (e: React.DragEvent, key: string) => void;
  onTabDragEnd: () => void;
  onStripDragOver: (e: React.DragEvent) => void;
  onFocusGroup: () => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(false);

  // overflow 감지 — 스크롤 위치·컨테이너 폭·탭 수 변화 모두에서 화살표 노출/활성을 갱신.
  const sync = useCallback(() => {
    const s = stripRef.current;
    if (!s) return;
    const has = s.scrollWidth > s.clientWidth + 1;
    setCanL(has && s.scrollLeft > 1);
    setCanR(has && s.scrollLeft < s.scrollWidth - s.clientWidth - 1);
  }, []);
  useEffect(() => {
    const s = stripRef.current;
    if (!s) return;
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(s);
    s.addEventListener("scroll", sync, { passive: true });
    return () => { ro.disconnect(); s.removeEventListener("scroll", sync); };
  }, [sync]);
  useEffect(() => { sync(); }, [tabs, sync]);

  // 세로 휠 → 가로 스크롤(VSCode 탭 바식). 마우스 휠은 deltaY 만 내므로 이게 없으면 탭 스트립이
  // 트랙패드 가로 제스처에만 반응한다. React 의 onWheel 은 루트에 passive 로 붙어 preventDefault
  // 가 통하지 않아 네이티브 리스너를 { passive: false } 로 직접 건다.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;      // 넘칠 게 없으면 페이지에 양보
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;    // 가로 제스처는 브라우저 기본 동작
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  // 활성 탭이 스트립 스크롤 밖에 있으면 보이는 자리까지 당긴다.
  // scrollIntoView 는 조상까지 스크롤해 페이지를 흔들 수 있어 scrollLeft 를 직접 계산.
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.querySelector<HTMLElement>(".rc-desk-tab.on");
    if (!strip || !el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }, [activeKey, tabs.length]);

  const nudge = (dir: -1 | 1) => {
    const s = stripRef.current;
    if (!s) return;
    s.scrollBy({ left: dir * Math.max(140, Math.round(s.clientWidth * 0.66)), behavior: "smooth" });
  };

  const overflow = canL || canR;

  return (
    <div className={"rc-tab-ghead" + (focused ? " focus" : "")} style={style} onMouseDownCapture={onFocusGroup}>
      {overflow && (
        <Button type="button" variant="ghost" size="icon-xs" className={cn(BAR_BTN, "w-6 px-0 pb-[3px] text-[17px]")} disabled={!canL} aria-label="탭 왼쪽으로 스크롤"
                onClick={() => nudge(-1)}>‹</Button>
      )}
      <div className="rc-desk-tabstrip" role="tablist" ref={stripRef}
           onDragOver={onStripDragOver} onDrop={(e) => { e.preventDefault(); onTabDragEnd(); }}>
        {tabs.map((t) => {
          const b = badgeOf(t);
          return (
            // 탭 하나 = ContextMenu 하나. 트리거는 render 로 탭 div 자체를 쓴다(role=tab·드래그·클릭 유지) —
            // 우클릭·롱프레스 배치는 ContextMenu 가 포인터 좌표로 잡는다.
            <ContextMenu key={t.key}>
              <ContextMenuTrigger render={
                <div role="tab" aria-selected={t.key === activeKey}
                     className={"rc-desk-tab" + (t.key === activeKey ? " on" : "") + (t.key === dragTab ? " drag" : "") + (t.preview ? " rc-preview" : "")}
                     title={t.instanceId + " · " + t.conversationId + (t.preview ? "\n미리보기 · 메시지를 보내면 탭으로 남아요" : "")}
                     draggable={editingKey !== t.key}
                     onDragStart={(e) => onTabDragStart(e, t.key)}
                     onDragOver={(e) => onTabDragOver(e, t.key)}
                     onDrop={(e) => { e.preventDefault(); onTabDragEnd(); }}
                     onDragEnd={onTabDragEnd}
                     onClick={() => onActivate(t.key)}
                     onDoubleClick={(e) => { e.stopPropagation(); onEditStart(t.key); }} />
              }>
                {/* 안 본 결과 점은 chat.css 소유(정지, 애니메이션 없음) — 질문 대기는 작은 Badge. */}
                {b && (b.cls === "unread"
                  ? <span className="rc-desk-badge unread" aria-label="안 본 결과" />
                  : <Badge variant="outline" aria-label="질문 대기"
                           className="h-4 min-w-4 shrink-0 px-1 text-[10px] leading-none">{b.text}</Badge>)}
                {editingKey === t.key
                  ? renderRename(t, "rc-tab-rename")
                  : <span className="rc-desk-tab-tx">{labelOf(t)}</span>}
                {/* rc-desk-close 유지 — 글자 꼬리 위에 겹치는 음수 마진·페이드 그림자를 chat.css 가 소유한다. */}
                <Button type="button" variant="ghost" size="icon-xs" className="rc-desk-close h-auto" aria-label="탭 닫기"
                        onClick={(e) => { e.stopPropagation(); onClose(t.key); }}>×</Button>
              </ContextMenuTrigger>
              {/* 메뉴는 커서 아래로 편다 — 기본값(오른쪽)은 좁은 도킹 패널에서 왼쪽으로 뒤집혀
                  탭 스트립을 덮는다. 브라우저·VSCode 우클릭 메뉴와 같은 방향. */}
              <ContextMenuContent className="min-w-44" side="bottom" align="start" alignOffset={0} sideOffset={2}>
                <TabMenuItems items={menuItemsOf(t.key)} />
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      {overflow && (
        <Button type="button" variant="ghost" size="icon-xs" className={cn(BAR_BTN, "w-6 px-0 pb-[3px] text-[17px]")} disabled={!canR} aria-label="탭 오른쪽으로 스크롤"
                onClick={() => nudge(1)}>›</Button>
      )}
    </div>
  );
}

export function ChatTabs({
  variant, initial, onAllClosed, onCollapse, principal = "local",
  registerHandle,
}: {
  variant: ChatTabsVariant;
  initial?: OpenReq;
  onAllClosed?: () => void;
  /** 패널 접기(도킹) — 탭은 유지한 채 패널만 닫는다. 재오픈 시 localStorage 에서 복원. */
  onCollapse?: () => void;
  principal?: string;
  /** 외부 명령 핸들 등록(도킹 openTab). 마운트 시 1회 넘겨받고, 언마운트 시 해제. */
  registerHandle?: (h: { openTab: (r: OpenReq) => void } | null) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const persisted = loadTabs(variant);
    if (persisted.length) return persisted;
    if (initial?.instanceId) {
      // 대화 미주입 시드는 seedConversation — 마지막 민팅 세션(연속성) 또는 로컬 드래프트
      // (첫 발화 직전 session.create 지연 민팅, §5.3-22). 구 "chat-<id>" 로컬 발급 은퇴.
      const conv = initial.conversationId || seedConversation(initial.instanceId);
      // title 은 비워 시드 — 인스턴스 이름을 대화 제목으로 굳히지 않는다(첫 메시지로 자동 제목).
      // 이 시드는 사람이 고른 대화가 아니라 **지금 페이지의 슬롯**이므로 미리보기로 연다.
      return [{ key: keyOf(initial.instanceId, conv), instanceId: initial.instanceId, conversationId: conv, title: "", preview: true }];
    }
    return [];
  });
  const [active0, setActive0] = useState<string>(() => {
    try { return localStorage.getItem(activeStorageKey(variant)) || ""; } catch { return ""; }
  });
  // 우측 그룹(그룹1) — g2Keys 소속·순서, active1 활성, splitPct 좌측 폭 %. 비면 분할 없음.
  const splitInitRef = useRef<SplitPersist | null>(null);
  if (splitInitRef.current === null) splitInitRef.current = loadSplit(variant);
  const [g2Keys, setG2] = useState<string[]>(splitInitRef.current.keys);
  const [active1, setActive1] = useState<string>(splitInitRef.current.active);
  const [splitPct, setSplitPct] = useState<number>(splitInitRef.current.pct);
  const [focus, setFocus] = useState<0 | 1>(0); // 포커스 그룹 — 새 탭·크럼 강조·desk 뷰 대상
  const [status, setStatus] = useState<Record<string, DeskTurnStatus>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [picking, setPicking] = useState(false); // 보관함 피커(Popover) 열림
  const [editingKey, setEditingKey] = useState<string | null>(null); // 탭/브레드크럼 인라인 이름편집
  const [dragTab, setDragTab] = useState<string | null>(null); // 드래그 중인 탭(반투명 표시)

  // desk 전용 우측 뷰 split.
  const [showView, setShowView] = useState<boolean>(() => { try { return localStorage.getItem(VIEW_KEY) !== "0"; } catch { return true; } });
  const [viewPct, setViewPct] = useState<number>(() => { try { const v = parseFloat(localStorage.getItem(VIEW_PCT_KEY) || ""); return v >= 20 && v <= 80 ? v : 46; } catch { return 46; } });
  const [dragging, setDragging] = useState<"" | "view" | "split">("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null); // 채팅 열(헤드+크럼+panes) — splitPct 의 기준 폭

  const active0Ref = useRef(active0);
  active0Ref.current = active0;
  const active1Ref = useRef(active1);
  active1Ref.current = active1;
  const g2Ref = useRef(g2Keys);
  g2Ref.current = g2Keys;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const dragKeyRef = useRef<string | null>(null); // 탭 DnD 원본(state 는 표시용, ref 가 정본)
  // 지금 보고 있는 페이지의 슬롯(도킹만 — /desk 는 페이지가 없어 null 유지). openReq 의
  // preview 요청이 갱신하며, "+ 새 대화"·칩 피커가 대상의 정본으로 읽는다.
  const pageSlotRef = useRef<Slot | null>(null);
  // 페이지가 선언한 작업 대상 전체(<AgentScope targets>) — "대상 추가" 후보의 정본.
  // 대화 이력 열거는 "가 본 곳"만 알지만 이건 "갈 수 있는 곳"을 안다.
  const pageTargetsRef = useRef<string[]>([]);
  const tabsRef = useRef(tabs); // reportStatus 가 stale 없이 현재 탭 제목을 읽게
  tabsRef.current = tabs;
  const prevStatus = useRef<Record<string, DeskTurnStatus>>({});
  const editRef = useRef<HTMLInputElement>(null);
  const cancelEditRef = useRef(false); // Escape 취소 → onBlur 가 저장하지 않게
  const hadTabsRef = useRef(tabs.length > 0); // 처음부터 빈 것과 닫아서 빈 것을 구분(도킹 즉시닫힘 방지)

  const g2set = useMemo(() => new Set(g2Keys), [g2Keys]);
  const group0 = useMemo(() => tabs.filter((t) => !g2set.has(t.key)), [tabs, g2set]);
  const group1 = useMemo(
    () => g2Keys.map((k) => tabs.find((t) => t.key === k)).filter(Boolean) as Tab[],
    [g2Keys, tabs],
  );
  const split = group1.length > 0;

  useEffect(() => { try { localStorage.setItem(tabsKey(variant), JSON.stringify(persistableTabs(tabs))); } catch { /* quota */ } }, [tabs, variant]);
  useEffect(() => { try { localStorage.setItem(activeStorageKey(variant), active0); } catch { /* quota */ } }, [active0, variant]);
  useEffect(() => { if (variant === "desk") try { localStorage.setItem(VIEW_KEY, showView ? "1" : "0"); } catch { /* quota */ } }, [showView, variant]);
  useEffect(() => { if (variant === "desk") try { localStorage.setItem(VIEW_PCT_KEY, String(viewPct)); } catch { /* quota */ } }, [viewPct, variant]);
  useEffect(() => {
    try {
      if (g2Keys.length) localStorage.setItem(splitStorageKey(variant), JSON.stringify({ keys: g2Keys, active: active1, pct: splitPct }));
      else localStorage.removeItem(splitStorageKey(variant));
    } catch { /* quota */ }
  }, [g2Keys, active1, splitPct, variant]);
  useEffect(() => { if (editingKey) editRef.current?.select(); }, [editingKey]);

  // 지연 민팅 재바인딩 — 드래프트 좌표의 탭이 session.create 발급 id 를 받으면 탭 기록의
  // conversationId 만 갈아끼운다(key 유지 → pane 무재마운트, 매핑은 runtime 이 번역). 영속은
  // 발급 id 로 남아 새로고침 뒤에도 그 대화가 열린다. 페이지 슬롯 좌표도 같이 따라간다.
  // 재바인딩 결과 같은 세션을 든 탭이 둘 이상이면 하나로 합친다 — 바인딩 seed 드래프트 여러 개가
  // 같은 기존 세션을 이어받으면(resolveBoundSeed) 좌표가 같은 탭이 겹쳐 쌓이고, 새로고침 뒤
  // key 가 충돌해 pane 이 전부 나란히 보였다. 먼저 있던 탭이 남고 활성·그룹은 그리로 옮긴다.
  useEffect(() => onSessionMinted(({ conversation, session }) => {
    const cur = tabsRef.current;
    if (!cur.some((t) => t.conversationId === conversation)) return;
    const rebound = cur.map((t) => (t.conversationId === conversation ? { ...t, conversationId: session } : t));
    const survivor = new Map<string, string>(); // 좌표 → 남는 탭 key
    const dropped = new Map<string, string>();  // 사라지는 탭 key → 남는 탭 key
    const merged = rebound.filter((t) => {
      const coord = keyOf(t.instanceId, t.conversationId);
      const s = survivor.get(coord);
      if (s) { dropped.set(t.key, s); return false; }
      survivor.set(coord, t.key);
      return true;
    });
    setTabs(merged);
    if (dropped.size) {
      const a0 = dropped.get(active0Ref.current); if (a0) setActive0(a0);
      const a1 = dropped.get(active1Ref.current); if (a1) setActive1(a1);
      setG2((prev) => prev.filter((k) => !dropped.has(k)));
    }
    const slot = pageSlotRef.current;
    if (slot && slot.conversationId === conversation) pageSlotRef.current = { ...slot, conversationId: session };
  }), []);

  // 닫힌 탭이 그룹1 명단에 남지 않게 상시 정리(복원 키가 낡은 경우 포함).
  useEffect(() => {
    const valid = new Set(tabs.map((t) => t.key));
    if (g2Keys.some((k) => !valid.has(k))) setG2(g2Keys.filter((k) => valid.has(k)));
  }, [tabs, g2Keys]);

  // 활성/그룹 정합 — 탭이 없거나 활성 키가 사라졌으면 그룹 첫 탭으로. 좌측 그룹이 비면 우측이
  // 전체를 인수(분할 해제), 우측이 비면 분할 해제 + 포커스 좌측 복귀. 탭을 "닫아서" 전부 비면
  // onAllClosed(도킹=패널 닫힘). 처음부터 빈 상태는 유지하고 빈 상태 UI 를 보여준다.
  useEffect(() => {
    if (tabs.length === 0) {
      if (active0) setActive0("");
      if (active1) setActive1("");
      if (hadTabsRef.current) onAllClosed?.();
      return;
    }
    hadTabsRef.current = true;
    if (group0.length === 0) { if (g2Keys.length) setG2([]); return; } // 우측이 전체 인수 — 다음 패스에서 정합
    if (!group0.some((t) => t.key === active0)) setActive0(group0[0].key);
    if (g2Keys.length) {
      if (!g2Keys.includes(active1)) setActive1(g2Keys[0]);
    } else if (focus === 1) setFocus(0);
  }, [tabs, group0, g2Keys, active0, active1, focus, onAllClosed]);

  const setTabTitle = useCallback((key: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, title } : t)));
  }, []);

  /** 미리보기 → 고정. 사람이 그 대화에 관여한 순간(첫 발화·이름변경·드래그) 탭은 사용자의
   *  것이 되고, 이후 페이지 이동이 그 자리를 회수하지 못한다. */
  const promote = useCallback((key: string) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.key === key);
      if (i < 0 || !prev[i].preview) return prev;
      const next = prev.slice();
      next[i] = { ...next[i], preview: false };
      return next;
    });
  }, []);

  /** 탭 부산물(뱃지·안읽음·직전 상태) 청소 — 닫기와 미리보기 자리 교체가 공유한다. */
  const forgetTab = useCallback((key: string) => {
    setStatus((prev) => { const { [key]: _d, ...rest } = prev; return rest; });
    setUnread((prev) => { const { [key]: _d, ...rest } = prev; return rest; });
    delete prevStatus.current[key];
  }, []);

  // 자동 대화 제목 pop-in — 첫 턴 완료 후 백엔드(session.maybeAutoTitle)가 Haiku 로 제목을 굽는다
  // (fire-and-forget, append 뒤 몇 초). idle 전이 직후엔 아직 비어 있을 수 있어 짧게 폴링하다 뜨면
  // 탭 라벨에 반영. 수동 rename(진짜 제목)이 이미 있으면 백엔드도 폴링도 skip.
  const refreshTabTitle = useCallback((instanceId: string, conversationId: string, key: string) => {
    let tries = 0;
    const tick = () => {
      void loadConversationTitle(instanceId, conversationId, principal)
        .then((title) => {
          if (title) setTabTitle(key, title);
          else if (++tries < 4) window.setTimeout(tick, 1500);
        })
        .catch(() => { /* best-effort */ });
    };
    window.setTimeout(tick, 1200);
  }, [principal, setTabTitle]);

  const reportStatus = useCallback((key: string, s: DeskTurnStatus) => {
    const was = prevStatus.current[key];
    prevStatus.current[key] = s;
    setStatus((prev) => (prev[key] === s ? prev : { ...prev, [key]: s }));
    // 대화가 실제로 시작됐다 — 미리보기였다면 여기서 고정된다(첫 발화·에이전트 응답 양쪽).
    if (s === "running" || s === "ask") promote(key);
    if ((was === "running" || was === "ask") && s === "idle") {
      // 화면에 떠 있는 pane(각 그룹의 활성 탭)은 unread 뱃지 대상이 아니다.
      const visible = active0Ref.current === key || (g2Ref.current.length > 0 && active1Ref.current === key);
      if (!visible) setUnread((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
      // 아직 자동제목 전(placeholder 라벨)인 탭이면 백엔드 제목을 당겨 라벨 갱신.
      const tab = tabsRef.current.find((t) => t.key === key);
      if (tab && isPlaceholderTitle(tab.title)) refreshTabTitle(tab.instanceId, tab.conversationId, key);
    }
  }, [refreshTabTitle, promote]);

  const giOf = useCallback((key: string): 0 | 1 => (g2Ref.current.includes(key) ? 1 : 0), []);

  const activate = useCallback((gi: 0 | 1, key: string) => {
    if (gi === 1) setActive1(key); else setActive0(key);
    setFocus(gi);
    setUnread((prev) => (prev[key] ? { ...prev, [key]: false } : prev));
  }, []);

  // 새 탭은 포커스 그룹에 착지. 이미 있는 탭이면 실제 소속 그룹에서 활성화만.
  // 미리보기 요청(t.preview)은 **직전 미리보기 자리를 갈아끼운다** — 페이지를 순회해도 탭이
  // 하나만 오간다. 반대로 고정 요청이 미리보기 탭을 가리키면 그 탭을 승격시킨다(보관함에서
  // 같은 대화를 고르는 등 = 사람의 선택).
  const addTab = useCallback((t: Tab) => {
    const cur = tabsRef.current;
    const exists = cur.some((x) => x.key === t.key);
    const gi: 0 | 1 = exists
      ? (g2Ref.current.includes(t.key) ? 1 : 0)
      : (focusRef.current === 1 && g2Ref.current.length > 0 ? 1 : 0);
    const stale = t.preview && !exists ? cur.find((x) => x.preview && x.key !== t.key) : undefined;
    setTabs((prev) => nextTabs(prev, t));
    if (stale) forgetTab(stale.key);
    if (!exists && gi === 1) setG2((prev) => (prev.includes(t.key) ? prev : [...prev, t.key]));
    activate(gi, t.key);
  }, [activate, forgetTab]);

  // 칩 피커의 "대상 고치기" — 빈 대화는 제자리에서 좌표만 갈아끼우고(무손실), 말이 오간 대화는
  // 그대로 둔 채 그 좌표의 대화를 연다. 제자리 교체는 탭 key 가 바뀌므로 활성·그룹·뱃지도 함께
  // 옮긴다(미리보기 여부는 유지 — 고쳐진 빈 대화는 여전히 미리보기다).
  const retarget = useCallback((fromKey: string, conversationId: string, inPlace: boolean) => {
    const src = tabsRef.current.find((t) => t.key === fromKey);
    if (!src || !conversationId) return;
    const nextKey = keyOf(src.instanceId, conversationId);
    if (nextKey === fromKey) return;
    if (!inPlace) {
      addTab({ key: nextKey, instanceId: src.instanceId, conversationId, title: "" });
      return;
    }
    const dup = tabsRef.current.some((t) => t.key === nextKey);
    const gi: 0 | 1 = (dup ? g2Ref.current.includes(nextKey) : g2Ref.current.includes(fromKey)) ? 1 : 0;
    setTabs((prev) => retargetTabs(prev, fromKey, conversationId));
    setG2((prev) => (prev.includes(fromKey)
      ? (dup ? prev.filter((k) => k !== fromKey) : prev.map((k) => (k === fromKey ? nextKey : k)))
      : prev));
    forgetTab(fromKey);
    activate(gi, nextKey);
  }, [addTab, forgetTab, activate]);

  // 열기 요청의 착지 — 대화 지정 요청은 **스레드 패밀리** 단위로(같은 (인스턴스 × 패밀리) 탭이
  // 이미 있으면 활성화; 요청 id 는 seed("main"·"agent-x")로 오는데 열어 둔 건 sibling 일 수
  // 있다), 대화 미지정 요청은 **인스턴스** 단위로 수렴한다 — 세션 id 가 기판 발급 불투명
  // 문자열이 된 뒤(§5.3-22) 미지정 열기가 좌표를 지어낼 수 없기 때문이다: 그 인스턴스의 열린
  // 탭이 있으면 그걸, 없으면 seedConversation(마지막 민팅 세션 > 지연 민팅 드래프트)으로 새 탭.
  const openReq = useCallback((r: OpenReq) => {
    const focusedActive = focusRef.current === 1 ? active1Ref.current : active0Ref.current;
    const cur = tabsRef.current.find((t) => t.key === focusedActive);
    let hit: Tab | undefined;
    let conv: string;
    if (r.conversationId) {
      conv = r.conversationId;
      const fam = threadFamily(conv);
      const sameFamily = (t: Tab) => t.instanceId === r.instanceId && threadFamily(t.conversationId) === fam;
      hit = cur && sameFamily(cur) ? cur : tabsRef.current.find(sameFamily);
    } else {
      const sameInstance = (t: Tab) => t.instanceId === r.instanceId;
      hit = cur && sameInstance(cur) ? cur : tabsRef.current.find(sameInstance);
      conv = hit ? hit.conversationId : seedConversation(r.instanceId);
    }
    // preview 요청 = 페이지가 "이 화면의 대화는 이것" 이라고 알려 온 것. 탭을 새로 열든 이미
    // 있어 활성화만 하든 좌표는 남겨 둔다 — "+ 새 대화"·칩 피커가 참조하는 페이지 정본이다
    // (mountTabs initial 은 패널 열릴 때 1회 캡처라 SPA 이동을 못 따라간다).
    if (r.preview) {
      pageSlotRef.current = { instanceId: r.instanceId, conversationId: conv };
      pageTargetsRef.current = r.targets || [];
    }
    if (hit) {
      if (!r.preview) promote(hit.key); // 사람이 고른 열기 = 미리보기였다면 고정
      activate(giOf(hit.key), hit.key);
      return;
    }
    addTab({ key: keyOf(r.instanceId, conv), instanceId: r.instanceId, conversationId: conv, title: r.title || "", preview: r.preview });
  }, [addTab, activate, giOf, promote]);

  const paneTargetOf = useCallback((key: string): PaneTarget => ({
    getPageSlot: () => pageSlotRef.current,
    getPageTargets: () => pageTargetsRef.current,
    retarget: (conv, inPlace) => retarget(key, conv, inPlace),
    // 인스턴스 축은 대화 좌표의 바깥 — 대화 미지정 열기로 그 인스턴스에 수렴한다(열린 탭이
    // 있으면 활성화, 없으면 seedConversation 좌표의 새 탭). "main" 로컬 좌표 발급은 은퇴.
    openInstance: (instanceId) => openReq({ instanceId }),
  }), [retarget, openReq]);

  // 도킹 openTab 핸들 등록 — 패널이 닫혀 있다 열릴 때 마운트 후 이 핸들로 대상 탭을 연다.
  useEffect(() => {
    registerHandle?.({ openTab: openReq });
    return () => registerHandle?.(null);
  }, [registerHandle, openReq]);

  // 페이지의 슬롯(뷰의 <AgentScope> 선언, 없으면 상위 = 인스턴스 front "main" → mountTabs
  // initial)은 **저장된 탭이 있어도** 열고 활성화한다. 위 시드(useState)는 "저장된 탭이 있으면
  // 그것"이라 슬롯을 통째로 버렸고, 그러면 대화가 마지막에 쓰던 탭 — 직전 세션의 다른 에이전트 —
  // 에서 시작됐다(페이지가 곧 대화라는 계약 파기). openReq 은 패밀리 단위 멱등이라 이미 그
  // 대화를 보고 있으면 아무 일도 일어나지 않는다. (desk 는 initial 이 없어 종전대로 복원만.)
  const declared = useMemo<OpenReq | null>(
    () =>
      initial?.instanceId && initial.conversationId
        ? { instanceId: initial.instanceId, conversationId: initial.conversationId, preview: true }
        : null,
    [initial?.instanceId, initial?.conversationId],
  );
  useEffect(() => { if (declared) openReq(declared); }, [declared, openReq]);

  const closeTab = useCallback((key: string) => {
    const g2 = g2Ref.current;
    if (g2.includes(key)) {
      // 우측 그룹 — 이웃 승계(뒤에서 닫으면 앞 탭). 마지막 탭이면 정합 effect 가 분할 해제.
      const rest = g2.filter((k) => k !== key);
      if (active1Ref.current === key && rest.length)
        setActive1(rest[Math.max(0, g2.indexOf(key) - 1)]);
      setG2(rest);
    } else {
      const g0 = tabsRef.current.filter((t) => !g2.includes(t.key));
      const idx = g0.findIndex((t) => t.key === key);
      const rest = g0.filter((t) => t.key !== key);
      if (active0Ref.current === key && rest.length)
        setActive0(rest[Math.max(0, idx - 1)].key);
    }
    setTabs((prev) => prev.filter((t) => t.key !== key));
    forgetTab(key);
  }, [forgetTab]);

  // ── 컨텍스트 메뉴 액션(VSCode 탭 메뉴 대응 — 닫기류는 그 탭의 그룹 안에서만) ──────────
  const closeMany = useCallback((keys: string[]) => {
    if (!keys.length) return;
    const gone = new Set(keys);
    setTabs((prev) => prev.filter((t) => !gone.has(t.key))); // 활성 승계는 정합 effect 소관
    setG2((prev) => prev.filter((k) => !gone.has(k)));
    const strip = <T,>(m: Record<string, T>) => {
      const rest = { ...m };
      for (const k of keys) delete rest[k];
      return rest;
    };
    setStatus(strip);
    setUnread(strip);
    for (const k of keys) delete prevStatus.current[k];
  }, []);
  const groupTabsOf = useCallback((key: string): Tab[] => {
    const g2 = g2Ref.current;
    return g2.includes(key)
      ? (g2.map((k) => tabsRef.current.find((t) => t.key === k)).filter(Boolean) as Tab[])
      : tabsRef.current.filter((t) => !g2.includes(t.key));
  }, []);
  const closeOthers = useCallback((key: string) => {
    closeMany(groupTabsOf(key).filter((t) => t.key !== key).map((t) => t.key));
    activate(giOf(key), key);
  }, [closeMany, groupTabsOf, activate, giOf]);
  const closeToRight = useCallback((key: string) => {
    const g = groupTabsOf(key);
    const idx = g.findIndex((t) => t.key === key);
    if (idx < 0) return;
    closeMany(g.slice(idx + 1).map((t) => t.key));
  }, [closeMany, groupTabsOf]);

  // 그룹 이동(분할 생성 포함) — gi=1 이면 우측으로(없던 분할이면 생성), gi=0 이면 좌측으로.
  // 옮긴 탭은 대상 그룹에서 활성화. 원 그룹의 활성 승계는 정합 effect 가 처리.
  const moveToGroup = useCallback((key: string, gi: 0 | 1) => {
    promote(key); // 배치를 손댔다 = 사람의 대화(다음 페이지 이동이 자리를 회수하지 못하게)
    if (gi === 1) {
      setG2((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setActive1(key);
      setFocus(1);
      if (active0Ref.current === key) {
        const next = tabsRef.current.find((t) => t.key !== key && !g2Ref.current.includes(t.key));
        if (next) setActive0(next.key);
      }
    } else {
      setG2((prev) => prev.filter((k) => k !== key));
      setActive0(key);
      setFocus(0);
    }
  }, [promote]);
  // 분할 해제 — 우측 그룹 탭들을 좌측 끝에 순서대로 합류(평면 배열도 그 순서로 재배열).
  const unsplit = useCallback(() => {
    const g2 = g2Ref.current;
    if (!g2.length) return;
    setTabs((prev) => {
      const inG2 = new Set(g2);
      const right = g2.map((k) => prev.find((t) => t.key === k)).filter(Boolean) as Tab[];
      return [...prev.filter((t) => !inG2.has(t.key)), ...right];
    });
    setG2([]);
    setFocus(0);
  }, []);

  // ── 탭 드래그 — 같은 그룹 안 순서 이동 + 그룹 간 이동(dragover 시점 즉시 반영, VSCode 식).
  //    파일 드롭(dataTransfer.types=Files)은 컴포저 소관이라 여기 안 걸린다(dragKeyRef 가드).
  const onTabDragStart = useCallback((e: React.DragEvent, key: string) => {
    dragKeyRef.current = key;
    setDragTab(key);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", key); } catch { /* 일부 브라우저 */ }
  }, []);
  const onTabDragOver = useCallback((e: React.DragEvent, overKey: string) => {
    const from = dragKeyRef.current;
    if (!from) return; // 외부 드래그(파일 등)는 무시
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (from === overKey) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    if (g2Ref.current.includes(overKey)) {
      // 대상이 우측 그룹 — g2Keys 안에서 (필요시 편입 후) 재배열.
      setG2((prev) => {
        const without = prev.filter((k) => k !== from);
        let at = without.indexOf(overKey);
        if (at < 0) return prev;
        if (!before) at += 1;
        const next = without.slice();
        next.splice(at, 0, from);
        return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next;
      });
    } else {
      // 대상이 좌측 그룹 — 우측 소속이었으면 해제하고 평면 배열에서 재배열.
      if (g2Ref.current.includes(from)) setG2((prev) => prev.filter((k) => k !== from));
      setTabs((prev) => {
        const fi = prev.findIndex((t) => t.key === from);
        if (fi < 0 || !prev.some((t) => t.key === overKey)) return prev;
        const next = prev.slice();
        const [moved] = next.splice(fi, 1);
        let at = next.findIndex((t) => t.key === overKey);
        if (!before) at += 1;
        next.splice(at, 0, moved);
        return next.every((t, i) => t.key === prev[i].key) ? prev : next; // 무변화 = 재렌더 억제
      });
    }
  }, []);
  // 스트립의 빈 공간 위 — 그 그룹 끝으로 이동(다른 그룹 스트립으로 끌어오기의 기본 동선).
  const onStripDragOver = useCallback((e: React.DragEvent, gi: 0 | 1) => {
    if ((e.target as HTMLElement).closest?.(".rc-desk-tab")) return; // 탭 위는 탭 핸들러 소관
    const from = dragKeyRef.current;
    if (!from) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const inG1 = g2Ref.current.includes(from);
    if (gi === 1) {
      if (!inG1 || g2Ref.current[g2Ref.current.length - 1] !== from)
        setG2((prev) => [...prev.filter((k) => k !== from), from]);
    } else {
      if (inG1) setG2((prev) => prev.filter((k) => k !== from));
      setTabs((prev) => {
        const fi = prev.findIndex((t) => t.key === from);
        if (fi < 0 || fi === prev.length - 1) return prev;
        const next = prev.slice();
        const [moved] = next.splice(fi, 1);
        next.push(moved);
        return next;
      });
    }
  }, []);
  // 드롭/취소 — 옮겨진 탭은 최종 소속 그룹에서 활성화(VSCode 도 드롭한 탭이 포커스를 가진다).
  const onTabDragEnd = useCallback(() => {
    const k = dragKeyRef.current;
    dragKeyRef.current = null;
    setDragTab(null);
    if (k && tabsRef.current.some((t) => t.key === k)) {
      promote(k); // 손으로 옮긴 탭 = 사람의 대화
      activate(g2Ref.current.includes(k) ? 1 : 0, k);
    }
  }, [activate, promote]);

  const ctxOf = (t: Tab): RelayCtx => ({ instanceId: t.instanceId, principal, conversationId: t.conversationId, title: t.title });

  // 보관함 rename/삭제가 열린 탭에 반영되게 동기화.
  const onInboxMutated = useCallback((instanceId: string, conversationId: string, title: string | null) => {
    const key = keyOf(instanceId, conversationId);
    if (title === null) closeTab(key);
    else setTabTitle(key, title);
  }, [closeTab, setTabTitle]);

  // 새 대화는 **지금 보고 있는 페이지의 슬롯**에서 갈라진다(인스턴스·에이전트 두 축 같은 기준).
  // 페이지가 없는 셸(/desk)에서만 보던 탭이 기준이다. 다른 인스턴스를 직접 열고 싶을 땐
  // 보관함(📥) 피커를 쓴다.
  const newConversation = useCallback(() => {
    const flat = tabsRef.current;
    const focusedActive = focusRef.current === 1 ? active1Ref.current : active0Ref.current;
    const activeTab = flat.find((t) => t.key === focusedActive) || flat[0] || null;
    const target = newConversationTarget(pageSlotRef.current, activeTab);
    if (!target) { // 열 대상 인스턴스가 없으면 보관함 피커로 유도
      setPicking(true);
      return;
    }
    // 로컬 드래프트 좌표(빈 로컬 상태) — 서버 세션은 첫 발화 직전 session.create 가 민팅한다.
    const t: Tab = { key: keyOf(target.instanceId, target.conversationId), ...target, title: "새 대화" };
    addTab(t);
  }, [addTab]);

  const commitRename = useCallback((t: Tab, value: string) => {
    const v = value.trim();
    setEditingKey(null);
    if (!v) return;
    setTabTitle(t.key, v);
    promote(t.key); // 이름을 붙였다 = 사람의 대화
    void renameConversation(ctxOf(t), t.conversationId, v);
  }, [setTabTitle, promote, principal]);

  // 스플리터 드래그 — view(desk 우측 뷰 폭)·split(채팅 분할 경계) 둘 다 여기서 처리.
  // iframe pointer-events 는 CSS(.dragging)로 끈다.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const host = dragging === "view" ? bodyRef.current : chatRef.current;
      const rect = host?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      if (dragging === "view") setViewPct(Math.max(20, Math.min(80, ((rect.right - e.clientX) / rect.width) * 100)));
      else setSplitPct(Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100)));
    };
    const onUp = () => setDragging("");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging]);

  const existing = useMemo(() => new Set(tabs.map((t) => t.key)), [tabs]);
  const activeTab0 = group0.find((t) => t.key === active0) || null;
  const activeTab1 = split ? group1.find((t) => t.key === active1) || null : null;
  const viewTab = (focus === 1 && activeTab1) || activeTab0; // desk 뷰 iframe 대상 = 포커스 그룹 활성
  // 뷰 주소는 호스트 주입(viewFor)만 — 클라이언트가 /i/<id> 마운트 문법을 조립하면 계약
  // 위반이다(§2-6). 미주입이면 뷰 토글·패널 자체를 그리지 않는다.
  const viewSrc = variant === "desk" && viewTab ? viewUrlForInstance(viewTab.instanceId) : null;

  const badgeOf = (t: Tab): { cls: string; text: string } | null => {
    const s = status[t.key] || "idle";
    if (s === "ask") return { cls: "ask", text: "❓" };
    // 실행 중은 탭이 알릴 일이 아니다(들어가 보면 안다). 알릴 것은 "안 본 결과"뿐 — 정지된 점 하나.
    if (unread[t.key]) return { cls: "unread", text: "" };
    return null;
  };

  const renameInput = (t: Tab, cls: string) => (
    // cls: "rc-tab-rename"(탭 텍스트 자리) | "rc-crumb-rename"(크럼 행 전체) — 자리별 폭·글자만 다르다.
    <Input ref={editRef}
           className={cn("border-[var(--rc-accent)] text-[var(--rc-ink)]",
             cls === "rc-tab-rename"
               ? "h-6 w-auto min-w-20 max-w-40 rounded-[5px] px-[5px] text-[12.5px] md:text-[12.5px]"
               : "h-7 flex-1 rounded-md px-[7px] text-[13px] font-semibold md:text-[13px]")}
           defaultValue={t.title && !isPlaceholderTitle(t.title) ? t.title : ""}
           placeholder={labelOf(t)} maxLength={120}
           onClick={(e) => e.stopPropagation()}
           onDoubleClick={(e) => e.stopPropagation()}
           onBlur={(e) => { if (cancelEditRef.current) { cancelEditRef.current = false; setEditingKey(null); return; } commitRename(t, e.currentTarget.value); }}
           onKeyDown={(e) => {
             if (e.key === "Enter") { e.preventDefault(); commitRename(t, (e.target as HTMLInputElement).value); }
             if (e.key === "Escape") { e.preventDefault(); cancelEditRef.current = true; setEditingKey(null); }
           }} />
  );

  // 좌측 그룹 폭 — 분할 시 스플리터(6px)의 절반을 좌측이 부담해 헤드/크럼/pane 3행이 픽셀 정렬.
  const leftBasis = `0 0 calc(${splitPct}% - 3px)`;

  // 탭 우클릭 메뉴 항목 — 그 탭이 선 그룹 기준(다른 탭·오른쪽 탭은 같은 그룹 안), 분할 여부로 하단이 갈린다.
  const menuItemsOf = (key: string): TabMenuItem[] => {
    const inG1 = g2set.has(key);
    const gtabs = inG1 ? group1 : group0;
    const idx = gtabs.findIndex((t) => t.key === key);
    if (idx < 0) return [];
    return [
      { label: "닫기", run: () => closeTab(key) },
      { label: "다른 탭 닫기", run: () => closeOthers(key), disabled: gtabs.length < 2 },
      { label: "오른쪽 탭 닫기", run: () => closeToRight(key), disabled: idx === gtabs.length - 1 },
      "sep",
      ...(split
        ? ([
            inG1
              ? { label: "왼쪽 그룹으로 이동", run: () => moveToGroup(key, 0) }
              : { label: "오른쪽 그룹으로 이동", run: () => moveToGroup(key, 1) },
            { label: "분할 해제", run: unsplit },
          ] as TabMenuItem[])
        : ([{
            label: "오른쪽으로 분할", run: () => moveToGroup(key, 1), disabled: tabs.length < 2,
            // disabled 만으로는 "왜 안 되는지"가 안 보인다 — hover 툴팁으로 조건을 말해준다.
            title: tabs.length < 2 ? "대화 탭이 두 개 이상 열려 있어야 나눌 수 있어요" : undefined,
          }] as TabMenuItem[])),
    ];
  };

  const stripFor = (gi: 0 | 1) => {
    const g = gi === 0 ? group0 : group1;
    return (
      <TabStrip
        tabs={g}
        activeKey={gi === 0 ? active0 : active1}
        focused={!split || focus === gi}
        editingKey={editingKey}
        dragTab={dragTab}
        style={gi === 0 ? (split ? { flex: leftBasis } : { flex: "1 1 auto", minWidth: 0 }) : { flex: "1 1 0" }}
        badgeOf={badgeOf}
        renderRename={renameInput}
        onActivate={(key) => activate(gi, key)}
        onClose={closeTab}
        menuItemsOf={menuItemsOf}
        onEditStart={setEditingKey}
        onTabDragStart={onTabDragStart}
        onTabDragOver={onTabDragOver}
        onTabDragEnd={onTabDragEnd}
        onStripDragOver={(e) => onStripDragOver(e, gi)}
        onFocusGroup={() => { if (split && focusRef.current !== gi) setFocus(gi); }}
      />
    );
  };

  // 보관함 피커 — 트리거만 자리마다 다르다(바 아이콘 · 빈 화면 큰 버튼). 열림 상태는 picking 하나.
  const picker = (trigger: ReactElement) => (
    <InboxPicker principal={principal} existing={existing} open={picking} onOpenChange={setPicking}
                 trigger={trigger} onOpen={addTab} onMutated={onInboxMutated} />
  );

  const actions = (
    <div className="rc-tabs-actions">
      {picker(
        <Button type="button" variant="ghost" size="icon-sm" className={BAR_BTN} aria-label="대화 목록" title="대화 목록 · 모든 에이전트의 대화">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 6h14l2 7v5a1 1 0 01-1 1H4a1 1 0 01-1-1v-5z" />
          </svg>
        </Button>,
      )}
      <Button type="button" variant="ghost" size="icon-sm" className={cn(BAR_BTN, "text-[var(--rc-accent-strong)]")} aria-label="새 대화" title="새 대화 열기" onClick={newConversation}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
      {variant === "desk" && viewTab && viewSrc && (
        // rc-desk-viewtoggle 유지 — 휴대폰 폭 숨김(@media) 과 .on 강조색은 chat.css 소유.
        <Button type="button" variant="ghost" size="xs" className={cn(BAR_BTN, "rc-desk-viewtoggle gap-[5px] px-3 text-[11.5px] font-semibold text-[var(--rc-faint)]", showView && "on")}
                aria-pressed={showView} title="에이전트 화면을 오른쪽에 보기" onClick={() => setShowView((v) => !v)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M13 4v16" />
          </svg>
          <span>화면</span>
        </Button>
      )}
      {variant === "dock" && onCollapse && (
        <Button type="button" variant="ghost" size="icon-sm" className={BAR_BTN} aria-label="채팅 패널 접기" title="패널 접기(탭은 유지)" onClick={onCollapse}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M13 5l7 7-7 7M4 5l7 7-7 7" />
          </svg>
        </Button>
      )}
    </div>
  );

  const crumbCell = (t: Tab, editKey: string, style?: CSSProperties) => (
    <div className="rc-tabs-crumb" style={style}>
      {editingKey === editKey
        ? renameInput(t, "rc-crumb-rename")
        : <span className="rc-tabs-crumb-name" title="더블클릭해서 이름 바꾸기"
                onDoubleClick={() => setEditingKey(editKey)}>{labelOf(t)}</span>}
    </div>
  );

  return (
    <div className={"rc-ws rc-tabs rc-tabs-" + variant + (split ? " rc-tabs-split" : "")}>
      {tabs.length === 0 ? (
        <>
          <div className="rc-desk-tabs">
            <div className="rc-tab-ghead" style={{ flex: "1 1 auto" }} />
            {actions}
          </div>
          <div className="rc-desk-empty">
            <div className="rc-empty-ic" aria-hidden>✦</div>
            <div className="rc-empty-t">에이전트를 열어 시작하세요</div>
            {picker(
              <Button type="button" variant="outline" className="font-semibold text-[var(--rc-accent-strong)] hover:border-[var(--rc-accent)] hover:bg-[var(--rc-accent-soft)]">
                대화 목록에서 열기
              </Button>,
            )}
          </div>
        </>
      ) : (
        <div className={"rc-desk-body" + (dragging ? " dragging" : "")} ref={bodyRef}>
          <div className="rc-chat-area" ref={chatRef}>
            {/* row1 — 그룹별 탭 스트립 + 우측 고정 액션. 분할 시 두 스트립이 splitPct 로 나뉜다. */}
            <div className="rc-desk-tabs">
              {stripFor(0)}
              {split && <div className="rc-ghead-gap" aria-hidden />}
              {split && stripFor(1)}
              {actions}
            </div>
            {/* row2 — 그룹별 활성 대화 이름 브레드크럼(더블클릭 rename, "칩 자리" 이름 유지).
                dock 에서는 두지 않는다 — 탭 줄이 이미 이름을 보여주고(더블클릭 rename 도 탭에서
                된다), 패키지 화면의 탑바 밑에 머리가 두 줄이면 무겁다. desk 는 그대로 */}
            {variant !== "dock" && (activeTab0 || activeTab1) && (
              <div className="rc-tabs-crumbs">
                {activeTab0 && crumbCell(activeTab0, "crumb0", split ? { flex: leftBasis } : undefined)}
                {split && <div className="rc-ghead-gap" aria-hidden />}
                {split && activeTab1 && crumbCell(activeTab1, "crumb1", { flex: "1 1 0" })}
              </div>
            )}
            {/* row3 — pane 은 그룹 트리에 중첩하지 않고 평면 유지(keep-alive). 보이는 pane 만
                flex 폭을 갖고, 분할 스플리터는 order 로 두 pane 사이에 낀다. */}
            <div className="rc-desk-panes">
              {tabs.map((t) => {
                const gi: 0 | 1 = g2set.has(t.key) ? 1 : 0;
                const visible = gi === 0 ? t.key === active0 : t.key === active1;
                const style: CSSProperties = { display: visible ? "flex" : "none", order: gi === 1 ? 3 : 1 };
                if (visible && split) style.flex = gi === 0 ? leftBasis : "1 1 0";
                return (
                  <div key={t.key} className="rc-desk-pane" style={style}
                       onMouseDownCapture={() => { if (split && focusRef.current !== gi) setFocus(gi); }}>
                    {/* OpenConversationCtx — pane 내부(@멘션 라우팅)가 바인딩 대화를 "새 탭"으로
                        연다. openReq 는 패밀리 단위로 기존 탭에 수렴하므로 부적합(새 대화의
                        큐가 영영 드레인 안 됨) — addTab 직행으로 반드시 그 대화의 탭을 만든다. */}
                    <OpenConversationCtx.Provider
                      value={(conv) => addTab({ key: keyOf(t.instanceId, conv), instanceId: t.instanceId, conversationId: conv, title: "" })}>
                      <PaneTargetCtx.Provider value={paneTargetOf(t.key)}>
                      <ChatApp
                        ctxOverrides={{ instanceId: t.instanceId, conversationId: t.conversationId, principal, title: t.title }}
                        embedded
                        active={visible && (!split || focus === gi)}
                        onStatus={(s) => reportStatus(t.key, s)}
                      />
                      </PaneTargetCtx.Provider>
                    </OpenConversationCtx.Provider>
                  </div>
                );
              })}
              {split && (
                <div className="rc-desk-resizer" style={{ order: 2 }} role="separator" aria-orientation="vertical"
                     title="드래그해서 좌우 크기 조절" onMouseDown={(e) => { e.preventDefault(); setDragging("split"); }} />
              )}
            </div>
          </div>
          {variant === "desk" && showView && viewTab && viewSrc && (
            <>
              <div className="rc-desk-resizer" role="separator" aria-orientation="vertical"
                   title="드래그해서 좌우 크기 조절" onMouseDown={(e) => { e.preventDefault(); setDragging("view"); }} />
              <div className="rc-desk-view" style={{ flex: `0 0 ${viewPct}%` }}>
                <iframe key={viewTab.key} title={viewTab.title + " 화면"} src={viewSrc} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
