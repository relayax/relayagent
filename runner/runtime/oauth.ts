// 서비스 자격의 소비와 OAuth 커넥터 자격 — 개인 기판의 자기 흐름: PKCE(S256) + DCR(RFC 7591) + 회전(refresh).
// 어휘(auth.kind oauth·client dcr|registered·oauth_client)는 문법에 이미 있었고, 이 파일이
// 그 실행이다. 자격 번들은 vault 에 서비스 소속으로 앉고(access·refresh·만료·client_id), 소비는 요청
// 시점 pull — 만료 60초 전이면 자동 회전한다. env 상주 없음(oauth 는 만료·회전 축이라 env 상주가
// 애초에 성립하지 않는다 — 조직 기판과 같은 결론).
// 브라우저 열기와 client_id 입력은 주입 가능(opts) — 검사·헤드리스가 같은 흐름을 지난다.
// RFC 조각(디스커버리·DCR·PKCE·교환·회전)은 oauth-rfc.ts 가 소유한다 — 여기는 1인 기판의
// 제어점(콜백 수신·vault 저장·화면 흐름)만 든다. 조직 기판은 같은 조각을 자기 제어점에서 부른다.
//
// 콜백은 두 문 중 하나로 온다. 임시 loopback 리스너(RFC 8252 — DCR 처럼 redirect_uri 를 흐름마다 등록하는
// 제공자, 그리고 CLI·검사)와 데몬의 고정 문(GET /oauth/cb — 등록된 앱의 redirect_uri 는 미리 적혀 있어야
// 하므로 주소가 고정이어야 한다. HTTPS 를 요구하는 제공자는 TLS 문이 그 주소가 된다).
//
// 자격이 요청에 실리는 자리도 여기서 정해진다(attachCredential): 헤더(기본)·질의·폼 — 선언(auth.inject)이
// 정하고 동사는 어느 쪽인지 모른다. 계정 축(auth.accounts)은 좌표(credKey 의 account)만 다르고 규칙은 같다.
import http from "node:http";
import { spawn } from "node:child_process";
import { credKey } from "../vault.ts";
import type { Authority } from "../authority-contract.ts";
import type { AuthDecl, OAuthClientDecl } from "../supply/manifest.ts";
import { rememberAccount, tokenOf } from "./credential.ts";
import {
  authorizeUrl,
  discoverOAuthMeta,
  exchangeCode,
  newPkce,
  refreshToken,
  registerClient,
  tokenByToken,
  type OAuthMeta,
  type TokenResponse,
} from "./oauth-rfc.ts";

export interface OAuthBundle {
  access_token: string;
  refresh_token?: string;
  /** epoch ms — 없으면 만료 축 없는 토큰(회전 불필요) */
  expires_at?: number;
  token_endpoint: string;
  client_id: string;
  /** confidential client 의 비밀(등록된 앱이 준다) — 교환·회전 요청에만 실리고 동사에는 절대 가지 않는다 */
  client_secret?: string;
  /** 인가와 함께 받은 부속 칸(auth.fields) — 비밀 아닌 것은 동사가 fields() 로 읽는다(credential.ts publicFields) */
  fields?: Record<string, string | string[]>;
}

/** 메타 해석 — 선언(auth_meta)이 완전하면 그것, 아니면 RFC 9728 → 8414 → OIDC 사다리(oauth-rfc) */
export async function discoverMeta(baseUrl: string, auth: AuthDecl): Promise<OAuthMeta> {
  const declared = auth.oauth_client?.auth_meta as Partial<OAuthMeta> | undefined;
  const meta = await discoverOAuthMeta(baseUrl, declared);
  if (!meta) throw new Error(`OAuth 디스커버리 실패 — auth_meta 에 endpoint 를 명시하세요: ${baseUrl}`);
  return meta;
}

