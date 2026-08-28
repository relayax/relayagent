// nav.ts — /shell/nav 응답의 모양(runner/runtime/shell.ts ShellNav 의 사본). 번들이 별개라
// runner 를 임포트하지 않는다 — 필드가 바뀌면 양쪽을 같이 고친다.
export type Face = "view" | "chat" | "live" | "parts";

export interface ShellItem {
  pkg: string;
  label: string;
  description: string;
  version: string;
  icon: string | null;
  face: Face;
  faces: Face[];
  href: string;
  view: string | null;
  detail: string;
  resident: boolean;
  ring0: boolean;
  error: string | null;
  update: string | null;
  editing: boolean;
  /** 선언된 사이드바 자리(shell.nav) — 판정은 parent·hidden 이 끝냈다 */
  nav: "auto" | "always" | "never";
  /** 이 패키지의 components 를 결재해 마운트하는 설치본들 — 사이드바가 이 항목을 그 밑으로 접는 근거 */
  mounted_in: string[];
  /** 접힐 자리(기판 판정). null = 최상위 */
  parent: string | null;
  /** 목록에 서지 않는다(shell.nav: never) */
  hidden: boolean;
}

export interface ShellNav {
  items: ShellItem[];
  home: string;
  importer: string;
  drafts: { name: string; version: string | null; changes: number; empty: boolean; href: string }[];
  store: string | null;
  library: string | null;
  /** 연결 화면 — 설치된 것 전부의 자격 전경(콘솔 페이지). 주소는 기판이 싣는다 */
  connections: string;
  /** 신경 쓸 수 — 필수인데 빈 서비스 자격 + 빈 채널 자격. 홈 배너와 사이드바 배지가 같은 수를 읽는다 */
  attention: { credentials: number };
  /** 사람이 얹은 폴더(묶음) — 사이드바가 그린다. 홈은 읽지 않는다 */
  suites: { name: string; label: string; hub: string | null; members: string[] }[];
  brand?: { name: string; logo: string | null; accent: string | null };
}

export async function fetchNav(): Promise<ShellNav> {
  const r = await fetch("/shell/nav", { cache: "no-store" });
  if (r.ok) return (await r.json()) as ShellNav;
  let msg = "HTTP " + r.status;
  try { const d = await r.json(); if (d && d.error) msg = String(d.error); } catch { /* 본문 없음 */ }
  throw new Error(msg);
}
