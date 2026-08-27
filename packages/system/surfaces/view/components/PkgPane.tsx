"use client";

import { useEffect, useRef, useState } from "react";
import { AgentScope } from "@relay/chat";
import DetailFace from "@/components/DetailFace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { channelStatus, serviceStatus, type ChannelStatusView, type ServiceStatusView, type ShellItem } from "@/lib/api";
import { landingAgent, residentDecls } from "@/lib/faces";
import type { EdgeView, Pkg, Registry } from "@/lib/types";
import type { Nav, View } from "@/lib/useDraft";

// 패키지 화면은 세 칸이다 — 고치는 자리·써보는 자리·고쳐달라는 자리가 한 화면에 있어야
// "써보다 → 고쳐달라" 가 돈다:
//   왼쪽   설정 패널 — 설명서·폼 (DetailFace 의 1·2층). 상주 선언(채널·스케줄·서비스)이 있으면
//          설명서 맨 아래에 "실행 현황" 이 접힌 채 붙는다 — 종전의 [구조|상주] 탭은 선언 있는
//          패키지에서만 툭 튀어나와 정체가 안 보였다(2026-08-27)
//   가운데 실제 화면 — /pkg/<이름>/view/ 를 iframe 으로. 화면 없는 대화형 패키지는 기판이 대화
//          폴백 문서를 내므로(view.ts) 착지 에이전트가 있으면 늘 있다. 그 패키지 자신의 채팅
//          위젯은 iframe 이 데려온다
//   오른쪽 빌더 대화 — 콘솔의 도킹 위젯. 이 화면에 들어오면 열어 둔다(열리면 body 폭을 양보하므로
//          겹치지 않고 나란히 선다). 상대는 AgentScope 가 선언한 이 패키지의 빌더
// 고치는 일은 전부 왼쪽 칸 안에서 끝난다(폼 · 결과면 · 파일 에디터). 가운데 실제 화면은 침범하지
// 않는다 — 파일을 열면 왼쪽 칸이 조금 넓어질 뿐이다.
export default function PkgPane({
  pkg,
  reg,
  edges,
  running,
  item,
  view,
  nav,
  onChanged,
  onGone,
}: {
  pkg: Pkg;
  reg: Registry;
  edges: EdgeView[];
  running: string[];
  /** 기판이 준 이 패키지의 얼굴들 — 판정은 여기서 다시 하지 않는다 */
  item: ShellItem | null;
  /** 상세의 깊이(sec · item · file) — URL 이 정본 */
  view: View;
  nav: Nav;
  onChanged: () => void;
  onGone: () => void;
}) {
  const m = pkg.manifest;
  const d = residentDecls(m);
  const hasLive = d.channels.length > 0 || d.triggers.length > 0 || d.services.length > 0;
  // 뷰 탭의 판정은 기판과 같다(shell.ts facesOf: view 또는 chat) — 장부에 없는 초안은 매니페스트로
  const hasView = item ? item.faces.some((f) => f === "view" || f === "chat") : Boolean(m?.surfaces?.view || landingAgent(m));
  // 설치 안 된 초안은 장부에 이름이 없다 — 상세가 draft 를 열어 알려 준다
  const [title, setTitle] = useState<{ display: string | null; live: string | null; draft: string | null } | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // 파일 에디터가 서는 자리 — 가운데 칸. 왼쪽 칸은 목록 그대로, 폭도 그대로(코드가 열린다고 칸이 커지지 않는다)
  const [editorSlot, setEditorSlot] = useState<HTMLElement | null>(null);
  const ghost = pkg.workspace === "";

  // 왼쪽 칸 폭 — 경계를 끌어 조절하고 기억한다(relay-side-w). 기본 360. 파일 에디터가 열리면 CSS 가 넓힌다
  const [sideW, setSideW] = useState(360);
  useEffect(() => { try { const v = Number(localStorage.getItem(SIDE_KEY)); if (v >= SIDE_MIN && v <= SIDE_MAX) setSideW(v); } catch { /* 무시 */ } }, []);
  const cols = useRef<HTMLDivElement>(null);
  const onGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("rc-resizing");
    let w = sideW;
    const move = (ev: PointerEvent) => {
      const left = cols.current?.getBoundingClientRect().left ?? 0;
      w = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(ev.clientX - left)));
      setSideW(w);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("rc-resizing");
      try { localStorage.setItem(SIDE_KEY, String(w)); } catch { /* 무시 */ }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // 세 칸만으로도 복잡한 화면이라 전역 사이드바는 아예 숨긴다(shell.ts relay:shell-fold). 돌아가는
  // 길은 머리의 ← 뒤로. 사람의 접기 선호는 건드리지 않고, 이 화면을 떠나면 셸이 선호로 되돌린다
  useEffect(() => {
    const fold = (hide: boolean) => { try { window.dispatchEvent(new CustomEvent("relay:shell-fold", { detail: { hide } })); } catch { /* 무시 */ } };
    fold(true);
    return () => fold(false);
  }, []);

  // 탑바 한 줄이 화면 끝까지 — 도크는 탑바 아래에서 시작한다(위젯이 --rc-dock-top 을 읽는다).
  // 이 화면을 떠나면 되돌린다(홈·앱 화면에서는 도크가 위까지 올라온다)
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--rc-dock-top", "var(--rc-head-h)");
    return () => { root.style.removeProperty("--rc-dock-top"); };
  }, []);

  // 오른쪽 빌더 대화를 열어 둔다 — 위젯 번들은 async 라 늦게 설 수 있어 전역 표면이 설 때까지
  // 기다린다(shell.ts chatOpen 과 같은 관용구). 대상 지정은 없다: AgentScope 의 선언이
  // 열리는 순간 착지한다(main.tsx pendingScope). 패키지마다 한 번.
  useEffect(() => {
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if ((window as any).RelayChat) {
        try { window.dispatchEvent(new CustomEvent("relay:chat-open", { detail: {} })); } catch { /* 무시 */ }
        return;
      }
      if (++tries > 32) return;
      t = setTimeout(fire, 250);
    };
    fire();
    return () => { if (t) clearTimeout(t); };
  }, [pkg.name]);

  return (
    <section className="pane pkg">
      <header className="pane-head">
        {/* 사이드바가 숨는 화면이라 나가는 문은 여기 하나다 — 셸 홈은 기판 주소라 <a> */}
        <Button variant="ghost" size="icon-sm" className="back" nativeButton={false} render={<a href="/" title="홈으로" />}>←</Button>
        {item?.icon ? <img className="p-ic" src={item.icon} alt="" /> : <span className="p-ic ltr">{(pkg.name[0] ?? "?").toUpperCase()}</span>}
        <h2>{m?.display_name ?? title?.display ?? pkg.name}</h2>
        <span className="meta mono">
          {ghost
            ? `미발행${title?.draft ? ` · 초안 v${title.draft}` : ""}`
            : `${m?.name ?? pkg.name}@${m?.version ?? "?"}${title?.draft && title.draft !== title.live ? ` · 초안 v${title.draft}` : ""}`}
          {pkg.ring === 0 ? " · ring-0" : ""}
        </span>
        <span ref={setSlot} className="pane-actions" />
      </header>

      {pkg.error ? <div className="banner">검사 실패: {pkg.error}</div> : null}

      {/* 페이지 정체성 선언(view-bridge §5) — "이 화면의 대화는 이 패키지의 빌더". 탭 바깥에 두어
          뷰 탭에서도 오른쪽 빌더 대화가 남는다(안쪽 iframe 의 패키지 채팅과는 별개) */}
      <AgentScope agent="agent-builder" param={pkg.name}>
        <div ref={cols} className={`pkg-cols${hasView ? "" : " no-view"}`}>
          <div className="pkg-col side" style={hasView ? { flexBasis: sideW } : undefined}>
            <DetailFace
              pkg={pkg} reg={reg} edges={edges} view={view} nav={nav} onChanged={onChanged} onGone={onGone} onTitle={setTitle}
              actionsSlot={slot} editorSlot={hasView ? editorSlot : null}
              tail={hasLive ? <LiveFace pkg={pkg} running={running} /> : null}
            />
          </div>
          {hasView ? (
            <div className="pkg-col stage">
              <div className="pkg-grip" onPointerDown={onGrip} title="끌어서 폭 조절" />
              {view.file ? <div ref={setEditorSlot} className="pkg-editor" /> : <ViewFace pkg={pkg} item={item} />}
            </div>
          ) : null}
        </div>
      </AgentScope>
    </section>
  );
}

