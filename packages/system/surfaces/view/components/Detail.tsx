"use client";

import Link from "next/link";
import { useState } from "react";
import { approveGrant, short } from "@/lib/api";
import type { EdgeView, Pkg } from "@/lib/types";

function Rows({ children }: { children: React.ReactNode[] }) {
  if (!children.length) return <div className="row none">없음</div>;
  return <>{children}</>;
}

export default function Detail({ pkg, edges, onChanged, onClose }: { pkg: Pkg; edges: EdgeView[]; onChanged: () => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const m = pkg.manifest ?? {};
  const mine = edges.filter((e) => e.consumer === pkg.name);

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
      {pkg.error ? <div className="banner">판정 실패: {pkg.error}</div> : null}
      {error ? <div className="banner">{error}</div> : null}

      <section style={{ display: "flex", gap: 8 }}>
        {(m.surfaces?.view || m.surfaces?.chat?.mode === "direct") &&
        !(typeof window !== "undefined" && window.location.pathname.startsWith(`/pkg/${pkg.name}/view`)) ? (
          <a className="rc-btn accent" style={{ textDecoration: "none" }} href={`/pkg/${pkg.name}/view/`} target="_blank" rel="noreferrer">
            {m.surfaces?.view ? "새 탭에서 확인하기" : "대화하러 가기"}
          </a>
        ) : null}
        {/* 앱 내부 경로는 반드시 Link 로 — 생짜 <a> 는 basePath(/pkg/<이름>/view) 가 안 붙어 기판 404 로 샌다.
            위 새 탭 링크는 기판이 직접 서빙하는 경로라 <a> 가 맞다 */}
        <Link className="rc-btn" style={{ textDecoration: "none" }} href={`/studio/?pkg=${encodeURIComponent(pkg.name)}`}>
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