function toBundle(tok: TokenResponse, tokenEndpoint: string, clientId: string, prev?: OAuthBundle): OAuthBundle {
  return {
    access_token: tok.access_token,
    // 회전 시 새 refresh 가 없으면 이전 것을 유지한다(회전-비발급 서버)
    refresh_token: typeof tok.refresh_token === "string" ? tok.refresh_token : prev?.refresh_token,
    expires_at: typeof tok.expires_in === "number" ? Date.now() + tok.expires_in * 1000 : undefined,
    token_endpoint: tokenEndpoint,
    client_id: clientId,
    ...(prev?.client_secret ? { client_secret: prev.client_secret } : {}),
    ...(prev?.fields ? { fields: prev.fields } : {}),
  };
}

/** 콜백 수신의 이음새 — 인가 서버에 적히는 redirect_uri 와, 그 주소로 온 답을 state 로 기다리는 문 */
export interface OAuthRedirect {
  uri: string;
  wait(state: string, timeoutMs: number): Promise<{ code?: string; error?: string }>;
}

/** 임시 loopback 리스너 — 흐름마다 포트 하나(RFC 8252). 흐름이 끝나면 close */
export async function loopbackRedirect(): Promise<OAuthRedirect & { close(): void }> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    uri: `http://127.0.0.1:${port}/cb`,
    wait: (state, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("인가 대기 시간 초과")), timeoutMs);
        server.on("request", (req, res) => {
          const q = new URL(req.url ?? "/", "http://127.0.0.1");
          if (q.pathname !== "/cb") return void res.writeHead(404).end();
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<meta charset='utf-8'>연결되었습니다 — 이 창을 닫아도 됩니다.");
          // state 불일치는 다른 흐름의 응답(CSRF 축) — code 가 있어도 버린다
          if (q.searchParams.get("state") !== state) return;
          clearTimeout(timer);
          resolve({ code: q.searchParams.get("code") ?? undefined, error: q.searchParams.get("error") ?? undefined });
        });
      }),
    close: () => server.close(),
  };
}

// 고정 문(데몬 GET /oauth/cb)으로 오는 답을 기다리는 흐름들 — state 가 열쇠다. 모르는 state 는 받지 않는다:
// 이 문은 아무 웹페이지나 두드릴 수 있으므로(GET) 기다리는 흐름에만 답이 닿아야 한다
const waiting = new Map<string, (r: { code?: string; error?: string }) => void>();

/** 데몬의 고정 콜백 문 — uri 는 제공자에 등록된 값(OAUTH_CALLBACK_URL)과 바이트 동일해야 한다 */
export function fixedRedirect(uri: string): OAuthRedirect {
  return {
    uri,
    wait: (state, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(state);
          reject(new Error("인가 대기 시간 초과"));
        }, timeoutMs);
        waiting.set(state, (r) => {
          clearTimeout(timer);
          waiting.delete(state);
          resolve(r);
        });
      }),
  };
}

/** 고정 문에 답이 왔다 — 기다리던 흐름이 있으면 건네고 true, 없으면 false(문은 404 로 답한다) */
export function receiveOAuthCallback(q: URLSearchParams): boolean {
  const state = q.get("state") ?? "";
  const take = waiting.get(state);
  if (!take) return false;
  take({ code: q.get("code") ?? undefined, error: q.get("error") ?? undefined });
  return true;
}

export interface OAuthFlowOpts {
  /** 인가 URL 을 여는 방법 — 기본은 OS 브라우저. 검사·헤드리스는 fetch 주입 */
  open?: (url: string) => void;
  /** client: registered 의 client_id 공급 — 선언(oauth_client.client_id)이 없을 때만 불린다. 기본은 오류(CLI 가 프롬프트를 주입) */
  clientId?: () => Promise<string>;
  /** confidential client 의 비밀 — 등록된 앱이 준 것. 교환·회전에 실리고 번들에 앉는다 */
  clientSecret?: string;
  /** 인가와 함께 앉힐 부속 칸(auth.fields, 조립된 값) */
  fields?: Record<string, string | string[]>;
  /** 콜백 문 — 미지정이면 임시 loopback 리스너 */
  redirect?: OAuthRedirect;
  /** 인가 대기 상한 ms (기본 5분) */
  timeoutMs?: number;
}

