"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { CREATABLES, HARNESS_TEMPLATES, blocked, harnessLabel, type Creatable } from "@/lib/create";
import type { Fact, Row } from "@/lib/describe";
import type { Add, Para, Tok } from "@/lib/describe";
import { agentSub, channelLabel, cronToKorean, engineLabel, facts, sentences, triggerTarget } from "@/lib/describe";
import { SECTIONS, type SectionItem } from "@/lib/sections";
import type { Manifest } from "@/lib/types";

// 패키지 화면의 왼쪽 칸 — 설정 패널. 두 갈래(에이전트 · 설정)에 섹션 카드가 세로로 선다.
// 섹션마다 제목 · 항목 목록 · [＋ 추가]. 항목을 누르면 그 항목의 폼이, ＋ 를 누르면 그 섹션의
// 랜딩(거기서 만든다)이 **이 칸 안에서** 목록을 대신한다(위에 ‹ 돌아가기). 결과면은 가운데 칸이
// 맡는다(PkgPane stage). 종전 Describe(질문-답 줄, 줄 아래로 펼침)를 대신한다 — 좁은 칸에서는
// 줄 아래로 펼치는 것이 자리가 없고, 항목이 접힌 채로 보여야 "무엇이 있나"가 먼저 보인다.
//
// 어휘: 섹션 제목은 사람 말(describe 의 질문과 같은 결), 항목 id 는 lib/sections 의 것(폼의 정본).

type Key = Row["key"];

/** 줄마다 눈이 짚을 작은 아이콘 (16px, currentColor) — 종전 Describe 에서 그대로 */
const ICON: Record<Key, string> = {
  verbs: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
  when: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-15v5l3 2",
  talk: "M21 12a8 8 0 0 1-11.4 7.2L4 21l1.8-5.6A8 8 0 1 1 21 12z",
  dirs: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z",
  links: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  faces: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zm5 16h8",
  missions: "M3 12h5l2 3h4l2-3h5M5 5h14l2 7v7H3v-7l2-7z",
  identity: "M20 12 12 20 2 10V2h8l10 10zM6.5 6.5h.01",
  engine: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2 4h6v6H9z",
  needs: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  host: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  org: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1",
  files: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6",
};

export function Icon({ k }: { k: Key }) {
  return (
    <svg className="ds-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[k]} />
    </svg>
  );
}

const Chevron = () => <span className="ap-chev" aria-hidden="true">›</span>;

/** 밑줄 낱말의 툴팁 — 누르면 무엇이 열리는지. 문장은 짧게 두고 설명은 여기로 */
/** 낱말 알약에 붙는 작은 아이콘 — 섹션 → 아이콘 키. 밑줄 대신 아이콘이 "이게 무엇의 이름인지" 를 말한다 */
const TOK_ICON: Record<string, Key> = {
  surfaces: "faces", triggers: "when", harness: "engine", agents: "talk",
  scripts: "verbs", services: "dirs", edges: "links", missions: "missions",
};

const TOK_HINT: Record<string, string> = {
  surfaces: "사람이 여는 화면과 채널을 고칩니다",
  triggers: "언제 알아서 움직일지 고칩니다",
  harness: "이 에이전트를 돌리는 AI 를 고릅니다",
  agents: "이 에이전트의 성격과 할 일을 고칩니다",
  scripts: "시키면 하는 일들을 봅니다",
  services: "읽고 쓰는 폴더와 프로그램을 고칩니다",
  edges: "다른 앱에서 빌려 쓰는 것을 고칩니다",
  missions: "다른 앱에 빌려주는 일을 고칩니다",
};

/** 항목 목록을 갖는 섹션 — 이 패널이 이미 목록·＋추가·빈 상태를 다 보여주므로 섹션 랜딩(같은 목록을
 *  한 번 더 그리는 화면)으로 가는 문이 없다. 문은 항목과 ＋ 추가 둘뿐. 나머지(기본 정보·엔진·필요한 것
 *  ·브리지 캡·조직·기타 파일)는 섹션 자체가 폼 하나라 제목이 문이다 */
/** 붙일 수 있는 엔진 — 정본은 lib/create 의 HARNESS_SPECS 하나다 */
const ENGINES = HARNESS_TEMPLATES.map((id) => ({ id, label: harnessLabel(id) }));

