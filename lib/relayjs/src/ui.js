// ui.js — 최소 어휘. relayjs 는 앱의 스타일링을 소유하지 않는다("자유는 내부") — cn 하나만.
// cn 은 tailwind 충돌 병합(후자 승)을 내장한다 — shadcn 계열 소품이 기본 클래스를 variant 로
// 덮는 관용(CardHeader flex-col→flex-row 등)이 컴파일된 CSS 규칙 순서와 무관하게 성립해야
// 앱마다 로컬 cn 사본(예외)이 생기지 않는다. 비-tailwind 클래스는 그대로 통과(상위집합).
// org 기판 lib/relayjs/src/ui.ts 와 동일 구현(플레인 JS 판) — relayjs 코어 승격(view 정합
// V2) 때 TS 원본이 이 파일을 대체한다.
import { twMerge } from "tailwind-merge";

function walk(v, out) {
  if (!v && v !== 0) return;
  if (typeof v === "string" || typeof v === "number") { out.push(String(v)); return; }
  if (Array.isArray(v)) { for (const x of v) walk(x, out); return; }
  if (typeof v === "object") {
    for (const k of Object.keys(v)) if (v[k]) out.push(k);
  }
}

export function cn(...inputs) {
  const out = [];
  for (const v of inputs) walk(v, out);
  return twMerge(out.join(" "));
}