/**
 * 인가 흐름 — 콜백 문으로 code 를 받고 PKCE 로 교환한다. 제공자가 장기 교환 방언(auth_meta.exchange_endpoint)을
 * 선언했으면 교환 직후 한 번 더 왕복해 그 결과로 번들을 짓는다.
 * 반환 번들의 저장은 호출부 소관(startServiceOAuth·CLI 가 vault 에 앉힌다).
 */
export async function runOAuthFlow(serviceUrl: string, auth: AuthDecl, opts: OAuthFlowOpts = {}): Promise<OAuthBundle> {
  const meta = await discoverMeta(serviceUrl, auth);
  const oc: OAuthClientDecl = auth.oauth_client ?? {};

  const own = opts.redirect ? null : await loopbackRedirect();
  const redirect = opts.redirect ?? own!;
  try {
    // HTTPS 요구는 흐름을 열기 전에 판정한다 — 제공자의 "redirect_uri 불일치" 는 사유가 없는 답이다
    if (oc.https && !redirect.uri.startsWith("https://")) {
      throw new Error(`이 제공자는 콜백 주소에 HTTPS 를 요구합니다(oauth_client.https) — 기판의 TLS 문을 켜세요(RELAY_TLS_PORT). 지금 콜백: ${redirect.uri}`);
    }
    // client_id — registered 는 선언 또는 사람이 공급(조직 앱 등록), 그 외는 DCR
    let clientId: string;
    if (auth.client === "registered") {
      clientId = (oc.client_id ?? (opts.clientId ? await opts.clientId() : "")).trim();
      if (!clientId) throw new Error("client: registered — client_id 가 필요합니다 (oauth_client.client_id 로 선언하거나 연결 화면·relay oauth 가 묻습니다)");
    } else {
      if (!meta.registration_endpoint) throw new Error("DCR registration_endpoint 없음 — client: registered + client_id 경로를 쓰세요");
      const reg = await registerClient(meta.registration_endpoint, redirect.uri, { scopes: oc.scopes });
      if (!reg) throw new Error("DCR 실패");
      clientId = reg.client_id;
    }
    const client = { client_id: clientId, ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}) };

    const pkce = newPkce();
    const url = authorizeUrl(meta, {
      clientId,
      redirectUri: redirect.uri,
      pkce,
      scopes: oc.scopes,
      extra: oc.auth_meta?.authorize_params,
    });
    if (!url) throw new Error(`인가 endpoint 가 URL 이 아닙니다: ${meta.authorization_endpoint}`);

    const answer = redirect.wait(pkce.state, opts.timeoutMs ?? 5 * 60_000);
    (opts.open ?? ((u: string) => spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { detached: true, stdio: "ignore" }).unref()))(url);
    const { code, error } = await answer;
    if (!code) throw new Error(`인가 거부: ${error ?? "code 없음"}`);

    let tok = await exchangeCode(meta.token_endpoint, { code, redirectUri: redirect.uri, client, codeVerifier: pkce.verifier });
    if (!tok) throw new Error("토큰 교환 실패 — 인가 서버가 access_token 을 주지 않았습니다");
    const am = oc.auth_meta;
    if (am?.exchange_endpoint) {
      const long = await tokenByToken(am.exchange_endpoint, { accessToken: tok.access_token, params: am.exchange_params, clientSecret: opts.clientSecret });
      if (!long) throw new Error(`장기 토큰 교환 실패 — ${am.exchange_endpoint} 가 access_token 을 주지 않았습니다`);
      tok = { ...tok, ...long };
    }
    const bundle = toBundle(tok, meta.token_endpoint, clientId);
    if (opts.clientSecret) bundle.client_secret = opts.clientSecret;
    if (opts.fields) bundle.fields = opts.fields;
    return bundle;
  } finally {
    own?.close();
  }
}

// ── 회전 ─────────────────────────────────────────────────────────────────────

/** 회전이 필요한가 — 표준은 만료 60초 전. 토큰으로 회전하는 방언(장기 토큰, 수십 일)은 7일 전부터: 그 계열은 만료
 *  뒤에는 회전이 안 되고, 회전은 소비 시점에만 일어나므로 창이 넓어야 며칠 안 쓴 앱의 자격이 살아남는다 */