const SIDE_KEY = "relay-side-w";
const SIDE_MIN = 280, SIDE_MAX = 720;

// ── 가운데 화면 ─────────────────────────────────────────────────────────────
// 그 패키지의 화면을 이 자리에 크게 — 기판이 서빙하는 /pkg/<이름>/view/ 를 iframe 으로 든다.
// 안에서는 패키지 자신의 부유 채팅 위젯이 뜨고(회색 상자 안의 "패키지 에이전트 채팅"), 전역
// 사이드바는 top 창이 아니면 서지 않는다(shell.ts SHELL_JS 의 self!==top 게이트).
// 언제나 지금 도는 판이다 — 채팅 수정은 바로 적용되고, 패널 수정은 탑바 [적용] 뒤에 여기 반영된다.
function ViewFace({ pkg, item }: { pkg: Pkg; item: ShellItem | null }) {
  const ghost = pkg.workspace === "";
  const src = item?.view ?? `/pkg/${encodeURIComponent(pkg.name)}/view/`;
  // 언제나 지금 도는 판이다. 채팅으로 고치면 빌더가 바로 적용하므로(바이브 코딩) 이 화면이 곧
  // 새 판이다 — "고친 판 vs 돌아가는 판" 토글은 없앴다. 패널 수정은 탑바 [적용] 뒤에 여기 나타난다.
  if (ghost) {
    return (
      <div className="pane-body">
        <div className="rc-card pad">
          <p className="hint">아직 한 번도 적용한 적이 없어 돌아가는 화면이 없습니다. 오른쪽 빌더에게 만들 것을 말하면 바로 여기 나타납니다.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-body viewface">
      <iframe className="vf-frame" src={src} title={`${pkg.manifest?.display_name ?? pkg.name} 화면`} />
    </div>
  );
}

// ── 실행 현황 ───────────────────────────────────────────────────────────────
// 선언(무엇이 돌기로 되어 있나)과 실상(지금 떠 있나)을 나란히 놓는다. 조작(자격 연결·재기동)은
// 여기 없다 — 사용과 관리의 분리, 조작은 설정이 소유한다. 설명서 맨 아래 접힌 섹션으로 선다
function LiveFace({ pkg, running }: { pkg: Pkg; running: string[] }) {
  const m = pkg.manifest;
  const decls = residentDecls(m);
  const [chans, setChans] = useState<ChannelStatusView[] | null>(null);
  const [svcs, setSvcs] = useState<ServiceStatusView[] | null>(null);

  useEffect(() => {
    let live = true;
    if (decls.channels.length) channelStatus(pkg.name).then((r) => live && setChans(r.channels)).catch(() => live && setChans([]));
    if ((m?.services ?? []).length) serviceStatus(pkg.name).then((r) => live && setSvcs(r.services)).catch(() => live && setSvcs([]));
    return () => { live = false; };
  }, [pkg.name]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <details className="ap-advanced pkg-live">
      <summary>실행 현황 — 채널·스케줄·프로세스가 지금 떠 있는지</summary>
      {decls.triggers.length ? (
        <div className="rc-card pad">
          <h3>스케줄</h3>
          <p className="hint">이 패키지가 스스로 도는 시각 — 매니페스트 triggers 선언 그대로</p>
          {decls.triggers.map((t) => (
            <div className="row" key={t.id}>
              <b className="grow">{t.id}</b>
              <span className="mono soft">{t.when.cron ? `${t.when.cron}${t.when.tz ? ` · ${t.when.tz}` : ""}` : t.when.event ?? "—"}</span>
              <Badge variant="outline">{t.then.script ? `script: ${t.then.script}` : t.then.agent ? `agent: ${t.then.agent}` : "—"}</Badge>
            </div>
          ))}
        </div>
      ) : null}

      {decls.channels.length ? (
        <div className="rc-card pad">
          <h3>채널 (외부 대화 수신)</h3>
          {decls.channels.map((c) => {
            const st = chans?.find((x) => x.name === c.name);
            const chip: { variant: "secondary" | "outline" | "destructive"; label: string } = !st
              ? { variant: "outline", label: "확인 중" }
              : !st.hasCred
                ? { variant: "outline", label: "자격 없음" }
                : st.lastError
                  ? { variant: "destructive", label: "오류" }
                  : st.running
                    ? { variant: "secondary", label: "연결됨" }
                    : { variant: "outline", label: "저장됨" };
            return (
              <div className="row" key={c.name}>
                <b className="grow">{c.name}</b>
                {st?.lastError ? <span className="mono soft ellipsis" title={st.lastError}>{st.lastError}</span> : null}
                <Badge variant={chip.variant}>{chip.label}</Badge>
              </div>
            );
          })}
        </div>
      ) : null}

      {decls.services.length ? (
        <div className="rc-card pad">
          <h3>몸 (이 패키지가 띄우는 프로세스)</h3>
          {decls.services.map((s) => (
            <div className="row" key={s.name}>
              <b className="grow">{s.name}</b>
              <Badge variant="outline">{s.dockerfile ? "container" : s.dir ? "dir" : "process"}</Badge>
              <Badge variant={running.includes(`${pkg.name}/${s.name}`) ? "secondary" : "outline"}>
                {running.includes(`${pkg.name}/${s.name}`) ? "도는 중" : "멈춤"}
              </Badge>
            </div>
          ))}
        </div>
      ) : null}

      {svcs?.length ? (
        <div className="rc-card pad">
          <h3>연결한 문 (밖으로 나가는 서비스)</h3>
          {svcs.map((s) => (
            <div className="row" key={s.name}>
              <b className="grow">{s.name}</b>
              <span className="mono soft ellipsis">{s.url}</span>
              <Badge variant={s.kind === "none" || s.hasCred ? "secondary" : "outline"}>
                {s.kind === "none" ? "자격 불요" : s.hasCred ? "연결됨" : "자격 없음"}
              </Badge>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}

// ── 상세 = 권한 화면 ────────────────────────────────────────────────────────
// 전화기 앱 권한 화면의 문법: "이 앱이 내놓는 것" / "이 앱을 쓰는 앱" 두 목록. 제거 버튼 옆에
// 역의존이 보이므로 "지우면 뭐가 멈추나"가 자명하다. 그래프(지도)는 관리자용이라 설정에 있다
