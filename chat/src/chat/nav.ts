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
}

export interface ShellNav {
  items: ShellItem[];
  home: string;
  importer: string;
  drafts: { name: string; version: string | null; changes: number; empty: boolean; href: string }[];
  store: string | null;
  library: string | null;
  brand?: { name: string; logo: string | null; accent: string | null };
}

export async function fetchNav(): Promise<ShellNav> {
  const r = await fetch("/shell/nav", { cache: "no-store" });
  if (r.ok) return (await r.json()) as ShellNav;
  let msg = "HTTP " + r.status;
  try { const d = await r.json(); if (d && d.error) msg = String(d.error); } catch { /* 본문 없음 */ }
  throw new Error(msg);
}
