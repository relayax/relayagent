// layout.tsx — 페이지 골격 분자. 카탈로그(shadcn)는 원자에서 멈추므로 이 층은 우리 소유다.
// 굳히는 것은 골격의 여백 리듬 하나 — 화면이 여백 값을 고르지 않고 분자를 조립만 하면
// 모든 패키지 화면의 골격이 같은 리듬이 된다. 내용·밀도·도메인 어휘는 화면 소관 그대로.
// 값은 전부 시맨틱 토큰 유틸리티 — 브랜드 리페인트(tokens.css)에 원자와 똑같이 따라온다.
//
// ⚠ 이 파일은 src/ui/(카탈로그 생성물) 밖이다 — `shadcn add --overwrite` 대상이 아니고,
//   카탈로그에 대응물이 없어 충돌하지도 않는다(원자를 우리가 다시 만들면 나중에 카탈로그를
//   받는 순간 같은 일을 하는 두 번째 어휘가 되지만, 골격층은 카탈로그가 애초에 다루지 않는다).
//   언젠가 카탈로그가 같은 골격을 내면 그쪽을 받고 이쪽을 은퇴시킨다 — 어휘는 항상 한 벌.
import * as React from "react";

import { cn } from "@relay/relayjs";

import { Card } from "./ui/card";

/** 페이지 프레임 — 화면 여백·최대 폭의 정본. 모든 화면의 최상위는 이것 하나다. */
function Page({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="page"
      className={cn("mx-auto w-full max-w-6xl p-4 sm:p-6", className)}
      {...props}
    />
  );
}

/** 제목 줄 — 제목·설명·우측 액션(버튼·건수 등). 좁은 폭에서는 액션이 아래로 감싼다. */
function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn("mb-5 flex flex-wrap items-baseline justify-between gap-2", className)}
    >
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** 필터·액션 행 — 검색 Input·Select·버튼이 앉는 자리. 좁은 폭에서는 줄바꿈. */
function Toolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar"
      className={cn("mb-3 flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/** 목록↔상세 — 카드 두 장의 배치까지 소유한다: 넓은 화면은 상세가 옆 패널(w-80),
 *  좁은 화면은 아래로 쌓인다. detail 이 없으면(미선택) 목록 카드만 그린다. */
function ListDetail({
  list,
  detail,
  className,
}: {
  list: React.ReactNode;
  detail?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="list-detail"
      className={cn("flex flex-col gap-4 lg:flex-row lg:items-start", className)}
    >
      <Card className="min-w-0 flex-1 overflow-hidden">{list}</Card>
      {detail != null && <Card className="w-full shrink-0 p-4 lg:w-80">{detail}</Card>}
    </div>
  );
}

/** KPI 타일 컨테이너 — 폰 2열·넓은 화면 4열. 타일 수가 다르면 className 으로 열만 바꾼다. */
function StatRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-row"
      className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}
      {...props}
    />
  );
}

/** KPI 타일 — 라벨·숫자(·보조 한 줄). "매일 보는 숫자"만 올린다. */
function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card data-slot="stat-tile" className={cn("p-4", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint != null && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export { Page, PageHeader, Toolbar, ListDetail, StatRow, StatTile };