const LIST_SECS = new Set(["triggers", "scripts", "edges", "services", "surfaces", "missions", "agents"]);

const SETTING_SECS: { k: Key; sec: string; title: string; add?: string }[] = [
  { k: "needs", sec: "requires", title: "필요한 것", add: "실행파일" },
];
/** 고급 — 보통은 비어 있다. 비면 섹션이 아니라 줄 하나로 선다 */
const ADVANCED_SECS: { k: Key; sec: string; title: string; add?: string }[] = [
  { k: "host", sec: "host_methods", title: "기판 기능 허용", add: "기능" },
  { k: "org", sec: "org", title: "조직 설정" },
  { k: "files", sec: "files", title: "기타 파일" },
];

export interface AgentPanelProps {
  m: Manifest;
  files: string[];
  rows: Row[];
  /** 착지 에이전트(대화의 문) 이름 */
  landing: string | null;
  /** 지금 열린 폼 — URL 의 sec · item */
  open: { sec: string | null; item: string | null };
  /** 항목이나 섹션을 펼친다. item=null 이면 섹션 자체의 폼 */
  onOpen: (sec: string, item: string | null) => void;
  onBack: () => void;
  /** 열린 폼 — open 에 맞는 줄 아래로 펼친다(목록은 그대로) */
  children?: React.ReactNode;
  /** 설정 갈래 — 여는 것(돌아가는 판·데이터 폴더). 위험하지 않으므로 위험 구역 밖 */
  links?: React.ReactNode;
  /** 설정 갈래 맨 아래 — 위험 구역(제거) */
  danger?: React.ReactNode;
  /** [＋ 추가] 메뉴에서 종류를 골랐다 — 팔레트가 그 항목의 질문(이름 등)으로 바로 연다 */
  onPick: (c: Creatable) => void;
  /** [＋ 추가] 메뉴의 "말로 만들기" — 오른쪽 빌더 대화에 문장을 미리 채운다 */
  onAsk: (text: string) => void;
  /** 엔진 칩 — 없는 것을 누르면 붙이고, × 는 뺀다. 도는 동안 busy */
  onEngine: (template: string) => void;
  engineBusy?: boolean;
  /** 지금 이 패키지를 돌리는 엔진 — 장부의 값이다(작업 사본과 무관) */
  activeEngine?: string | null;
  /** 설치본에 이미 선 엔진들 — 전환은 돌아가는 버전을 상대로 한다. 사본에만 있는 것은
   *  적용 전까지 고를 수 없다(장부가 그 이름을 모른다) */
  liveEngines?: string[];
  /** 이 엔진으로 돌린다 — 즉시 반영된다(적용을 기다리지 않는다) */
  onActivate?: (name: string) => void;
  /** 줄 옆 실행 상태 — 채널(연결됨·로그인 필요)·서비스(켜짐·꺼짐). null 이면 칩 없음 */
  status?: ItemStatus;
  /** 설치 이름 → 표시 이름. 연결 줄이 "@haemin/offer-workbook" 대신 사람 말을 쓴다 */
  labelOf?: (name: string) => string;
  /** 착지 에이전트의 성격 글 첫 줄 — 누르면 그 글을 고친다 */
  personaLead?: string;
  /** 이 패키지의 동사 이름 — 보조 에이전트가 몇 가지를 쓰는지 세는 데 쓴다(글로브를 편다) */
  scripts?: string[];
}

/** 항목 줄 옆 칩 — on 이면 살아 있다는 뜻(색 없이 글자 무게만 다르다) */
export type ItemStatus = (sec: string, id: string) => { label: string; on?: boolean; title?: string } | null;

/** 섹션마다 [＋ 추가] 가 내놓는 종류 — 팔레트의 레시피를 문법 좌표(yaml)로 고른다 */
function creatablesFor(sec: string): Creatable[] {
  const head = sec === "files" ? "" : sec;
  return head ? CREATABLES.filter((c) => c.yaml === head || c.yaml.startsWith(head + ".") || c.yaml.startsWith(head + "[")) : [];
}

/** ＋ 추가 — 눌린 자리 아래 종류 메뉴(스크린샷의 Add 메뉴). 바깥을 누르거나 Esc 로 닫는다.
 *  `why` 를 주면 버튼 대신 **점선 한 줄**로 선다 — 비어 있는 섹션의 자리를 지키는 형태다 */
