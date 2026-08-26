import { SECTIONS } from "./sections";

/** 판정 좌표(relay.yaml 경로) → 고치는 자리. 최상위 키가 곧 섹션이고 둘째 조각이 항목이다.
 *  판정은 원인만 말하므로 화면이 문을 붙인다 — 좌표가 있을 때만 */
const IDENTITY_KEYS = new Set(["schema", "name", "version", "display_name", "description", "icon", "publisher", "released_at"]);

export function fixTargetOf(path: string | null): { sec: string; item: string | null; label: string } | null {
  if (!path) return null;
  const [first, second] = path.split(".");
  const def = IDENTITY_KEYS.has(first) ? SECTIONS.find((d) => d.key === "identity") : SECTIONS.find((d) => d.yamlKey === first || d.key === first);
  if (!def) return null;
  const item = second && def.items ? second.replace(/\[.*$/, "") : null;
  return { sec: def.key, item: item || null, label: `고치러 가기 → ${def.label}${item ? ` · ${item}` : ""}` };
}
