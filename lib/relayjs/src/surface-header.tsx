// surface-header — 코어 에이전트 뷰의 통일 헤더 스트립 (제목 + 부제 + 버전 + 우측 액션).
// 기존에 연결/triggers/fleet 가 각자 복붙하던 <header> 를 한 곳으로 승격했다 — 복붙이
// 드리프트(meta/monitor/licenses 는 헤더 자체가 없었음)의 원인이었다.
//
// 스타일 계약: view 의 bench.css 는 리포에 Tailwind CLI 가 없어 "동결된 커밋 산출물"이다
// (next build 는 그대로 import 만). 따라서 여기서 Tailwind 유틸리티 클래스를 쓰면 각 패키지
// bench.css 에 그 클래스가 없어 무스타일이 된다. 대신 ChatChrome 과 동일하게 인라인 스타일 +
// shadcn CSS 토큰(var(--background) 등, 8개 패키지 :root 에 전부 존재)으로 그린다 — 어느
// 서피스에 꽂아도 bench.css 재생성 없이 즉시 동작하고 테마(라이트/다크)를 그대로 상속한다.
//
// 버전: 기본값은 빌드가 주입한 NEXT_PUBLIC_RELAY_VERSION(next-preset 이 relay.package.yaml 에서
// 읽어 env 로 심는다). 값이 없으면(일부 프리뷰 빌드 경로) 버전 뱃지만 생략한다.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export interface SurfaceHeaderProps {
  /** 에이전트 이름 — 예: "Datasource". */
  title: string;
  /** 한 줄 부제 — 좁은 폭에서 말줄임. */
  subtitle?: string;
  /** 좌측 아이콘(선택) — @phosphor-icons 노드 등. */
  icon?: ReactNode;
  /** 표시 버전. 미지정 시 빌드 주입값(NEXT_PUBLIC_RELAY_VERSION)을 쓰고, 그마저 없으면 숨긴다. */
  version?: string;
  /** 우측 액션 슬롯 — 새로고침 버튼·MOCK 배지 등 패키지별 요소. */
  children?: ReactNode;
}

// Next 빌드가 정적 치환하는 env — 브라우저 라이브러리라 @types/node 전역을 끌지 않고 국소 선언.
declare const process: { env: Record<string, string | undefined> } | undefined;

const BUILD_VERSION =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_RELAY_VERSION : undefined;

const HEADER_STYLE: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 30,
  display: "flex",
  minHeight: 56,
  flexShrink: 0,
  alignItems: "center",
  gap: 12,
  padding: "0 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--background)",
  // 좁은 폭(모바일 390px)에서 제목+액션이 한 줄을 넘으면 뚫리는 대신 줄바꿈한다.
  flexWrap: "wrap",
};

export function SurfaceHeader({ title, subtitle, icon, version, children }: SurfaceHeaderProps) {
  const shown = version ?? BUILD_VERSION;
  const ver = shown && shown.trim() ? shown.trim() : null;
  // 모바일(<768) — 부제·버전(진단 정보)을 접어 타이틀이 온전히 보이게 한다. 셋을 한 줄에
  // 우겨넣으면 flex 축소가 타이틀을 먼저 잘라("구…") 정체가 사라진다. 인라인 스타일 계약이라
  // 미디어쿼리 대신 matchMedia(SSR 초기값 false — 하이드레이션 후 판정).
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return (
    <header style={HEADER_STYLE}>
      <div style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 10 }}>
        {icon ? (
          <span style={{ flexShrink: 0, display: "inline-flex", color: "var(--muted-foreground)" }} aria-hidden>
            {icon}
          </span>
        ) : null}
        <div style={{ display: "flex", minWidth: 0, alignItems: "baseline", gap: 8 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: "-0.015em",
              color: "var(--foreground)",
              whiteSpace: "nowrap",
              // 부제보다 제목이 먼저 살아남되, 극단적으로 좁으면 말줄임(밀어내기 방지).
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </h1>
          {ver && !mobile ? (
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "var(--muted-foreground)",
                opacity: 0.85,
              }}
              title="설치된 서피스 번들 버전"
            >
              v{ver}
            </span>
          ) : null}
          {subtitle && !mobile ? (
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 14,
                color: "var(--muted-foreground)",
              }}
            >
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      <span style={{ flex: 1 }} />
      {children ? (
        <div style={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 8 }}>{children}</div>
      ) : null}
    </header>
  );
}
