"use client";

import { useState } from "react";
import type { Row } from "@/lib/describe";

// 1층 "읽기". 줄은 질문-답이고 어느 줄이든 누르면 그 아래로 2층(그 섹션의 폼과 결과면)이
// 펼쳐진다. 빈 줄도 펼쳐진다 — 거기서 만든다.
//
// 줄을 세 묶음 카드로 나눈다(할 수 있는 것 · 쓰는 것 · 구성) — 열두 줄이 같은 무게로 늘어서면
// 눈이 짚을 곳이 없다. 빈 줄은 묶음 끝에 한 줄로 접는다: 채운 것만 자리를 차지해야 "이 앱이
// 무엇인가"가 먼저 보인다. 고급 줄(거의 손대지 않는 선언)은 구성 묶음 안에서 한 번 더 접는다.

type Key = Row["key"];
const GROUPS: { title: string; keys: Key[] }[] = [
  { title: "할 수 있는 것", keys: ["verbs", "when", "talk"] },
  { title: "쓰는 것", keys: ["dirs", "links", "faces", "missions"] },
  { title: "구성", keys: ["identity", "engine", "needs", "host", "org", "files"] },
];
/** 접힌 빈 줄의 짧은 이름 — 질문(q)보다 한 마디 */
const SHORT: Record<Key, string> = {
  identity: "이름", verbs: "기능", when: "예약", dirs: "폴더", talk: "대화", faces: "화면·채널", links: "바깥 연결",
  missions: "맡길 일", engine: "엔진", needs: "필요한 것", host: "브리지 캡", org: "조직 설정", files: "기타 파일",
};
/** 줄마다 눈이 짚을 작은 아이콘 (16px, currentColor) */
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

export default function Describe({
  rows,
  open,
  onToggle,
  trailing,
  children,
}: {
  rows: Row[];
  /** 펼친 줄의 sec (URL 의 sec) */
  open: string | null;
  onToggle: (sec: string) => void;
  /** 줄 끝에 붙는 조작 (예: 미결재 연결의 승인 버튼). 버튼 안이라 클릭 전파는 호출자가 막는다 */
  trailing?: Partial<Record<Key, React.ReactNode>>;
  /** 펼친 줄 아래에 그릴 것 */
  children?: React.ReactNode;
}) {
  const [advOpen, setAdvOpen] = useState(false);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const row = (r: Row) => {
    const isOpen = r.sec === open;
    return (
      <div key={r.key} className={`ds-sec${isOpen ? " open" : ""}`}>
        <button type="button" className="ds-row" onClick={() => onToggle(r.sec)} aria-expanded={isOpen} title={isOpen ? "접기" : "여기를 고칩니다"}>
          <span className="ds-q">
            <Icon k={r.key} />
            {r.q}
            {r.key === "verbs" && r.items.length ? <b className="ds-n">{r.items.length}</b> : null}
          </span>
          <span className={`ds-a${r.key === "verbs" ? " ds-list" : ""}`}>
            {r.items.length ? (
              r.items.map((it, i) => (
                <span key={i} className="ds-item">
                  <span className="ds-t">{it.text}</span>
                  {it.sub ? <span className="ds-sub">{it.sub}</span> : null}
                </span>
              ))
            ) : (
              <span className="ds-empty">{r.empty}</span>
            )}
            {trailing?.[r.key] ?? null}
          </span>
          <span className="ds-caret">{isOpen ? "▾" : "▸"}</span>
        </button>
        {isOpen ? <div className="ds-x">{children}</div> : null}
      </div>
    );
  };

  /** 비어 있고 펼치지 않은 줄들 — 한 줄로 접는다. 누르면 그 자리에서 만든다 */
  const emptyLine = (empties: Row[]) =>
    empties.length ? (
      <div className="ds-none">
        <span>아직 없는 것</span>
        {empties.map((r) => (
          <button key={r.key} type="button" className="ds-none-btn" onClick={() => onToggle(r.sec)} title={`${r.q} — 여기서 만듭니다`}>
            {SHORT[r.key]} <b>＋</b>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="ds">
      {GROUPS.map((g) => {
        const present = g.keys.map((k) => byKey.get(k)).filter((r): r is Row => !!r);
        if (!present.length) return null;
        const main = present.filter((r) => !r.advanced);
        const adv = present.filter((r) => r.advanced);
        const filled = main.filter((r) => r.items.length || r.sec === open);
        const empties = main.filter((r) => !r.items.length && r.sec !== open);
        const advShown = advOpen || adv.some((r) => r.sec === open);
        return (
          <section key={g.title} className="rc-card ds-group">
            <h3 className="ds-title">{g.title}</h3>
            {filled.map(row)}
            {emptyLine(empties)}
            {adv.length ? (
              <>
                <button type="button" className="ds-row ds-adv" onClick={() => setAdvOpen((v) => !v)} aria-expanded={advShown}>
                  <span className="ds-q">고급</span>
                  <span className="ds-a ds-empty">거의 손대지 않는 선언 — {adv.map((r) => SHORT[r.key]).join(" · ")}</span>
                  <span className="ds-caret">{advShown ? "▾" : "▸"}</span>
                </button>
                {advShown ? adv.map(row) : null}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
