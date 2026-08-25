"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  approveGrant,
  channelStatus,
  removePkg,
  serviceStatus,
  type ChannelStatusView,
  type ServiceStatusView,
  type ShellItem,
} from "@/lib/api";
import { landingAgent, residentDecls } from "@/lib/faces";
import type { EdgeView, Pkg, Registry } from "@/lib/types";

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
  onFace: (face: Tab) => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const m = pkg.manifest;
  const hasLive = item ? item.faces.includes("live") : residentDecls(m).channels.length > 0;
  const tabs: Tab[] = [...(hasLive ? (["live"] as Tab[]) : []), "detail"];
  // 주소에 없는 얼굴로는 앉지 않는다 — 패키지를 갈아타도 직전 패키지에만 있던 탭이 남지 않는다
  const tab: Tab = tabs.includes(face as Tab) ? (face as Tab) : tabs[0];

  return (
    <section className="pane">
      <header className="pane-head">
        {item?.icon ? <img className="p-ic" src={item.icon} alt="" /> : <span className="p-ic ltr">{(pkg.name[0] ?? "?").toUpperCase()}</span>}
        <h2>{m?.display_name ?? pkg.name}</h2>
        <span className="meta mono">
          {m?.name ?? pkg.name}@{m?.version ?? "?"}
          {pkg.ring === 0 ? " · ring-0" : ""}
        </span>
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
      {tab === "detail" ? <DetailFace pkg={pkg} reg={reg} edges={edges} onChanged={onChanged} onGone={onGone} /> : null}
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
function DetailFace({
  pkg,
  reg,
  edges,
  onChanged,
  onGone,
}: {
  pkg: Pkg;
  reg: Registry;
  edges: EdgeView[];
  onChanged: () => void;
  onGone: () => void;
}) {
  const m = pkg.manifest;
  const mine = edges.filter((e) => e.consumer === pkg.name); // 이 앱이 쓰는 것
  const users = edges.filter((e) => e.provider === pkg.name); // 이 앱을 쓰는 앱 — 소비자 역색인
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const label = useCallback(
    (name: string) => reg.packages.find((p) => p.name === name)?.manifest?.display_name ?? name,
    [reg],
  );

  async function approve(e: EdgeView) {
    setError(null);
    try {
      await approveGrant({ consumer: e.consumer, provider: e.provider!, tools: e.tools, mission: e.mission });
      onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await removePkg(pkg.name);
      onGone();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    }
  }

  const outward = (m?.services ?? []).filter((s) => s.url != null || s.api != null);

  return (
    <div className="pane-body">
      {m?.description ? <p className="lede">{m.description}</p> : null}
      {error ? <div className="banner">{error}</div> : null}

      <div className="detail-grid">
        <div className="rc-card pad">
          <h3>이 앱이 내놓는 것</h3>
          <p className="hint">다른 앱이 빌려 쓸 수 있는 문과, 사람이 말을 거는 창구</p>
          {(m?.missions ?? []).map((x) => (
            <div className="cap-row" key={`m-${x.name}`}>
              <span className="mono">{x.name}</span>
              <span className="why">{x.description ?? "a2a 미션"}</span>
            </div>
          ))}
          {outward.flatMap((s) => (s.tools ?? []).map((t) => (
            <div className="cap-row" key={`t-${s.name}-${t}`}>
              <span className="mono">{t}</span>
              <span className="why">{s.name} 도구</span>
            </div>
          )))}
          {(m?.surfaces?.channels ?? []).map((c) => (
            <div className="cap-row" key={`c-${c.name}`}>
              <span className="mono">{c.name}</span>
              <span className="why">멘션·DM 이 대화로 들어옴</span>
            </div>
          ))}
          {(m?.agents ?? []).map((a) => (
            <div className="cap-row" key={`a-${a.name}`}>
              <span className="mono">{a.name}</span>
              <span className="why">{a.name === landingAgent(m) ? "착지 — 대화의 문" : "sub 에이전트"}</span>
            </div>
          ))}
          {!(m?.missions ?? []).length && !outward.length && !(m?.surfaces?.channels ?? []).length && !(m?.agents ?? []).length ? (
            <div className="row none">없음</div>
          ) : null}
        </div>

        <div className="rc-card pad">
          <h3>이 앱을 쓰는 앱</h3>
          <p className="hint">지우면 여기 있는 앱들이 함께 멈춥니다</p>
          {users.length ? (
            users.map((e, i) => (
              <div className="cap-row" key={`u-${e.consumer}-${i}`}>
                <b>{label(e.consumer)}</b>
                <span className="why">
                  {e.mission ? `미션 ${e.mission}` : e.tools?.length ? e.tools.join(", ") : "연결"}
                  {e.granted ? "" : " · 미결재"}
                </span>
              </div>
            ))
          ) : (
            <div className="row none">없음</div>
          )}
        </div>

        <div className="rc-card pad span2">
          <h3>이 앱이 쓰는 것</h3>
          <p className="hint">선언은 캡, 승인은 대장 — 결재된 것만 세션에 실립니다</p>
          {mine.length ? (
            mine.map((e, i) => (
              <div className="row" key={`e-${e.ref}-${i}`}>
                <span className="grow">
                  {e.provider ? label(e.provider) : e.ref}
                  {e.mission ? ` · 미션 ${e.mission}` : ""}
                  {e.tools?.length ? ` · ${e.tools.join(", ")}` : ""}
                </span>
                {e.granted ? (
                  <span className="rc-chip">활성</span>
                ) : e.provider ? (
                  <button className="rc-btn" type="button" onClick={() => approve(e)}>연결 승인</button>
                ) : (
                  <span className="rc-chip gray">provider 미설치</span>
                )}
              </div>
            ))
          ) : (
            <div className="row none">없음</div>
          )}
        </div>
      </div>

      <div className="detail-foot">
        <Link className="rc-btn" href={`/studio/?pkg=${encodeURIComponent(pkg.name)}`}>스튜디오에서 편집</Link>
        <button
          className="rc-btn"
          type="button"
          title={`${pkg.workspace} 폴더를 파일 탐색기로 엽니다`}
          onClick={() => { void fetch(`/pkg/${encodeURIComponent(pkg.name)}/workspace/open`, { method: "POST" }).catch(() => {}); }}
        >
          데이터 폴더 열기
        </button>
        <span className="grow" />
        {confirming ? (
          <>
            <span className="warn-text">
              {users.length ? `${users.map((e) => label(e.consumer)).join(", ")} 이(가) 함께 멈춥니다.` : "되돌릴 수 없습니다."}
            </span>
            <button className="rc-btn" type="button" onClick={() => setConfirming(false)} disabled={busy}>취소</button>
            <button className="rc-btn danger" type="button" onClick={() => void remove()} disabled={busy}>
              {busy ? "제거 중…" : "정말 제거"}
            </button>
          </>
        ) : (
          <button className="rc-btn danger" type="button" onClick={() => setConfirming(true)}>제거</button>
        )}
      </div>
    </div>
  );
}
