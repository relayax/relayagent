// OAuth 2.0 의 RFC 조각 — 기판을 가리지 않는 순수 함수들.
//
// 흐름의 **제어점**은 기판마다 다르다: 1인 기판은 loopback 리다이렉트로 코드를 받고(oauth.ts),
// 조직 기판은 공개 주소의 콜백으로 받아 자기 저장소에 앉힌다. 그러나 디스커버리(RFC 9728 →
// 8414 → OIDC)·동적 등록(RFC 7591)·PKCE(RFC 7636)·코드 교환·회전(RFC 6749 §6)은 어느 기판이든
// 같은 왕복이다. 그것을 여기 한 벌로 두고 두 기판이 같은 함수를 부른다 — 한쪽이 규칙을
// 고치면(예: 새 디스커버리 경로) 다른 쪽도 같이 고쳐진다.
//
// 저장·소비·client 선택(조직 앱 등록·DCR 캐시)은 여기 없다 — 호출자의 몫이다.
import crypto from "node:crypto";

export interface OAuthMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  /** 서버가 더 준 것(scope·token_type 등) — 호출자가 필요하면 본다 */
  [k: string]: unknown;
}

/** 토큰 요청의 방언 — 표준은 form(RFC 6749 §4.1.3). 일부 서버는 JSON 본문을 요구한다 */
export type GrantStyle = "form" | "json";

export interface ClientAuth {
  client_id: string;
  /** confidential client 만 — 없으면 public client(PKCE 가 증명) */
  client_secret?: string;
}

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** PKCE S256 + CSRF state — CSPRNG 만 쓴다(Math.random 은 여기서 보안 버그다) */
export function newPkce(): Pkce {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  return { verifier, challenge, state };
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const hasEndpoints = (m: Partial<OAuthMeta> | null | undefined): m is OAuthMeta =>
  !!m && typeof m.authorization_endpoint === "string" && !!m.authorization_endpoint && typeof m.token_endpoint === "string" && !!m.token_endpoint;

/**
 * 인가 서버 메타 발견 — 선언(auth_meta)이 완전하면 왕복 없이 그것, 아니면 자원 주소에서 사다리로:
 *   ① RFC 9728 `/.well-known/oauth-protected-resource` → authorization_servers[0] 의 8414 메타
 *   ② RFC 8414 `/.well-known/oauth-authorization-server`
 *   ③ OIDC `/.well-known/openid-configuration`
 * 선언이 불완전하면 발견 결과 위에 선언 필드가 이긴다(단일테넌트 IdP 처럼 endpoint 만 바꾸는 경우).
 */
export async function discoverOAuthMeta(
  resourceUrl: string,
  declared?: Partial<OAuthMeta> | null,
  opts: { timeoutMs?: number } = {},
): Promise<OAuthMeta | null> {
  if (hasEndpoints(declared)) return declared;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let origin: string;
  try {
    origin = new URL(resourceUrl).origin;
  } catch {
    return null;
  }
  let found: OAuthMeta | null = null;
  const prm = await getJson<{ authorization_servers?: string[] }>(`${origin}/.well-known/oauth-protected-resource`, timeoutMs);
  const as = prm?.authorization_servers?.find((x) => typeof x === "string" && x);
  if (as) {
    for (const u of [`${trimSlash(as)}/.well-known/oauth-authorization-server`, trimSlash(as)]) {
      const m = await getJson<Partial<OAuthMeta>>(u, timeoutMs);
      if (hasEndpoints(m)) { found = m; break; }
    }
  }
  if (!found) {
    for (const suffix of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const m = await getJson<Partial<OAuthMeta>>(origin + suffix, timeoutMs);
      if (hasEndpoints(m)) { found = m; break; }
    }
  }
  if (!found) return null;
  // 선언 필드 승 — 발견은 빈칸만 채운다
  return { ...found, ...(declared ? Object.fromEntries(Object.entries(declared).filter(([, v]) => typeof v === "string" && v)) : {}) } as OAuthMeta;
}

/** RFC 7591 동적 클라이언트 등록 — public client(token_endpoint_auth_method none). 실패는 null */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  opts: { clientName?: string; scopes?: string[]; timeoutMs?: number } = {},
): Promise<ClientAuth | null> {
  const body: Record<string, unknown> = {
    client_name: opts.clientName ?? "relay",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (opts.scopes?.length) body.scope = opts.scopes.join(" ");
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const j = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
    if (!res.ok || !j.client_id) return null;
    return { client_id: j.client_id, ...(j.client_secret ? { client_secret: j.client_secret } : {}) };
  } catch {
    return null;
  }
}

