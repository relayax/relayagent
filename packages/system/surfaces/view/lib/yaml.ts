/** 미리보기 전용 최소 직렬화. 정본은 스캐폴드가 쓰는 relay.yaml 이다 */
export function toYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        const inner = toYaml(x, indent + 1);
        return typeof x === "object" && x !== null
          ? pad + "- " + inner.trimStart().replace(/\n/g, "\n  ")
          : pad + "- " + inner.trim();
      })
      .join("\n");
  }
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => {
        if (val && typeof val === "object" && (Array.isArray(val) ? val.length : Object.keys(val).length)) {
          return pad + k + ":\n" + toYaml(val, indent + 1);
        }
        return pad + k + ": " + toYaml(val, 0).trim();
      })
      .join("\n");
  }
  if (typeof v === "string") return /[:#\n"']|^\s|\s$/.test(v) || v === "" ? JSON.stringify(v) : v;
  return String(v);
}