function AddMenu({ sec, title, label, why, icon, line, m, files, onPick, onAsk }: { sec: string; title: string; label?: string; why?: string; icon?: Key; line?: boolean; m: Manifest; files: string[]; onPick: (c: Creatable) => void; onAsk: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // 메뉴는 body 에 붙여 fixed 로 띄운다 — 좁은 스크롤 칸(overflow: auto) 안에서는 absolute 가 잘린다
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const b = btn.current?.getBoundingClientRect();
      const w = menu.current?.offsetWidth ?? 300;
      if (!b) return;
      const left = Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8));
      setPos({ top: b.bottom + 4, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [open]);
  const kinds = creatablesFor(sec);
  const list = (
    <div className="ap-menu" role="menu" ref={menu} style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, right: "auto", visibility: pos ? "visible" : "hidden" }}>
      <button type="button" className="ap-mi" role="menuitem" onClick={() => { setOpen(false); onAsk(`${title} 하나 추가해줘: `); }}>
        <span className="ap-mi-t">✦ 말로 만들기</span>
        <span className="ap-mi-d">오른쪽에 적으면 대신 만들어 줍니다</span>
      </button>
      {kinds.map((c) => {
        const why = blocked(c, m, files);
        return (
          <button key={c.id} type="button" className="ap-mi" role="menuitem" disabled={!!why} title={why ?? c.detail} onClick={() => { setOpen(false); onPick(c); }}>
            <span className="ap-mi-t">{c.label}</span>
            <span className="ap-mi-d">{why ?? c.detail}</span>
          </button>
        );
      })}
    </div>
  );
  return (
    <div className={why || line ? "ap-addwrap row" : "ap-addwrap"}>
      {line ? (
        <button type="button" className="ap-plus" ref={btn as React.Ref<HTMLButtonElement>} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true">＋</span> {label ?? title}
        </button>
      ) : why ? (
        <button type="button" className="ap-none" ref={btn as React.Ref<HTMLButtonElement>} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {icon ? <Icon k={icon} /> : null}
          <span className="ap-none-col">
            <span className="ap-none-t">{label ?? title}</span>
            <span className="ap-none-d">{why}</span>
          </span>
          <span className="ap-none-x" aria-hidden="true">＋</span>
        </button>
      ) : (
        <button type="button" className="ap-add-x" ref={btn} aria-expanded={open} onClick={() => setOpen((v) => !v)} title={`${title} 추가`} aria-label={`${title} 추가`}>＋</button>
      )}
      {open && typeof document !== "undefined" ? createPortal(list, document.body) : null}
    </div>
  );
}

/** 한 섹션이 접히지 않고 보여 주는 최대 줄 수 — 넘으면 "n개 더 보기". 하나 초과일 때만 자른다
 *  (7개를 6+"1개 더 보기" 로 자르면 줄 수가 같으면서 한 번 더 누르게만 만든다) */
const LIST_CAP = 6;

const FOLD_KEY = "relay-ap-fold";
function loadFold(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]")); } catch { return new Set(); }
}

