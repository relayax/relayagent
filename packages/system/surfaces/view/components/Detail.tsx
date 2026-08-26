"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { approveGrant, channelStatus, short, type ChannelStatusView } from "@/lib/api";
import type { EdgeView, Pkg } from "@/lib/types";

function Rows({ children }: { children: React.ReactNode[] }) {
  if (!children.length) return <div className="row none">없음</div>;
  return <>{children}</>;
}

export default function Detail({ pkg, edges, onChanged, onClose }: { pkg: Pkg; edges: EdgeView[]; onChanged: () => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const m = pkg.manifest ?? {};
  const mine = edges.filter((e) => e.consumer === pkg.name);

  // 채널 운영 상태 — 선언(매니페스트)이 아니라 지금 살아있는지. 조작은 그래프 배지의 다이얼로그가 소유
  const [chans, setChans] = useState<ChannelStatusView[] | null>(null);
  useEffect(() => {
    if (!m.surfaces?.channels?.length) return;
    let live = true;
    channelStatus(pkg.name).then((r) => { if (live) setChans(r.channels); }).catch(() => { if (live) setChans([]); });
    return () => { live = false; };
  }, [pkg.name, m.surfaces?.channels?.length]);

  async function approve(e: EdgeView) {
    setError(null);
    try {
      await approveGrant({ consumer: e.consumer, provider: e.provider!, tools: e.tools, mission: e.mission });
      onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <div className="rc-card detail" style={{ position: "relative" }}>
      <button
        onClick={onClose}
        title="닫기"
        style={{
          position: "absolute", top: 10, right: 10, width: 26, height: 26, lineHeight: "24px",
          border: "1px solid var(--rc-line)", borderRadius: 8, background: "var(--rc-bg)",
          color: "var(--rc-soft)", font: "600 14px var(--rc-sans)", cursor: "pointer", padding: 0,
        }}
      >
        ×
      </button>
      <h2>{m.display_name ?? pkg.name}</h2>
      <div className="lineage">
        {m.name ?? "?"}@{m.version ?? "?"} · workspace {pkg.workspace}
        {pkg.ring === 0 ? " · ring-0" : ""}
      </div>
      <div>{m.description ?? ""}</div>
      {pkg.error ? <div className="banner">검사 실패: {pkg.error}</div> : null}
      {error ? <div className="banner">{error}</div> : null}

      <section style={{ display: "flex", gap: 8 }}>
        {/* 대화 문은 착지 에이전트의 실재에서 나온다 — 기판 serveView 의 폴백 판정과 같은 규칙 */}
        {(m.surfaces?.view || (m.agents ?? []).length > 0) &&
        !(typeof window !== "undefined" && window.location.pathname.startsWith(`/pkg/${pkg.name}/view`)) ? (
          <a className="rc-btn accent" style={{ textDecoration: "none" }} href={`/pkg/${pkg.name}/view/`} target="_blank" rel="noreferrer">
            {m.surfaces?.view ? "새 탭에서 확인하기" : "대화하러 가기"}
          </a>
        ) : null}
        {/* 앱 내부 경로는 반드시 Link 로 — 생짜 <a> 는 basePath(/pkg/<이름>/view) 가 안 붙어 기판 404 로 샌다.
            위 새 탭 링크는 기판이 직접 서빙하는 경로라 <a> 가 맞다 */}
        <Link className="rc-btn" style={{ textDecoration: "none" }} href={`/?p=${encodeURIComponent(pkg.name)}&face=detail`}>
          스튜디오에서 편집
        </Link>
        <button
          className="rc-btn"
          title={`${pkg.workspace} 폴더를 파일 탐색기로 엽니다`}
          onClick={() => {
            void fetch(`/pkg/${pkg.name}/workspace/open`, { method: "POST" }).catch(() => {});
          }}
        >
          데이터 폴더 열기
        </button>
      </section>

      <section>
        <div className="rc-label">에이전트</div>
        <Rows>
          {(m.agents ?? []).map((a) => (
            <div className="row" key={a.name}>
              <span className="grow">{a.name}</span>
              {a.name === short(m.name) ? <span className="rc-chip">착지</span> : <span className="rc-chip gray">sub</span>}
              {(a.scripts ?? []).length ? (
                <span style={{ font: "11px var(--rc-mono)", color: "var(--rc-faint)" }}>{a.scripts!.join(" ")}</span>
              ) : null}
            </div>
          ))}
        </Rows>
      </section>

      <section>
        <div className="rc-label">서비스</div>
        <Rows>
          {(m.services ?? []).map((s) => (
            <div className="row" key={s.name}>
              <span className="grow">{s.name}</span>
              <span className="rc-chip gray">{s.url ? "url" : s.dir ? "dir" : s.dockerfile ? "container" : "process"}</span>
            </div>
          ))}
        </Rows>
      </section>

      {m.surfaces?.channels?.length ? (
        <section>
          <div className="rc-label">채널 (외부 대화)</div>
          <Rows>
            {(m.surfaces.channels ?? []).map((c) => {
              const st = chans?.find((x) => x.name === c.name);
              const chip = !st
                ? { cls: "rc-chip gray", label: "확인 중" }
                : !st.hasCred
                  ? { cls: "rc-chip gray", label: "자격 없음" }
                  : st.lastError
                    ? { cls: "rc-chip", label: "오류" }
                    : st.running
                      ? { cls: "rc-chip", label: "연결됨" }
                      : { cls: "rc-chip gray", label: "저장됨" };
              return (
                <div className="row" key={c.name}>
                  <span className="grow">{c.name}</span>
                  <span className={chip.cls}>{chip.label}</span>
                </div>
              );
            })}
          </Rows>
        </section>
      ) : null}

      <section>
        <div className="rc-label">미션 (a2a 수신)</div>
        <Rows>
          {(m.missions ?? []).map((x) => (
            <div className="row" key={x.name}>
              <span className="grow">{x.name}</span>
            </div>
          ))}
        </Rows>
      </section>

      <section>
        <div className="rc-label">연결된 프로그램</div>
        <Rows>
          {mine.map((e, i) => (
            <div className="row" key={`${e.ref}-${i}`}>
              <span className="grow">
                {e.ref}
                {e.mission ? " · " + e.mission : ""}
                {e.tools?.length ? " · " + e.tools.join(",") : ""}
              </span>
              {e.granted ? (
                <span className="rc-chip">활성</span>
              ) : e.provider ? (
                <button className="rc-btn" onClick={() => approve(e)}>
                  연결 승인
                </button>
              ) : (
                <span className="rc-chip gray">provider 미설치</span>
              )}
            </div>
          ))}
        </Rows>
      </section>
    </div>
  );
}
