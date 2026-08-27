import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// draft-icon 이 고르는 낱장 SVG 의 목록 — 화면의 선택창이 이것으로 격자를 그린다.
// 이름은 코드포인트(u1F4D2)뿐이다: Tossface 는 글자 이름을 싣지 않는다
const GLYPHS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "tossface");

export const meta = {
  description: "패키지 아이콘으로 고를 수 있는 Tossface 그림 전부. 각 항목은 코드포인트 이름(u1F4D2) — 그림은 /pkg/system/asset/assets/tossface/<이름>.svg 로 본다",
  input: { type: "object", additionalProperties: false, properties: {} },
};

export default async function () {
  const glyphs = fs
    .readdirSync(GLYPHS)
    .filter((f) => /^u[0-9A-F]+(_u[0-9A-F]+)*\.svg$/.test(f))
    .map((f) => f.slice(0, -4))
    .sort((a, b) => parseInt(a.slice(1), 16) - parseInt(b.slice(1), 16));
  return { glyphs };
}
