"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import Detail from "@/components/Detail";
import Graph from "@/components/Graph";
import type { EdgeView, Registry } from "@/lib/types";

// 관리의 자리. 사이드바가 쓰는 자리라면 여기는 다스리는 자리다 — 지도(그래프), 설치·권한·자격의
// 조작 다이얼로그가 전부 이 안에 있다. 종전 콘솔(3열 홈)이 통째로 이리로 들어왔다
export default function SettingsPane({ reg, edges, onChanged }: { reg: Registry; edges: EdgeView[]; onChanged: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const selected = reg.packages.find((p) => p.name === sel) ?? null;

  // 패널 닫기 — 열 폭이 0 으로 줄어드는 동안(closing) 마지막 내용을 그대로 그려 오른쪽으로 밀려 나가게 한다
  const [closing, setClosing] = useState(false);
  const lastSel = useRef<typeof selected>(null);
  if (selected) lastSel.current = selected;
  const closeDetail = useCallback(() => {
    setSel(null);
    setClosing(true);
    window.setTimeout(() => setClosing(false), 280);
  }, []);
  const shown = selected ?? (closing ? lastSel.current : null);

  return (
    <section className="pane">
      <header className="pane-head">
        <h2>설정</h2>
        {/* 종전의 "지도 · 설치와 버전 · 권한 대장 · 자격 · 하네스" 는 메뉴처럼 보이는데 누를 수 없는 라벨이었고,
            "터미널: relay draft <이름>" 은 일반 사용자에게 뜻이 없었다 — 둘 다 뺐다(2026-08-27). 터미널 안내는 README 에 있다 */}
        <span className="meta">설치된 에이전트와 그 사이의 연결</span>
        <div className="right">
          {/* 자격 연결은 별도 화면(연결)이 소유한다 — 지도의 필을 눌러도 같은 폼이지만, 전 패키지의 전경은 그쪽이다 */}
          <Link className="ob-open" href="/connections/" title="바깥 서비스와 창구의 자격을 한 자리에서">연결</Link>
          {/* 사용 안내는 홈(기판 셸)에 산다 — 처음 닿는 자리가 거기라서. 여기서는 그 문으로 보낸다 */}
          <a className="ob-open" href="/?guide=1" title="사용 안내 다시 보기">안내</a>
        </div>
      </header>
      <div className={`settings-body${selected ? " has-detail" : ""}${!selected && closing ? " detail-closing" : ""}`}>
        <div className="col">
          <Graph reg={reg} edges={edges} sel={sel} onSelect={(name) => (name ? setSel(name) : sel && closeDetail())} onChanged={onChanged} />
        </div>
        {shown ? (
          <div className="col detail-col">
            <Detail pkg={shown} edges={edges} onChanged={onChanged} onClose={closeDetail} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