export default function AgentPanel({ m, files, rows, landing, open, onOpen, onBack, children, links, danger, onPick, onAsk, onEngine, engineBusy, activeEngine, liveEngines = [], onActivate, status, labelOf, personaLead, scripts = [] }: AgentPanelProps) {
  const [tab, setTab] = useState<"agent" | "settings">("agent");
  // 접힌 섹션 — 기능처럼 항목이 많으면 목록이 길어진다. 제목을 누르면 접히고, 선택은 기억한다
  const [fold, setFold] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : loadFold()));
  // 긴 목록은 6줄까지 — 기능 12개가 칸의 절반을 먹으면 그 아래 구조가 스크롤 밖으로 밀린다
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  // 엔진 안내문 — **실제로 할 수 있는 것만** 말한다. 종전에는 도는 엔진이 하나뿐일 때도
  // "다른 것을 누르면 바로 바뀝니다" 라고 적어 두었는데, 나머지는 아직 적용 전이라 눌리지도
  // 않는 상태였다. 화면이 약속한 것을 화면이 거부하면 누른 사람은 고장으로 읽는다(2026-08-28)
  // 설명문은 **비어 있을 때만**. 붙어 있으면 목록의 행이 이미 상태를 하나씩 말하고 있어,
  // 그 위에 문단을 얹으면 같은 것을 세 번 말하게 된다(상태 줄 · 행 꼬리표 · 안내문, 2026-08-28)
  const engineNote = (m.harness?.variants ?? []).length ? "" : "＋ 로 붙인 뒤 적용하면, 어느 것으로 돌릴지 고를 수 있습니다.";
  // 요약 칩 → 그 섹션으로. 접혀 있으면 펴고 스크롤한다(칩이 문이 아니면 사실 나열일 뿐이다)
  const secRefs = useRef<Record<string, HTMLElement | null>>({});
  const goSec = (sec: string) => {
    setFold((prev) => { const n = new Set(prev); n.delete(sec); try { localStorage.setItem(FOLD_KEY, JSON.stringify([...n])); } catch {} return n; });
    requestAnimationFrame(() => secRefs.current[sec]?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const toggleFold = (sec: string) => setFold((prev) => {
    const next = new Set(prev);
    if (next.has(sec)) next.delete(sec); else next.add(sec);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...next])); } catch {}
    return next;
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const secDef = (key: string) => SECTIONS.find((s) => s.key === key);
  const itemsOf = (sec: string): SectionItem[] => {
    const all = secDef(sec)?.items?.(m, files) ?? [];
    // 기능은 scripts.source 바로 아래 *.ts 만 동사다 — lib/ 같은 도우미 파일은 목록에 세우지 않는다
    // (섹션 랜딩에서는 전부 보인다)
    return sec === "scripts" ? all.filter((it) => !it.id.includes("/")) : all;
  };

  // 항목의 사람 말 — 폼의 id 는 그대로 두고 보이는 글만 바꾼다.
  // mono 는 부제가 id·경로일 때만. 산문을 고정폭으로 찍으면 글자가 다 따로 놀아 줄이 시끄럽다
  // 부제는 되도록 **관계**를 적는다 — "이것이 무엇을 부르나 / 누구와 이어지나". 종전에는 id 나
  // "기능 2" 처럼 무엇의 2인지 말하지 않는 숫자였고, 그래서 목록을 다 읽어도 구조가 안 잡혔다
  const display = (sec: string, it: SectionItem, row: Row | undefined): { title: string; sub?: string; mono?: boolean } => {
    if (sec === "triggers") {
      const t = (m.triggers ?? []).find((x) => x.id === it.id);
      const ko = t?.when?.cron ? cronToKorean(t.when.cron) : t?.when?.event ? `${t.when.event} 이 생기면` : null;
      const to = t ? triggerTarget(t) : null;
      return ko ? { title: ko, sub: to ? `→ ${to}` : it.id, mono: !to } : { title: it.id, sub: to ? `→ ${to}` : it.sub };
    }
    if (sec === "scripts") {
      const r = row?.items.find((x) => x.sub === it.id);
      return r ? { title: r.text, sub: it.id, mono: true } : { title: it.id };
    }
    // 부제는 뜻이 더해질 때만 단다 — "웹 화면 / 사람이 여는 페이지" 처럼 제목을 되풀이하는 줄은
    // 읽을 것만 늘린다(2026-08-28)
    if (sec === "surfaces") {
      if (it.id === "view") return { title: "웹 화면" };
      if (it.id === "components") return { title: "화면 부품" };
      return { title: channelLabel(it.title) };
    }
    if (sec === "agents") {
      const a = (m.agents ?? []).find((x) => x.name === it.id);
      return { title: it.id, sub: a ? agentSub(a, scripts) : it.sub };
    }
    if (sec === "edges") {
      const e = (m.edges ?? [])[Number(it.id)];
      if (!e) return { title: it.title, sub: it.sub };
      const who = labelOf?.(e.provider) ?? e.provider;
      return { title: who, sub: e.mission ? `→ ${e.mission} 맡김` : e.components ? "화면 부품" : e.tools?.length ? `기능 ${e.tools.length}개` : undefined };
    }
    return { title: it.title, sub: it.sub };
  };

  // ── 펼침 — 안으로 들어가는 화면이 없다. 누른 줄 아래로 폼이 펼쳐지고, 다시 누르면 접힌다 ──
  const isOpen = (sec: string, item: string | null) => open.sec === sec && (open.item ?? null) === item;
  const toggle = (sec: string, item: string | null) => (isOpen(sec, item) ? onBack() : onOpen(sec, item));
  const slot = (sec: string, item: string | null) => (isOpen(sec, item) ? <div className="ap-inline">{children}</div> : null);

  // ── 목록 ─────────────────────────────────────────────────────────────────
  const have = new Set((m.harness?.variants ?? []).map((v) => v.name));
  // 문장의 재료(lib/describe.ts sentences)
  const sayCtx = {
    workspace: "", scripts, landing, activeHarness: activeEngine ?? null, files,
    labelOf: labelOf ?? ((n: string) => n),
    edges: (m.edges ?? []).map((e) => ({ consumer: "", provider: e.provider, ref: e.provider, tools: e.tools, mission: e.mission, granted: true })),
  };
  const say = sentences(m, sayCtx);
  const adds = say.flatMap((p) => p.adds);
  // 요약 칩 — edges 는 이 패널이 매니페스트만 알아 선언 그대로 센다(결재 여부는 줄 옆이 말한다)

  const section = (s: { k: Key; sec: string; title: string; add?: string }, items: SectionItem[], row: Row | undefined) => {
    // 열린 항목이 있는 섹션은 접혀 있어도 펼쳐 보인다 — 고치는 줄이 안 보이면 안 된다
    const folded = fold.has(s.sec) && open.sec !== s.sec;
    const cap = showAll.has(s.sec) || items.length <= LIST_CAP + 1 ? items.length : LIST_CAP;
    const shown = items.slice(0, cap);
    return (
    <section key={s.sec} ref={(el) => { secRefs.current[s.sec] = el; }} className={`ap-sec${folded ? " folded" : ""}`}>
      <div className="ap-sec-h">
        {LIST_SECS.has(s.sec) ? (
          <button type="button" className="ap-sec-t fold" aria-expanded={!folded} onClick={() => toggleFold(s.sec)} title={folded ? "펼치기" : "접기"}>
            <Icon k={s.k} />
            <span>{s.title}</span>
            {folded && items.length ? <b className="ap-n">{items.length}</b> : null}
            <Chevron />
          </button>
        ) : (
          <button type="button" className="ap-sec-t" aria-expanded={isOpen(s.sec, null)} onClick={() => toggle(s.sec, null)} title="펼쳐서 고칩니다">
            <Icon k={s.k} />
            <span>{s.title}</span>
            <Chevron />
          </button>
        )}
        {s.add ? <AddMenu sec={s.sec} title={s.add} m={m} files={files} onPick={onPick} onAsk={onAsk} /> : null}
      </div>
      {slot(s.sec, null)}
      {folded ? null : shown.map((it) => {
        const d = display(s.sec, it, row);
        const st = status?.(s.sec, it.id) ?? null;
        return (
          <div key={it.id}>
            <button type="button" className="ap-item" aria-expanded={isOpen(s.sec, it.id)} onClick={() => toggle(s.sec, it.id)}>
              <span className="ap-item-t">{d.title}</span>
              {d.sub ? <span className={`ap-item-s${d.mono ? " mono" : ""}`}>{d.sub}</span> : null}
              {st ? <span className={`ap-item-st${st.on ? " on" : ""}`} title={st.title}>{st.label}</span> : null}
              <Chevron />
            </button>
            {slot(s.sec, it.id)}
          </div>
        );
      })}
      {!folded && cap < items.length ? (
        <button type="button" className="ap-more-btn" onClick={() => setShowAll((p) => new Set(p).add(s.sec))}>{items.length - cap}개 더</button>
      ) : null}
      {!folded && !items.length && row ? <p className="ap-empty">{row.empty}</p> : null}
    </section>
    );
  };

  return (
    <div className="ap">
      <div className="ap-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "agent"} onClick={() => setTab("agent")}>에이전트</button>
        <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>설정</button>
      </div>

      {tab === "agent" ? (
        <>
          {/* 소개 한 줄은 여기 없다(2026-08-28) — 가운데 칸의 화면이 제목과 함께 그 문장을
              이미 크게 보여 주고, 설정 탭의 [기본 정보]가 고치는 문이다. 왼쪽에 두면 두 줄에서
              잘린 같은 문장이 세 번째로 서고, 정작 이 칸이 하는 말(아래 세 문단)을 밀어낸다 */}
          {/* 몸 — 에이전트가 자기를 소개하는 세 문단. 밑줄 그은 낱말이 곧 고치는 문이고,
              누르면 그 문단 아래로 폼이 펼쳐진다(다른 화면으로 가지 않는다) */}
          {/* 이 에이전트가 자기를 말하는 문장 — 성격 글의 첫 줄 그대로. 누르면 그 글로 간다.
              "성격과 역할은 따로 적어 두었습니다" 같은 파일 정리 안내를 대신한다(2026-08-28) */}
          {landing && personaLead ? (
            <>
              <button type="button" className="ap-lead" aria-expanded={isOpen("agents", landing)} onClick={() => toggle("agents", landing)} title="성격과 역할을 고칩니다">
                {personaLead}
              </button>
              {isOpen("agents", landing) ? <div className="ap-inline">{children}</div> : null}
            </>
          ) : null}

          <div className="ap-say">
            {say.map((para: Para) => (
              <div key={para.key} className="ap-para">
                <p className="ap-line">
                  {para.parts.map((x, i) =>
                    typeof x === "string" ? (
                      <span key={i} className={x === " · " ? "ap-sep" : undefined}>{x}</span>
                    ) : (
                      <button
                        key={i}
                        type="button"
                        className="ap-tok"
                        aria-expanded={isOpen(x.sec, x.sec === "harness" ? null : (x.item ?? null))}
                        title={TOK_HINT[x.sec] ?? "눌러서 고치기"}
                        onClick={() => toggle(x.sec, x.sec === "harness" ? null : (x.item ?? null))}
                      >
                        {TOK_ICON[x.sec] ? <Icon k={TOK_ICON[x.sec]!} /> : null}
                        <span>{x.t}</span>
                      </button>
                    ),
                  )}
                </p>
                {/* 열린 폼 — 이 문단이 가진 낱말의 것이면 여기 선다 */}
                {para.parts.some((x) => typeof x !== "string" && x.sec === "harness") && isOpen("harness", null) ? (
                  <div className="ap-inline">
                    <div className="st-verbs">
                    {/* 다른 폼과 같은 카드 문법 — 라벨 · 상태 한 줄 · 고르는 것 · 설명 한 줄.
                        엔진만 옛 칩 줄로 남아 있어 같은 화면에서 두 벌의 문법이 보였다(2026-08-28) */}
                    <div className="st-verbs-h"><span className="ap-lab">엔진</span></div>
                    {/* 칩 하나가 세 가지를 말한다: 채워짐 = 지금 도는 엔진, 테두리 = 붙어 있음
                        (누르면 이걸로 돌린다), ＋ = 아직 없음(누르면 붙인다). 전환은 장부를 고치므로
                        적용을 기다리지 않고, 사본에만 있는 엔진은 장부가 이름을 몰라 고를 수 없다.
                        종전에는 이 줄이 붙이고 빼기만 했고 "그럼 지금 뭘로 도는데" 의 답이 다른
                        화면(그래프 카드의 알약)에 있었다 — 여기서 물으니 여기서 답한다(2026-08-28) */}
                    {/* 칩 하나가 두 가지 일(고르기·빼기)을 반반으로 나눠 갖고 있었다 — 작은 알약을
                        절반씩 눌러야 해서, 고르려다 빼는 일이 실제로 일어났다(2026-08-28).
                        기능·스킬과 같은 목록 행으로 바꾼다: 한 줄에 상태가 적히고, 빼기는 오른쪽 끝이다 */}
                    <ul className="st-verbl">
                      {ENGINES.map((e) => {
                        const on = have.has(e.id);
                        const live = liveEngines.includes(e.id);
                        const now = on && live && activeEngine === e.id;
                        const canSwitch = on && live && !now && !!onActivate;
                        const note = now ? "사용 중" : on && !live ? "적용 전" : "";
                        return (
                          <li key={e.id}>
                            <button
                              type="button"
                              className="st-verbl-r"
                              aria-pressed={now}
                              disabled={engineBusy || (on && !live)}
                              title={on ? note : `${e.label} 붙이기`}
                              onClick={() => (on ? canSwitch && onActivate!(e.id) : onEngine(e.id))}
                            >
                              <span className="st-verbl-c" aria-hidden="true">{now ? "●" : on ? "○" : "＋"}</span>
                              <span className="st-verbl-t">{e.label}</span>
                              <span className="st-verbl-i">{note}</span>
                            </button>
                            {on ? (
                              <button type="button" className="st-verbl-x" disabled={engineBusy}
                                title={`${e.label} 빼기`} aria-label={`${e.label} 빼기`} onClick={() => onEngine(e.id)}>×</button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="st-verbs-p">{engineNote}                    </p>
                    </div>
                  </div>
                ) : null}
                {para.parts.some((x) => typeof x !== "string" && x.sec !== "harness" && isOpen(x.sec, x.item ?? null)) ? <div className="ap-inline">{children}</div> : null}
              </div>
            ))}
            {/* 없는 것은 **맨 아래 한 묶음**으로. 문단 사이에 점선이 끼면 세 문장이 한 단락으로
                읽히지 않는다(2026-08-28). 제목("더 붙일 수 있는 것")은 달지 않는다 — ＋ 와 점선
                테두리가 이미 그 말이고, 줄마다 무엇이 붙는지도 적혀 있다 */}
            {/* 없는 것만 모은다 — 전부 점선 ＋ 로 한 종류다. 종전에는 여기 실선 문(성격과 역할)이
                섞여 있어서, 같은 묶음 안에 성질이 다른 둘이 나란히 섰다(2026-08-28) */}
            {adds.length ? (
              <div className="ap-adds">
                {adds.map((a: Add) => (
                  <div key={a.sec}>
                    <AddMenu sec={a.sec} title={a.label} label={a.label} why="" line m={m} files={files} onPick={onPick} onAsk={onAsk} />
                    {isOpen(a.sec, null) ? <div className="ap-inline">{children}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* 발 — 자주 열지 않지만 에이전트의 것. 성격은 문장으로 못 줄인다(사람이 쓰는 글이다) */}
        </>
      ) : (
        <>
          {/* 기본 정보 — 아이콘·이름·설명 */}
          <section className="ap-sec">
            <div className="ap-sec-h">
              <span className="ap-sec-t plain">
                <Icon k="identity" />
                <span>기본 정보</span>
              </span>
            </div>
            <button type="button" className="ap-item ap-id" aria-expanded={isOpen("identity", null)} onClick={() => toggle("identity", null)} title="이름 · 버전 · 소개를 고칩니다">
              <span className="ap-id-col">
                <span className="ap-item-t">{m.display_name ?? m.name ?? "(이름 없음)"}</span>
                <span className="ap-item-s mono">{m.name}{m.version ? ` · ${m.version}` : ""}</span>
              </span>
              <Chevron />
            </button>
            {!isOpen("identity", null) && m.description ? <p className="ap-desc">{m.description}</p> : null}
            {slot("identity", null)}
          </section>
          {SETTING_SECS.map((s) => section(s, itemsOf(s.sec), byKey.get(s.k)))}
          <details className="ap-advanced" open={ADVANCED_SECS.some((s) => open.sec === s.sec)}>
          <summary>고급 — 개인 사용에서는 보통 손대지 않습니다</summary>
          {ADVANCED_SECS.map((s) => {
            const items = itemsOf(s.sec);
            // 비어 있지 않으면 보통 섹션, 비면 줄 하나 — "없음" 이 두 번 서던 자리
            return items.length ? section(s, items, byKey.get(s.k)) : (
              <div key={s.sec}>
                <button type="button" className="ap-item ap-adv" aria-expanded={isOpen(s.sec, null)} onClick={() => toggle(s.sec, null)}>
                  <Icon k={s.k} />
                  <span className="ap-item-t">{s.title}</span>
                  <span className="ap-item-s">{s.sec === "host_methods" ? "제한 없음" : "없음"}</span>
                  <Chevron />
                </button>
                {slot(s.sec, null)}
              </div>
            );
          })}
          </details>
          {links ? <div className="ap-links">{links}</div> : null}
          {danger ? (
            <section className="ap-sec ap-danger">
              <div className="ap-sec-h"><span className="ap-sec-t plain"><span>제거</span></span></div>
              {danger}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