function dueForRotation(b: OAuthBundle, auth: AuthDecl | undefined): boolean {
  if (b.expires_at == null) return false;
  const left = b.expires_at - Date.now();
  if (b.refresh_token) return left < 60_000;
  if (auth?.oauth_client?.auth_meta?.refresh_endpoint) return left < 7 * 24 * 60 * 60_000;
  return false;
}

/** 진행 중 회전 — 자격 하나(credKey)가 회전의 단위다. 동시에 두 소비가 만료 임박 토큰을
 *  집으면 refresh 가 두 번 나가는데, refresh token 을 일회용으로 회전시키는 서버에서는
 *  두 번째가 실패하고 자격이 통째로 죽는다. 한 번만 돌리고 결과를 나눠 쓴다 */
const refreshing = new Map<string, Promise<OAuthBundle>>();

function rotate(authority: Authority, key: string, b: OAuthBundle, auth: AuthDecl | undefined): Promise<OAuthBundle> {
  const running = refreshing.get(key);
  if (running) return running;
  const flight = (async () => {
    try {
      const am = auth?.oauth_client?.auth_meta;
      const tok = b.refresh_token
        ? await refreshToken(b.token_endpoint, { refreshToken: b.refresh_token, client: { client_id: b.client_id, ...(b.client_secret ? { client_secret: b.client_secret } : {}) } })
        : am?.refresh_endpoint
          ? await tokenByToken(am.refresh_endpoint, { accessToken: b.access_token, params: am.refresh_params })
          : null;
      if (!tok) throw new Error("토큰 회전 실패 — 인가 서버가 access_token 을 주지 않았습니다");
      const next = toBundle(tok, b.token_endpoint, b.client_id, b);
      await authority.setCredential(key, JSON.stringify(next));
      return next;
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, flight);
  return flight;
}

/** oauth 번들의 access_token — 회전이 필요하면 회전해 저장한 뒤 돌려준다. 번들 없음 = null.
 *  자격의 읽기·쓰기는 권위 이음새(authority.credential/setCredential)를 지난다 */
async function oauthToken(authority: Authority, key: string, auth: AuthDecl | undefined): Promise<string | null> {
  // 회전이 돌고 있으면 끝난 뒤에 읽는다 — 낡은 refresh_token 을 손에 쥐고 출발하지 않기 위해
  const inflight = refreshing.get(key);
  if (inflight) await inflight.catch(() => { /* 앞선 회전의 실패는 내 판정을 막지 않는다 */ });
  const raw = await authority.credential(key);
  if (!raw) return null;
  let b: OAuthBundle;
  try {
    b = JSON.parse(raw);
  } catch {
    return raw; // 번들 이전 시대의 생 토큰 — 그대로 소비(회전 축 없음)
  }
  if (dueForRotation(b, auth)) b = await rotate(authority, key, b, auth);
  return b.access_token;
}

// ── 소비 ─────────────────────────────────────────────────────────────────────

export interface ServiceCredential {
  token: string;
  /** 헤더로 나갈 때의 접두 — token 형은 auth.scheme(미선언 Bearer), oauth 는 RFC 6750 의 Bearer */
  scheme: string;
}

/** 서비스 자격 하나 — token(생 토큰·칸 조립)과 oauth(번들·회전)를 한 자리에서 푼다. 없으면 null */
export async function serviceCredential(
  authority: Authority,
  pkg: string,
  service: string,
  auth: AuthDecl | undefined,
  account?: string | null,
): Promise<ServiceCredential | null> {
  const key = credKey(pkg, service, account);
  if (auth?.kind === "token") {
    // 칸을 선언한 자격은 vault 에 JSON 으로 앉고 header 칸만 나간다(credential.ts tokenOf).
    // 접두는 선언이 정한다(auth.scheme, 미선언 = Bearer). Client-ID 류 API 는 이 한 단어가 갈리면
    // 자격이 있어도 401 인데, 동사는 자격을 쥐지 않으므로 조립할 자리가 여기뿐이다
    const c = tokenOf(auth, await authority.credential(key));
    return c ? { token: c, scheme: auth.scheme?.trim() || "Bearer" } : null;
  }
  if (auth?.kind === "oauth") {
    const t = await oauthToken(authority, key, auth);
    return t ? { token: t, scheme: "Bearer" } : null;
  }
  return null;
}

/** 서비스 자격 헤더 — MCP 문(url 형)·raw 도구 목록이 쓴다. api 형의 요청은 attachCredential 을 지난다 */
export async function serviceAuthHeader(authority: Authority, pkg: string, service: string, auth: AuthDecl | undefined, account?: string | null): Promise<string | undefined> {
  const c = await serviceCredential(authority, pkg, service, auth, account);
  return c ? `${c.scheme} ${c.token}` : undefined;
}

/**
 * 자격을 요청에 싣는다 — 자리는 선언(auth.inject)이 정한다. 미선언 = Authorization 헤더. query = 질의 파라미터.
 * form = x-www-form-urlencoded 본문의 파라미터(본문이 없으면 그 파라미터만으로 만들고, 다른 형의 본문이면 거절한다 —
 * JSON 본문에 폼 칸을 끼워 넣을 수는 없다). 자격이 없으면 요청은 그대로 나간다(동사가 connected() 로 먼저 묻는다).
 * api 형 fetch 와 auth.verify 왕복이 같은 조립을 지난다
 */
export async function attachCredential(
  authority: Authority,
  pkg: string,
  service: string,
  auth: AuthDecl | undefined,
  account: string | null | undefined,
  target: string,
  init: RequestInit,
): Promise<{ url: string; init: RequestInit }> {
  const c = await serviceCredential(authority, pkg, service, auth, account);
  if (!c) return { url: target, init };
  const inject = auth?.inject;
  if (inject && "query" in inject) {
    const u = new URL(target);
    u.searchParams.set(inject.query, c.token);
    return { url: u.toString(), init };
  }
  if (inject && "form" in inject) {
    const headers = new Headers(init.headers);
    const type = headers.get("content-type") ?? "";
    const body = init.body;
    let form: URLSearchParams;
    if (body == null) form = new URLSearchParams();
    else if (body instanceof URLSearchParams) form = new URLSearchParams(body);
    else if (typeof body === "string" && /^application\/x-www-form-urlencoded/i.test(type)) form = new URLSearchParams(body);
    else if (body instanceof Uint8Array && /^application\/x-www-form-urlencoded/i.test(type)) form = new URLSearchParams(Buffer.from(body).toString("utf8"));
    else throw new Error(`${service}: 자격이 폼 파라미터(${inject.form})로 나가는 서비스입니다 — 본문은 application/x-www-form-urlencoded 여야 합니다(URLSearchParams 로 보내세요)`);
    form.set(inject.form, c.token);
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return { url: target, init: { ...init, method: init.method ?? "POST", headers, body: form.toString() } };
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `${c.scheme} ${c.token}`);
  return { url: target, init: { ...init, headers } };
}

// ── 화면에서 여는 흐름 ───────────────────────────────────────────────────────
// CLI(relay oauth)는 흐름이 끝날 때까지 프로세스가 서서 기다리면 되지만, 화면은 그럴 수
// 없다: 브라우저 왕복이 사람의 속도로 흐른다. 그래서 시작과 조회를 가른다 —
// 하네스 headless 로그인(login.ts)이 같은 모양을 pty 로 푼 것과 같은 관용구다.
// 브라우저는 데몬이 연다(runOAuthFlow 의 기본 open) — 데몬과 사람이 같은 기기에 있다는
// 전제는 기판 전체의 전제(loopback 문)와 같다.

interface OAuthRun {
  started: number;
  done: boolean;
  ok: boolean;
  error: string | null;
}

const runs = new Map<string, OAuthRun>();

export interface StartOAuthOpts {
  clientId?: string;
  clientSecret?: string;
  /** 계정 축(auth.accounts)의 좌표 — 성공하면 색인에 앉는다 */
  account?: string | null;
  fields?: Record<string, string | string[]>;
  /** 콜백 문 — 데몬은 고정 문(fixedRedirect)을 준다. 미지정이면 임시 loopback */
  redirect?: OAuthRedirect;
}

/** 흐름 시작 — 즉시 돌아온다. 진행은 serviceOAuthStatus 로 본다.
 *  같은 자격 좌표의 흐름이 이미 돌고 있으면 거절한다(브라우저 창 둘이 뜨는 혼란 방지) */
export function startServiceOAuth(
  authority: Authority,
  pkg: string,
  service: string,
  serviceUrl: string,
  auth: AuthDecl,
  opts: StartOAuthOpts = {},
): OAuthRun {
  const key = credKey(pkg, service, opts.account);
  const cur = runs.get(key);
  if (cur && !cur.done) throw new Error("이미 진행 중인 인가 흐름이 있습니다 — 브라우저 창을 확인하세요");
  const run: OAuthRun = { started: Date.now(), done: false, ok: false, error: null };
  runs.set(key, run);
  void runOAuthFlow(serviceUrl, auth, {
    // client: registered — 화면이 미리 받아 실어 준다. 선언(oauth_client.client_id)이 있으면 그것이 먼저다
    clientId: opts.clientId ? async () => opts.clientId! : undefined,
    clientSecret: opts.clientSecret,
    fields: opts.fields,
    redirect: opts.redirect,
  })
    .then(async (bundle) => {
      await authority.setCredential(key, JSON.stringify(bundle));
      if (opts.account) await rememberAccount(authority, pkg, service, opts.account);
      run.ok = true;
    })
    .catch((e) => {
      run.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      run.done = true;
      void authority.audit("oauth", { pkg, service, ...(opts.account ? { account: opts.account } : {}), ok: run.ok, ...(run.error ? { error: run.error } : {}) });
    });
  return run;
}

export function serviceOAuthStatus(pkg: string, service: string, account?: string | null): OAuthRun & { running: boolean } {
  const r = runs.get(credKey(pkg, service, account)) ?? { started: 0, done: true, ok: false, error: null };
  return { ...r, running: !r.done };
}

// ── auth.verify 집행 ─────────────────────────────────────────────────────────
// 문법에 있던 선언(auth.verify.{url,headers})의 집행자다. 없던 동안 "저장됨 ≠ 유효"를
// 서비스 축에서는 아무도 판정하지 않았다 — 채널은 verifyChannel 이 이미 하던 일이다.
// 판정은 실왕복 하나: 조립된 자격으로 선언된 url 을 두드려 2xx 면 유효다. 자격이 실리는 자리는
// 동사의 요청과 같은 규칙(attachCredential)이다 — 검증이 헤더로 두드리고 동사는 질의로 나가면 검증이 거짓말이 된다

export async function verifyService(
  authority: Authority,
  pkg: string,
  service: string,
  auth: AuthDecl | undefined,
  account?: string | null,
): Promise<{ ok: boolean; note: string }> {
  if (!auth || auth.kind === "none") return { ok: true, note: "자격이 필요 없는 서비스입니다" };
  if (!auth.verify?.url) return { ok: false, note: "auth.verify 미선언 — 이 서비스는 기판이 검증할 수 없습니다(저장만 됩니다)" };
  if (!(await serviceCredential(authority, pkg, service, auth, account))) return { ok: false, note: "자격이 없습니다 — 먼저 연결하세요" };
  try {
    const req = await attachCredential(authority, pkg, service, auth, account, auth.verify.url, {
      headers: auth.verify.headers ?? {},
      signal: AbortSignal.timeout(10_000),
    });
    const res = await fetch(req.url, req.init);
    if (res.ok) return { ok: true, note: `${res.status} ${res.statusText}` };
    // 본문 앞머리만 싣는다 — 자격 값이 에코될 수 있는 자리라 길게 나르지 않는다
    return { ok: false, note: `${res.status} ${res.statusText}${res.status === 401 || res.status === 403 ? " — 자격이 거부되었습니다" : ""}` };
  } catch (e) {
    return { ok: false, note: `왕복 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}