/** 인가 URL — 표준 파라미터가 이긴다(extra 가 같은 키를 주면 무시). 잘못된 endpoint 는 null */
export function authorizeUrl(
  meta: OAuthMeta,
  p: { clientId: string; redirectUri: string; pkce: Pkce; scopes?: string[]; extra?: Record<string, string> },
): string | null {
  let u: URL;
  try {
    u = new URL(meta.authorization_endpoint);
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(p.extra ?? {})) u.searchParams.set(k, v);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("code_challenge", p.pkce.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", p.pkce.state);
  if (p.scopes?.length) u.searchParams.set("scope", p.scopes.join(" "));
  return u.toString();
}

async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  style: GrantStyle,
  timeoutMs: number,
): Promise<TokenResponse | null> {
  try {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers:
        style === "json"
          ? { "content-type": "application/json", accept: "application/json" }
          : { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: style === "json" ? JSON.stringify(params) : new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json().catch(() => null)) as TokenResponse | null;
    // 상태코드가 아니라 access_token 의 유무가 판정이다 — 오류 본문에도 JSON 이 실린다
    return j && typeof j.access_token === "string" && j.access_token ? j : null;
  } catch {
    return null;
  }
}

/** authorization_code 교환 — redirect_uri 는 인가 때와 바이트 동일해야 한다 */
export function exchangeCode(
  tokenEndpoint: string,
  p: { code: string; redirectUri: string; client: ClientAuth; codeVerifier: string; style?: GrantStyle; timeoutMs?: number },
): Promise<TokenResponse | null> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.client.client_id,
    code_verifier: p.codeVerifier,
  };
  if (p.client.client_secret) params.client_secret = p.client.client_secret;
  return tokenRequest(tokenEndpoint, params, p.style ?? "form", p.timeoutMs ?? 20_000);
}

/**
 * 토큰으로 토큰을 받는 왕복 — 표준 밖의 두 방언이 같은 모양이다: 교환 직후 단기 토큰을 장기 토큰으로
 * 바꾸는 것(메타 계열 `ig_exchange_token`)과 refresh_token 없이 access_token 으로 회전하는 것
 * (`ig_refresh_token`). 둘 다 GET <endpoint>?<params>&access_token=<토큰>[&client_secret=<비밀>] 이고
 * 답은 표준 토큰 응답의 부분집합({access_token, expires_in?})이다. 선언(auth_meta.exchange_*·refresh_*)이
 * 주소와 고정 파라미터를 주고, 여기는 왕복만 한다
 */
export async function tokenByToken(
  endpoint: string,
  p: { accessToken: string; params?: Record<string, string>; clientSecret?: string; timeoutMs?: number },
): Promise<TokenResponse | null> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(p.params ?? {})) u.searchParams.set(k, v);
  if (p.clientSecret) u.searchParams.set("client_secret", p.clientSecret);
  u.searchParams.set("access_token", p.accessToken);
  try {
    const res = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(p.timeoutMs ?? 20_000) });
    const j = (await res.json().catch(() => null)) as TokenResponse | null;
    return j && typeof j.access_token === "string" && j.access_token ? j : null;
  } catch {
    return null;
  }
}

/** refresh_token 회전 — 새 refresh 가 안 오면 호출자가 옛것을 유지한다(회전-비발급 서버) */
export function refreshToken(
  tokenEndpoint: string,
  p: { refreshToken: string; client: ClientAuth; style?: GrantStyle; timeoutMs?: number },
): Promise<TokenResponse | null> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
    client_id: p.client.client_id,
  };
  if (p.client.client_secret) params.client_secret = p.client.client_secret;
  return tokenRequest(tokenEndpoint, params, p.style ?? "form", p.timeoutMs ?? 20_000);
}
