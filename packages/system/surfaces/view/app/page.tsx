"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ChatNudge from "@/components/ChatNudge"; // 말풍선
import { Button } from "@/components/ui/button";
import PkgPane from "@/components/PkgPane";
import SettingsPane from "@/components/SettingsPane";
import { edgesData, fetchRegistry, fetchResidency, fetchShellNav, type ShellNav } from "@/lib/api";
import { draftList, type DraftEntry } from "@/lib/studio";
import type { Pkg, Registry } from "@/lib/types";

// 콘솔 패키지의 화면 = 관리 앱. 사이드바도 홈(앱 런처)도 **여기 없다** — 둘 다 전역 셸의
// 것이고 기판이 낸다(runner/runtime/shell.ts). 이 패키지는 그 셸 안에 앉는 여러 앱 중 하나이며,
// 맡는 것은 다스리는 화면과 셸이 서빙할 문서가 없는 얼굴들이다:
//   /                    설정 — 지도·설치와 버전·권한 대장·자격·하네스
//   /?p=<설치이름>        상주 상태와 패키지 화면(기판이 낼 문서가 없는 얼굴)
//     &face=            셸이 붙이는 얼굴 이름 — 지금은 읽지 않는다(상주 현황은 설명서 아래 접힌 섹션)
//     &sec=&item=&file=   상세의 깊이 — 설명서 줄의 펼침(2층)과 열린 파일(3층). 스튜디오 규약 그대로
// 설치 안 된 초안(만드는 중)도 /?p= 로 연다 — 장부에 없으면 draft 목록에서 찾아 합성한다.
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
  const view = useMemo(() => ({ sec: sp.get("sec"), item: sp.get("item"), file: sp.get("file") }), [sp]);
  const pane: "pkg" | "settings" = sel ? "pkg" : "settings";

  const [reg, setReg] = useState<Registry>(EMPTY);
  const [nav, setNav] = useState<ShellNav | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 첫 실행 안내는 셸 홈(기판이 내는 런처, runner/runtime/shell.ts)에 산다 — 처음 닿는 자리가
  // 거기라서. 이 화면의 [안내] 는 그 문(/?guide=1)으로 가는 링크다.

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
    try {
      setDrafts((await draftList()).drafts);
    } catch {
      setDrafts([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const edges = useMemo(() => edgesData(reg), [reg]);
  const installed = reg.packages.find((p) => p.name === sel) ?? null;
  // 설치 안 된 초안 — 장부에 없지만 draft 는 있다. 빈 workspace 가 "초안" 의 표식이다
  const selected: Pkg | null =
    installed ??
    (sel && drafts.some((d) => d.name === sel)
      ? { name: sel, path: "", workspace: "", ring: null, model: null, harness: null, manifest: null, error: null }
      : null);
  const item = nav?.items.find((i) => i.pkg === sel) ?? null;

  // 상세의 깊이 이동 — p·face 는 지키고 sec·item·file 만 바꾼다 (스튜디오의 nav 와 같은 규칙)
  const goView = useCallback(
    (q: { sec?: string | null; item?: string | null; file?: string | null }) => {
      const p = new URLSearchParams({ p: sel ?? "", face: "detail" });
      const s = q.sec === undefined ? view.sec : q.sec;
      const it = q.item === undefined ? view.item : q.item;
      const f = q.file === undefined ? view.file : q.file;
      if (s) p.set("sec", s);
      if (s && it) p.set("item", it);
      if (f) p.set("file", f);
      router.push(`/?${p.toString()}`);
    },
    [router, sel, view],
  );

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
            view={view}
            nav={goView}
            onChanged={() => void load()}
            onGone={() => { void load(); router.push("/"); }}
          />
        ) : loaded ? (
          <section className="pane">
            <header className="pane-head"><h2>없는 패키지</h2><span className="meta mono">{sel}</span></header>
            <div className="pane-body">
              <div className="rc-card pad">
                <p className="hint">장부에 이 이름의 설치가 없습니다. 제거되었거나 주소가 낡았습니다.</p>
                <div className="detail-foot"><Button variant="outline" size="sm" nativeButton={false} render={<a href="/" />}>홈으로</Button></div>
              </div>
            </div>
          </section>
        ) : (
          <div className="pane-body center"><span className="rc-ring" /></div>
        )
      ) : (
        <SettingsPane reg={reg} edges={edges} onChanged={() => void load()} />
      )}

      <ChatNudge /> {/* 말풍선 */}
    </div>
  );
}
