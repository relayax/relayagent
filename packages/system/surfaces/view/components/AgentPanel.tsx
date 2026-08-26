"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CREATABLES, blocked, type Creatable } from "@/lib/create";
import type { Row } from "@/lib/describe";
import { cronToKorean } from "@/lib/describe";
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

/** 갈래마다 늘어놓을 섹션 — (아이콘 키, 폼 섹션 키, 제목). 에이전트 갈래는 "무엇을 하나"(엔진·성격 포함),
 *  설정 갈래는 "설치와 허용 범위". 동작 엔진은 에이전트 갈래에만 — 두 갈래에 같은 폼이 서 있었다. */
const AGENT_SECS: { k: Key; sec: string; title: string; add: string }[] = [
  { k: "when", sec: "triggers", title: "스케줄", add: "예약" },
  { k: "verbs", sec: "scripts", title: "기능", add: "기능" },
  { k: "links", sec: "edges", title: "연결", add: "연결" },
  { k: "dirs", sec: "services", title: "폴더와 자원", add: "자원" },
  { k: "faces", sec: "surfaces", title: "화면과 채널", add: "화면·채널" },
  { k: "missions", sec: "missions", title: "맡길 수 있는 일", add: "일" },
  { k: "talk", sec: "agents", title: "보조 에이전트", add: "보조" },
];
/** 항목 목록을 갖는 섹션 — 이 패널이 이미 목록·＋추가·빈 상태를 다 보여주므로 섹션 랜딩(같은 목록을
 *  한 번 더 그리는 화면)으로 가는 문이 없다. 문은 항목과 ＋ 추가 둘뿐. 나머지(기본 정보·엔진·필요한 것
 *  ·브리지 캡·조직·기타 파일)는 섹션 자체가 폼 하나라 제목이 문이다 */
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
}

/** 섹션마다 [＋ 추가] 가 내놓는 종류 — 팔레트의 레시피를 문법 좌표(yaml)로 고른다 */
function creatablesFor(sec: string): Creatable[] {
  const head = sec === "files" ? "" : sec;
  return head ? CREATABLES.filter((c) => c.yaml === head || c.yaml.startsWith(head + ".") || c.yaml.startsWith(head + "[")) : [];
}

/** ＋ 추가 — 눌린 자리 아래 종류 메뉴(스크린샷의 Add 메뉴). 바깥을 누르거나 Esc 로 닫는다 */
function AddMenu({ sec, title, label, m, files, onPick, onAsk }: { sec: string; title: string; label?: string; m: Manifest; files: string[]; onPick: (c: Creatable) => void; onAsk: (t: string) => void }) {
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
      <button type="button" className="ap-mi" role="menuitem" onClick={() => { setOpen(false); onAsk(`이 패키지에 ${title} 하나 추가해줘: `); }}>
        <span className="ap-mi-t">✦ 말로 만들기</span>
        <span className="ap-mi-d">오른쪽 빌더에게 원하는 것을 적으면 대신 만듭니다</span>
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
    <div className="ap-addwrap">
      <button type="button" className={label ? "ap-add chip" : "ap-add"} ref={btn} aria-expanded={open} onClick={() => setOpen((v) => !v)} title={`${title} 추가`}>
        ＋ {label ?? "추가"}
      </button>
      {open && typeof document !== "undefined" ? createPortal(list, document.body) : null}
    </div>
  );
}

const FOLD_KEY = "relay-ap-fold";
function loadFold(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]")); } catch { return new Set(); }
}

