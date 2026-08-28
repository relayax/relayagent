// credential.ts — 서비스 자격의 칸(services[].auth.fields)과 vault 값 사이의 조립·해체.
//
// 한 벌뿐이다: 넣는 쪽(연결 화면·relay connect → assembleCredential)과 쓰는 쪽(기판이 헤더를 붙이는
// tokenOf, 동사가 비밀 아닌 칸을 읽는 publicFields)이 같은 규칙을 지나야 "연결 화면에 넣은 값이
// 동사에서는 다른 뜻" 이 생기지 않는다. 조립 규칙의 정본은 relay.manifest.yaml 이다 —
// 전부 key 있으면 JSON 객체, key 없는 하나(또는 칸 미선언)면 문자열 하나.
//
// 비밀의 경계도 여기서 선다. header 칸과 secret 칸은 기판만 본다(헤더 조립·화면 가림). 동사가
// 받는 것은 publicFields 가 걸러 낸 나머지뿐이다 — 자격이 동사의 손을 지나지 않는다는
// verb-contract 의 약속이 칸 단위로 지켜지는 자리다.
import type { AuthDecl, CredentialField } from "../supply/manifest.ts";

/** key 있는 칸 목록 — 없으면 null(자격은 문자열 하나: 칸 미선언 또는 key 없는 칸 하나) */
export function keyedFields(auth: AuthDecl | undefined): CredentialField[] | null {
  const f = auth?.fields;
  if (!f?.length || f.some((x) => x.key == null)) return null;
  return f;
}

/** Authorization 으로 나갈 칸의 key — 판정(manifest.ts judgeFields)이 정확히 하나를 보장한다 */
export function headerKey(auth: AuthDecl | undefined): string | null {
  return keyedFields(auth)?.find((f) => f.header)?.key ?? null;
}

/** vault 값 → 헤더에 넣을 토큰. keyed 면 JSON 의 header 칸, 아니면 값 그대로. 없으면 null */
export function tokenOf(auth: AuthDecl | undefined, raw: string | null): string | null {
  if (!raw) return null;
  const hk = headerKey(auth);
  if (!hk) return raw;
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>)[hk];
    return typeof v === "string" && v ? v : null;
  } catch {
    // 칸을 선언한 뒤 옛 문자열 자격이 남은 경우 — 헤더를 지어내지 않는다. 다시 연결해야 한다
    return null;
  }
}

/** 동사가 읽어도 되는 칸 — header 도 secret 도 아닌 key 있는 칸만. 자격이 없으면 빈 객체 */
export function publicFields(auth: AuthDecl | undefined, raw: string | null): Record<string, string | string[]> {
  const fields = keyedFields(auth);
  if (!fields || !raw) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: Record<string, string | string[]> = {};
  for (const f of fields) {
    if (f.header || f.secret) continue;
    const v = obj[f.key!];
    if (typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))) out[f.key!] = v as string | string[];
  }
  return out;
}

/**
 * 화면·CLI 가 받은 칸 값을 vault 에 앉힐 문자열로 조립한다. 필수 칸(required, 그리고 header 는
 * 언제나)이 비면 조립하지 않고 빈 칸의 이름을 돌려준다 — 반쪽 자격이 조용히 앉으면 "연결됨" 인데
 * 401 이 나는 상태가 된다. 문자열 자격(칸 미선언·key 없는 칸)은 values.token 하나를 본다.
 */
export function assembleCredential(
  fields: CredentialField[] | undefined,
  values: Record<string, string | undefined>,
): { ok: true; value: string } | { ok: false; missing: string[] } {
  const bare = !fields?.length || fields.some((f) => f.key == null);
  if (bare) {
    const v = (values.token ?? "").trim();
    return v ? { ok: true, value: v } : { ok: false, missing: [fields?.[0]?.label ?? "토큰"] };
  }
  const missing: string[] = [];
  const out: Record<string, string | string[]> = {};
  for (const f of fields!) {
    const raw = (values[f.key!] ?? "").trim();
    if (!raw) {
      if (f.required || f.header) missing.push(f.label);
      continue;
    }
    out[f.key!] = f.list ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw;
  }
  return missing.length ? { ok: false, missing } : { ok: true, value: JSON.stringify(out) };
}
