"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ChatNudge from "@/components/ChatNudge"; // 말풍선
import Onboarding, { ONBOARD_KEY } from "@/components/Onboarding"; // 온보딩
import PkgPane from "@/components/PkgPane";
import SettingsPane from "@/components/SettingsPane";
import { edgesData, fetchRegistry, fetchResidency, fetchShellNav, type ShellNav } from "@/lib/api";
import type { Registry } from "@/lib/types";

// 콘솔 패키지의 화면 = 관리 앱. 사이드바도 홈(앱 런처)도 **여기 없다** — 둘 다 전역 셸의
// 것이고 기판이 낸다(runner/runtime/shell.ts). 이 패키지는 그 셸 안에 앉는 여러 앱 중 하나이며,
// 맡는 것은 다스리는 화면과 셸이 서빙할 문서가 없는 얼굴들이다:
//   /                    설정 — 지도·설치와 버전·권한 대장·자격·하네스
//   /?p=<설치이름>        상주 상태와 권한 화면(기판이 낼 문서가 없는 얼굴)
//     &face=live|detail
// 정적 발행(output: export)이라 동적 세그먼트 대신 쿼리가 정본이다(스튜디오와 같은 규약).
const EMPTY: Registry = { packages: [], grants: [] };

export default function ConsolePage() {
  return (
    <Suspense fallback={<div className="console" />}>
      <Console />
    </Suspense>
  );
}

function Console() {
  const router = useRouter();
  const sp = useSearchParams();
  const sel = sp.get("p");
  const face = sp.get("face");
  const pane: "pkg" | "settings" = sel ? "pkg" : "settings";

  const [reg, setReg] = useState<Registry>(EMPTY);
  const [nav, setNav] = useState<ShellNav | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onboard, setOnboard] = useState(false);

  // 첫 실행 안내는 **자동으로 뜨지 않는다** — 이 화면은 더 이상 처음 닿는 자리가 아니다.
  // 처음 닿는 자리는 셸 홈(기판이 내는 런처)이고, 안내의 문구도 그 IA 를 설명해야 한다.
  // 그 이사가 끝날 때까지 안내는 아래 [안내] 버튼으로만 열린다(문구는 손대지 않았다).

  const closeOnboard = useCallback((never: boolean) => {
    if (never) localStorage.setItem(ONBOARD_KEY, "1");
    setOnboard(false);
  }, []);
  const openGuide = useCallback(() => setOnboard(true), []);

  const load = useCallback(async () => {
    try {
      setReg(await fetchRegistry());
      setError(null);
    } catch (e) {
      setError(`기판에 닿지 않습니다: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoaded(true);
    }
    // 얼굴 판정은 기판 소유다 — 사이드바가 읽는 것과 같은 응답을 이 화면도 읽는다
    try {
      setNav(await fetchShellNav());
    } catch {
      setNav(null);
    }
    try {
      setRunning(await fetchResidency());
    } catch {
      setRunning([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const edges = useMemo(() => edgesData(reg), [reg]);
  const selected = reg.packages.find((p) => p.name === sel) ?? null;
  const item = nav?.items.find((i) => i.pkg === sel) ?? null;

  const goFace = useCallback((f: string) => router.push(`/?p=${encodeURIComponent(sel ?? "")}&face=${f}`), [router, sel]);

  return (
    <div className="console">
      {error ? <div className="banner">{error}</div> : null}
      {pane === "pkg" ? (
        selected ? (
          <PkgPane
            key={selected.name}
            pkg={selected}
            reg={reg}
            edges={edges}
            running={running}
            item={item}
            face={face}
            onFace={goFace}
            onChanged={() => void load()}
            onGone={() => { void load(); router.push("/"); }}
          />
        ) : loaded ? (
          <section className="pane">
            <header className="pane-head"><h2>없는 패키지</h2><span className="meta mono">{sel}</span></header>
            <div className="pane-body">
              <div className="rc-card pad">
                <p className="hint">장부에 이 이름의 설치가 없습니다. 제거되었거나 주소가 낡았습니다.</p>
                <div className="detail-foot"><a className="rc-btn" href="/">홈으로</a></div>
              </div>
            </div>
          </section>
        ) : (
          <div className="pane-body center"><span className="rc-ring" /></div>
        )
      ) : (
        <SettingsPane reg={reg} edges={edges} onChanged={() => void load()} onGuide={openGuide} />
      )}

      <Onboarding open={onboard} onClose={closeOnboard} /> {/* 온보딩 */}
      {!onboard ? <ChatNudge /> : null} {/* 말풍선 */}
    </div>
  );
}