export default function AgentPanel({ m, files, rows, landing, open, onOpen, onBack, children, links, danger, onPick, onAsk }: AgentPanelProps) {
  const [tab, setTab] = useState<"agent" | "settings">("agent");
  // 접힌 섹션 — 기능처럼 항목이 많으면 목록이 길어진다. 제목을 누르면 접히고, 선택은 기억한다
  const [fold, setFold] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : loadFold()));
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

  // 항목의 사람 말 — 폼의 id 는 그대로 두고 보이는 글만 바꾼다
  const display = (sec: string, it: SectionItem, row: Row | undefined): { title: string; sub?: string } => {
    if (sec === "triggers") {
      const t = (m.triggers ?? []).find((x) => x.id === it.id);
      const ko = t?.when?.cron ? cronToKorean(t.when.cron) : t?.when?.event ? `${t.when.event} 이 생기면` : null;
      return ko ? { title: ko, sub: it.id } : { title: it.id, sub: it.sub };
    }
    if (sec === "scripts") {
      const r = row?.items.find((x) => x.sub === it.id);
      return r ? { title: r.text, sub: it.id } : { title: it.id };
    }
    if (sec === "surfaces") return it.id === "view" ? { title: "화면", sub: it.sub } : it.id === "components" ? { title: "끼울 부품", sub: it.sub } : { title: it.title, sub: "채널" };
    return { title: it.title, sub: it.sub };
  };

  // ── 펼침 — 안으로 들어가는 화면이 없다. 누른 줄 아래로 폼이 펼쳐지고, 다시 누르면 접힌다 ──
  const isOpen = (sec: string, item: string | null) => open.sec === sec && (open.item ?? null) === item;
  const toggle = (sec: string, item: string | null) => (isOpen(sec, item) ? onBack() : onOpen(sec, item));
  const slot = (sec: string, item: string | null) => (isOpen(sec, item) ? <div className="ap-inline">{children}</div> : null);

  // ── 목록 ─────────────────────────────────────────────────────────────────
  const engine = byKey.get("engine")?.items[0]?.text;
  const helpers = itemsOf("agents").filter((a) => a.id !== landing);
  const agentItems = (s: { sec: string }) => (s.sec === "agents" ? helpers : itemsOf(s.sec));

  const section = (s: { k: Key; sec: string; title: string; add?: string }, items: SectionItem[], row: Row | undefined) => {
    // 열린 항목이 있는 섹션은 접혀 있어도 펼쳐 보인다 — 고치는 줄이 안 보이면 안 된다
    const folded = fold.has(s.sec) && open.sec !== s.sec;
    return (
    <section key={s.sec} className={`ap-sec${folded ? " folded" : ""}`}>
      <div className="ap-sec-h">
        {LIST_SECS.has(s.sec) ? (
          <button type="button" className="ap-sec-t fold" aria-expanded={!folded} onClick={() => toggleFold(s.sec)} title={folded ? "펼치기" : "접기"}>
            <Icon k={s.k} />
            <span>{s.title}</span>
            {items.length ? <b className="ds-n">{items.length}</b> : null}
            <Chevron />
          </button>
        ) : (
          <button type="button" className="ap-sec-t" aria-expanded={isOpen(s.sec, null)} onClick={() => toggle(s.sec, null)} title="펼쳐서 고칩니다">
            <Icon k={s.k} />
            <span>{s.title}</span>
            {items.length ? <b className="ds-n">{items.length}</b> : null}
            <Chevron />
          </button>
        )}
        {s.add ? <AddMenu sec={s.sec} title={s.add} m={m} files={files} onPick={onPick} onAsk={onAsk} /> : null}
      </div>
      {slot(s.sec, null)}
      {folded ? null : items.map((it) => {
        const d = display(s.sec, it, row);
        return (
          <div key={it.id}>
            <button type="button" className="ap-item" aria-expanded={isOpen(s.sec, it.id)} onClick={() => toggle(s.sec, it.id)}>
              <span className="ap-item-t">{d.title}</span>
              {d.sub ? <span className="ap-item-s">{d.sub}</span> : null}
              <Chevron />
            </button>
            {slot(s.sec, it.id)}
          </div>
        );
      })}
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
          {/* 맨 위 — 에이전트 자신: 엔진과 성격 글 */}
          <section className="ap-sec">
            <div className="ap-sec-h">
              <span className="ap-sec-t plain">
                <Icon k="talk" />
                <span>에이전트</span>
              </span>
            </div>
            <button type="button" className="ap-item ap-pick" aria-expanded={isOpen("harness", null)} onClick={() => toggle("harness", null)}>
              <Icon k="engine" />
              <span className="ap-item-t">{engine ? `${engine} 로 동작` : "엔진 고르기"}</span>
              <Chevron />
            </button>
            {slot("harness", null)}
            {landing ? (
              <>
              <button type="button" className="ap-item" aria-expanded={isOpen("agents", landing)} onClick={() => toggle("agents", landing)}>
                <span className="ap-item-t">성격과 역할</span>
                <span className="ap-item-s">{landing}</span>
                <Chevron />
              </button>
              {slot("agents", landing)}
              </>
            ) : (
              <p className="ap-empty">대화 없음 — 에이전트를 하나 만들면 이 화면에서 대화할 수 있습니다</p>
            )}
          </section>
          {/* 비어 있는 섹션은 "아직 없음" 네 줄 대신 맨 아래 한 묶음으로 — 있는 것부터 보인다 */}
          {AGENT_SECS.filter((s) => agentItems(s).length || open.sec === s.sec).map((s) => section(s, agentItems(s), byKey.get(s.k)))}
          {AGENT_SECS.some((s) => !agentItems(s).length && open.sec !== s.sec) ? (
            <section className="ap-sec ap-more">
              <div className="ap-sec-h"><span className="ap-sec-t plain"><span>더 붙일 수 있는 것</span></span></div>
              <div className="ap-chips">
                {AGENT_SECS.filter((s) => !agentItems(s).length && open.sec !== s.sec).map((s) => (
                  <AddMenu key={s.sec} sec={s.sec} title={s.add} label={s.title} m={m} files={files} onPick={onPick} onAsk={onAsk} />
                ))}
              </div>
            </section>
          ) : null}
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
