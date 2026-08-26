"use client";

import { useEffect, useState } from "react";
import DetailFace from "@/components/DetailFace";
import { channelStatus, serviceStatus, type ChannelStatusView, type ServiceStatusView, type ShellItem } from "@/lib/api";
import { residentDecls } from "@/lib/faces";
import type { EdgeView, Pkg, Registry } from "@/lib/types";
import type { Nav, View } from "@/lib/useDraft";

// 기판이 서빙할 문서가 없는 얼굴의 자리. 화면·대화는 기판이 직접 문서를 내므로 사이드바가
// 그리로 곧장 가고, 여기 오지 않는다. 남는 것은 둘이다:
//   상주 — 무엇이 돌기로 되어 있고 지금 떠 있는가
//   상세 — 권한 화면(내놓는 것 / 쓰는 앱 / 쓰는 것 / 제거)
type Tab = "live" | "detail";

export default function PkgPane({
  pkg,
  reg,
  edges,
  running,
  item,
  face,
  view,
  nav,
  onFace,
  onChanged,
  onGone,
}: {
  pkg: Pkg;
  reg: Registry;
  edges: EdgeView[];
  running: string[];
  /** 기판이 준 이 패키지의 얼굴들 — 판정은 여기서 다시 하지 않는다 */
  item: ShellItem | null;
  face: string | null;
  /** 상세의 깊이(sec · item · file) — URL 이 정본 */
  view: View;
  nav: Nav;
  onFace: (face: Tab) => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const m = pkg.manifest;
  const hasLive = item ? item.faces.includes("live") : residentDecls(m).channels.length > 0;
  const tabs: Tab[] = [...(hasLive ? (["live"] as Tab[]) : []), "detail"];
  // 주소에 없는 얼굴로는 앉지 않는다 — 패키지를 갈아타도 직전 패키지에만 있던 탭이 남지 않는다
  const tab: Tab = tabs.includes(face as Tab) ? (face as Tab) : tabs[0];
  // 설치 안 된 초안은 장부에 이름이 없다 — 상세가 draft 를 열어 알려 준다
  const [title, setTitle] = useState<{ display: string | null; live: string | null; draft: string | null } | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const ghost = pkg.workspace === "";

  return (
    <section className="pane">
      <header className="pane-head">
        {item?.icon ? <img className="p-ic" src={item.icon} alt="" /> : <span className="p-ic ltr">{(pkg.name[0] ?? "?").toUpperCase()}</span>}
        <h2>{m?.display_name ?? title?.display ?? pkg.name}</h2>
        <span className="meta mono">
          {ghost
            ? `미발행${title?.draft ? ` · 초안 v${title.draft}` : ""}`
            : `${m?.name ?? pkg.name}@${m?.version ?? "?"}${title?.draft && title.draft !== title.live ? ` · 초안 v${title.draft}` : ""}`}
          {pkg.ring === 0 ? " · ring-0" : ""}
        </span>
        <span ref={setSlot} className="pane-actions" />
        <div className="right">
          {tabs.length > 1 ? (
            <div className="seg" role="group" aria-label="얼굴 전환">
              {tabs.map((t) => (
                <button key={t} type="button" aria-pressed={tab === t} onClick={() => onFace(t)}>
                  {t === "live" ? "상주" : "상세"}
                </button>
              ))}
            </div>
          ) : null}
          {/* 기판이 서빙하는 주소라 <a> 가 맞다(basePath 를 붙이면 안 된다) */}
          {item?.view ? <a className="rc-btn accent" href={item.view}>화면 열기</a> : null}
        </div>
      </header>

      {pkg.error ? <div className="banner">검사 실패: {pkg.error}</div> : null}

      {tab === "live" ? <LiveFace pkg={pkg} running={running} /> : null}
      {tab === "detail" ? (
        <DetailFace pkg={pkg} reg={reg} edges={edges} view={view} nav={nav} onChanged={onChanged} onGone={onGone} onTitle={setTitle} actionsSlot={slot} />
      ) : null}
    </section>
  );
}

// ── 상주 ────────────────────────────────────────────────────────────────────
// 선언(무엇이 돌기로 되어 있나)과 실상(지금 떠 있나)을 나란히 놓는다. 조작(자격 연결·재기동)은
// 여기 없다 — 사용과 관리의 분리, 조작은 설정이 소유한다
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
    <div className="pane-body">
      {decls.triggers.length ? (
        <div className="rc-card pad">
          <h3>스케줄</h3>
          <p className="hint">이 패키지가 스스로 도는 시각 — 매니페스트 triggers 선언 그대로</p>
          {decls.triggers.map((t) => (
            <div className="row" key={t.id}>
              <b className="grow">{t.id}</b>
              <span className="mono soft">{t.when.cron ? `${t.when.cron}${t.when.tz ? ` · ${t.when.tz}` : ""}` : t.when.event ?? "—"}</span>
              <span className="rc-chip gray">{t.then.script ? `script: ${t.then.script}` : t.then.agent ? `agent: ${t.then.agent}` : "—"}</span>
            </div>
          ))}
        </div>
      ) : null}

      {decls.channels.length ? (
        <div className="rc-card pad">
          <h3>채널 (외부 대화 수신)</h3>
          {decls.channels.map((c) => {
            const st = chans?.find((x) => x.name === c.name);
            const chip = !st
              ? { cls: "rc-chip gray", label: "확인 중" }
              : !st.hasCred
                ? { cls: "rc-chip gray", label: "자격 없음" }
                : st.lastError
                  ? { cls: "rc-chip err", label: "오류" }
                  : st.running
                    ? { cls: "rc-chip", label: "연결됨" }
                    : { cls: "rc-chip gray", label: "저장됨" };
            return (
              <div className="row" key={c.name}>
                <b className="grow">{c.name}</b>
                {st?.lastError ? <span className="mono soft ellipsis" title={st.lastError}>{st.lastError}</span> : null}
                <span className={chip.cls}>{chip.label}</span>
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
              <span className="rc-chip gray">{s.dockerfile ? "container" : s.dir ? "dir" : "process"}</span>
              <span className={running.includes(`${pkg.name}/${s.name}`) ? "rc-chip" : "rc-chip gray"}>
                {running.includes(`${pkg.name}/${s.name}`) ? "도는 중" : "멈춤"}
              </span>
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
              <span className={s.kind === "none" || s.hasCred ? "rc-chip" : "rc-chip gray"}>
                {s.kind === "none" ? "자격 불요" : s.hasCred ? "연결됨" : "자격 없음"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── 상세 = 권한 화면 ────────────────────────────────────────────────────────
// 전화기 앱 권한 화면의 문법: "이 앱이 내놓는 것" / "이 앱을 쓰는 앱" 두 목록. 제거 버튼 옆에
// 역의존이 보이므로 "지우면 뭐가 멈추나"가 자명하다. 그래프(지도)는 관리자용이라 설정에 있다
