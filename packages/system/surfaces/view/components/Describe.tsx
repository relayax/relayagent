"use client";

import { useState } from "react";
import type { Row } from "@/lib/describe";

// 1층 "읽기". 줄은 질문-답이고 어느 줄이든 누르면 그 아래로 2층(그 섹션의 폼과 결과면)이
// 펼쳐진다. 빈 줄도 펼쳐진다 — 거기서 만든다. 고급 줄(거의 손대지 않는 선언)은 접어 둔다:
// 개인 기판에서 거의 안 쓰는 것이 한복판에 서면 나머지가 묻힌다.
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
  trailing?: Partial<Record<Row["key"], React.ReactNode>>;
  /** 펼친 줄 아래에 그릴 것 */
  children?: React.ReactNode;
}) {
  const [advOpen, setAdvOpen] = useState(false);
  const main = rows.filter((r) => !r.advanced);
  const adv = rows.filter((r) => r.advanced);
  const advShown = advOpen || adv.some((r) => r.sec === open);
  const row = (r: Row) => {
    const isOpen = r.sec === open;
    return (
      <div key={r.key} className={`ds-sec${isOpen ? " open" : ""}`}>
        <button type="button" className="ds-row" onClick={() => onToggle(r.sec)} aria-expanded={isOpen} title={isOpen ? "접기" : "여기를 고칩니다"}>
          <span className="ds-q">{r.q}</span>
          <span className="ds-a">
            {r.items.length ? (
              r.items.map((it, i) => (
                <span key={i} className="ds-item">
                  {it.text}
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
  return (
    <div className="ds">
      {main.map(row)}
      {adv.length ? (
        <>
          <button type="button" className="ds-row ds-adv" onClick={() => setAdvOpen((v) => !v)} aria-expanded={advShown}>
            <span className="ds-q">고급</span>
            <span className="ds-a ds-empty">거의 손대지 않는 선언</span>
            <span className="ds-caret">{advShown ? "▾" : "▸"}</span>
          </button>
          {advShown ? adv.map(row) : null}
        </>
      ) : null}
    </div>
  );
}
