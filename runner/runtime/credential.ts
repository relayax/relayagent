// credential.ts — 서비스 자격의 칸(services[].auth.fields)과 vault 값 사이의 조립·해체, 그리고 계정 축의 색인.
//
// 한 벌뿐이다: 넣는 쪽(연결 화면·relay connect → assembleCredential)과 쓰는 쪽(기판이 헤더를 붙이는
// tokenOf, 동사가 비밀 아닌 칸을 읽는 publicFields)이 같은 규칙을 지나야 "연결 화면에 넣은 값이
// 동사에서는 다른 뜻" 이 생기지 않는다. 조립 규칙의 정본은 relay.manifest.yaml 이다 —
// 전부 key 있으면 JSON 객체, key 없는 하나(또는 칸 미선언)면 문자열 하나.
//
// 비밀의 경계도 여기서 선다. header 칸과 secret 칸은 기판만 본다(헤더 조립·화면 가림). 동사가
// 받는 것은 publicFields 가 걸러 낸 나머지뿐이다 — 자격이 동사의 손을 지나지 않는다는
// verb-contract 의 약속이 칸 단위로 지켜지는 자리다.
//
// oauth 형의 칸은 인가 번들 안에 `fields` 로 앉는다(oauth.ts OAuthBundle). 인가 흐름이 자격을 만들지만
// 계정 번호·저장소 좌표처럼 로그인이 주지 않는 부속 값이 있고, 그 칸의 어휘와 노출 규칙은 token 형과
// 한 벌이어야 동사가 형을 가리지 않고 fields() 하나를 부른다.
import type { AuthDecl, CredentialField } from "../supply/manifest.ts";
import type { Authority } from "../authority-contract.ts";
import { accountsKey } from "../vault.ts";

/** key 있는 칸 목록 — 없으면 null(자격은 문자열 하나: 칸 미선언 또는 key 없는 칸 하나) */
export function keyedFields(auth: AuthDecl | undefined): CredentialField[] | null {
  const f = auth?.fields;
  if (!f?.length || f.some((x) => x.key == null)) return null;
  return f;
}

/** Authorization 으로 나갈 칸의 key — 판정(manifest.ts judgeFields)이 token 형에 정확히 하나를 보장한다 */
export function headerKey(auth: AuthDecl | undefined): string | null {
  return keyedFields(auth)?.find((f) => f.header)?.key ?? null;
}

/** vault 값 → 자격 값(token 형). keyed 면 JSON 의 header 칸, 아니면 값 그대로. 없으면 null */
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

/** 동사가 읽어도 되는 칸 — header 도 secret 도 아닌 key 있는 칸만. 자격이 없으면 빈 객체.
 *  token 형은 vault 의 JSON 그 자체가 칸이고, oauth 형은 번들의 fields 가 칸이다 */
export function publicFields(auth: AuthDecl | undefined, raw: string | null): Record<string, string | string[]> {
  const fields = keyedFields(auth);
  if (!fields || !raw) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (auth?.kind === "oauth") {
    const inner = (obj as { fields?: unknown }).fields;
    if (!inner || typeof inner !== "object") return {};
    obj = inner as Record<string, unknown>;
  }
  const out: Record<string, string | string[]> = {};
  for (const f of fields) {
    if (f.header || f.secret) continue;
    const v = obj[f.key!];
    if (typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))) out[f.key!] = v as string | string[];
  }
  return out;
}

export type Assembled<T> = { ok: true; value: T } | { ok: false; missing: string[] };

/**
 * 칸 값 → 객체. 필수 칸(required, 그리고 header 는 언제나)이 비면 조립하지 않고 빈 칸의 이름을 돌려준다 —
 * 반쪽 자격이 조용히 앉으면 "연결됨" 인데 401 이 나는 상태가 된다. token 형의 vault 값과 oauth 형의
 * 번들 fields 가 같은 규칙을 지난다
 */
export function assembleFields(fields: CredentialField[], values: Record<string, string | undefined>): Assembled<Record<string, string | string[]>> {
  const missing: string[] = [];
  const out: Record<string, string | string[]> = {};
  for (const f of fields) {
    const raw = (values[f.key!] ?? "").trim();
    if (!raw) {
      if (f.required || f.header) missing.push(f.label);
      continue;
    }
    out[f.key!] = f.list ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw;
  }
  return missing.length ? { ok: false, missing } : { ok: true, value: out };
}

/**
 * 화면·CLI 가 받은 칸 값을 vault 에 앉힐 문자열로 조립한다(token 형). 문자열 자격(칸 미선언·key 없는 칸)은
 * values.token 하나를 본다
 */
export function assembleCredential(
  fields: CredentialField[] | undefined,
  values: Record<string, string | undefined>,
): Assembled<string> {
  const bare = !fields?.length || fields.some((f) => f.key == null);
  if (bare) {
    const v = (values.token ?? "").trim();
    return v ? { ok: true, value: v } : { ok: false, missing: [fields?.[0]?.label ?? "토큰"] };
  }
  const r = assembleFields(fields!, values);
  return r.ok ? { ok: true, value: JSON.stringify(r.value) } : r;
}

// ── 계정 축 ──────────────────────────────────────────────────────────────────
// services[].auth.accounts: true 인 서비스는 자격이 계정마다 하나씩 <pkg>/<service>@<계정> 에 앉는다.
// 열거는 색인(<pkg>/<service>/accounts)이 답한다 — 권위 이음새의 자격 문 셋(credential·setCredential·
// deleteCredential)만 지나므로 조직 기판의 권위 구현도 같은 규칙으로 돈다.

/** 계정 이름의 형 — 좌표에 앉고 화면에 그대로 그려지는 값이라 닫아 둔다(공백·슬래시·@ 없음) */
export const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 계정 이름 판정 — 형이 아니면 사유를 실어 던진다 */
export function judgeAccount(label: unknown): string {
  const v = String(label ?? "").trim();
  if (!ACCOUNT.test(v)) throw new Error(`계정 이름 형식 위반(영문·숫자로 시작, 영문·숫자·._- 64자 이내): ${String(label ?? "")}`);
  return v;
}

export async function listAccounts(credential: (scope: string) => Promise<string | null>, pkg: string, service: string): Promise<string[]> {
  const raw = await credential(accountsKey(pkg, service));
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ACCOUNT.test(x)) : [];
  } catch {
    return [];
  }
}

export async function rememberAccount(authority: Authority, pkg: string, service: string, account: string): Promise<void> {
  const cur = await listAccounts((k) => authority.credential(k), pkg, service);
  if (cur.includes(account)) return;
  await authority.setCredential(accountsKey(pkg, service), JSON.stringify([...cur, account]));
}

/** 색인에서 뺀다 — 마지막 계정이면 색인 자체를 지운다(폐기 문이 없는 권위면 빈 목록으로 적는다) */
export async function forgetAccount(authority: Authority, pkg: string, service: string, account: string): Promise<void> {
  const next = (await listAccounts((k) => authority.credential(k), pkg, service)).filter((a) => a !== account);
  if (next.length || typeof authority.deleteCredential !== "function") {
    await authority.setCredential(accountsKey(pkg, service), JSON.stringify(next));
    return;
  }
  await authority.deleteCredential(accountsKey(pkg, service));
}
