// OAuth 커넥터 자격 — 개인 기판의 자기 흐름: PKCE(S256) + DCR(RFC 7591) + 회전(refresh).
// 어휘(auth.kind oauth·client dcr|registered·oauth_client)는 문법에 이미 있었고, 이 파일이
// 그 실행이다. 자격 번들은 vault 에 서비스 소속으로 앉고(access·refresh·만료·client_id),
// 소비는 요청 시점 pull — 만료 60초 전이면 자동 회전한다. env 상주 없음(oauth 는 만료·회전
// 축이라 env 상주가 애초에 성립하지 않는다 — 조직 기판과 같은 결론).
// 브라우저 열기와 client_id 입력은 주입 가능(opts) — 검사·헤드리스가 같은 흐름을 지난다.
// RFC 조각(디스커버리·DCR·PKCE·교환·회전)은 oauth-rfc.ts 가 소유한다 — 여기는 1인 기판의
// 제어점(loopback 콜백·vault 저장·화면 흐름)만 든다. 조직 기판은 같은 조각을 자기 제어점에서 부른다.
import http from "node:http";
import { spawn } from "node:child_process";
import { credKey } from "../vault.ts";
import type { Authority } from "../authority-contract.ts";
import type { AuthDecl } from "../supply/manifest.ts";
import {
  authorizeUrl,
  discoverOAuthMeta,
  exchangeCode,
  newPkce,
  refreshToken,
  registerClient,
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
}

/** 메타 해석 — 선언(auth_meta)이 완전하면 그것, 아니면 RFC 9728 → 8414 → OIDC 사다리(oauth-rfc) */
export async function discoverMeta(baseUrl: string, auth: AuthDecl): Promise<OAuthMeta> {
  const declared = (auth.oauth_client as { auth_meta?: Partial<OAuthMeta> } | undefined)?.auth_meta;
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
  };
}

export interface OAuthFlowOpts {
  /** 인가 URL 을 여는 방법 — 기본은 OS 브라우저. 검사·헤드리스는 fetch 주입 */
  open?: (url: string) => void;
  /** client: registered 의 client_id 공급 — 기본은 오류(CLI 가 프롬프트를 주입) */
  clientId?: () => Promise<string>;
  /** 인가 대기 상한 ms (기본 5분) */
  timeoutMs?: number;
}

/**
 * 인가 흐름 — loopback 리다이렉트로 code 를 받고 PKCE 로 교환한다.
 * 반환 번들의 저장은 호출부 소관(oauthConnect 가 vault 에 앉힌다).
 */
export async function runOAuthFlow(serviceUrl: string, auth: AuthDecl, opts: OAuthFlowOpts = {}): Promise<OAuthBundle> {
  const meta = await discoverMeta(serviceUrl, auth);
  const oc = (auth.oauth_client ?? {}) as { scopes?: string[]; auth_meta?: { authorize_params?: Record<string, string> } };

  // loopback 수신기 — 흐름마다 임시 포트 하나. redirect_uri 는 DCR 등록과 같은 값이어야 한다
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;

  try {
    // client_id — registered 는 사람이 공급(조직 앱 등록), 그 외는 DCR
    let clientId: string;
    if (auth.client === "registered") {
      if (!opts.clientId) throw new Error("client: registered — client_id 가 필요합니다 (relay oauth 가 물어봅니다)");
      clientId = (await opts.clientId()).trim();
      if (!clientId) throw new Error("빈 client_id");
    } else {
      if (!meta.registration_endpoint) throw new Error("DCR registration_endpoint 없음 — client: registered + client_id 경로를 쓰세요");
      const reg = await registerClient(meta.registration_endpoint, redirectUri, { scopes: oc.scopes });
      if (!reg) throw new Error("DCR 실패");
      clientId = reg.client_id;
    }

    const pkce = newPkce();
    const state = pkce.state;
    const url = authorizeUrl(meta, {
      clientId,
      redirectUri,
      pkce,
      scopes: oc.scopes,
      extra: oc.auth_meta?.authorize_params,
    });
    if (!url) throw new Error(`인가 endpoint 가 URL 이 아닙니다: ${meta.authorization_endpoint}`);

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("인가 대기 시간 초과")), opts.timeoutMs ?? 5 * 60_000);
      server.on("request", (req, res) => {
        const q = new URL(req.url ?? "/", "http://127.0.0.1");
        if (q.pathname !== "/cb") return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<meta charset='utf-8'>연결되었습니다 — 이 창을 닫아도 됩니다.");
        clearTimeout(timer);
        // state 불일치는 다른 흐름의 응답(CSRF 축) — code 가 있어도 버린다
        if (q.searchParams.get("state") !== state) return void reject(new Error("state 불일치"));
        const c = q.searchParams.get("code");
        c ? resolve(c) : reject(new Error(`인가 거부: ${q.searchParams.get("error") ?? "code 없음"}`));
      });
      (opts.open ?? ((u: string) => spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { detached: true, stdio: "ignore" }).unref()))(url);
    });

    const tok = await exchangeCode(meta.token_endpoint, {
      code,
      redirectUri,
      client: { client_id: clientId },
      codeVerifier: pkce.verifier,
    });
    if (!tok) throw new Error("토큰 교환 실패 — 인가 서버가 access_token 을 주지 않았습니다");
    return toBundle(tok, meta.token_endpoint, clientId);
  } finally {
    server.close();
  }
}

/** 진행 중 회전 — 자격 하나(credKey)가 회전의 단위다. 동시에 두 소비가 만료 임박 토큰을
 *  집으면 refresh 가 두 번 나가는데, refresh token 을 일회용으로 회전시키는 서버에서는
 *  두 번째가 실패하고 자격이 통째로 죽는다. 한 번만 돌리고 결과를 나눠 쓴다 */
const refreshing = new Map<string, Promise<OAuthBundle>>();

function rotate(authority: Authority, key: string, b: OAuthBundle): Promise<OAuthBundle> {
  const running = refreshing.get(key);
  if (running) return running;
  const flight = (async () => {
    try {
      const tok = await refreshToken(b.token_endpoint, { refreshToken: b.refresh_token as string, client: { client_id: b.client_id } });
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

/** 자격 소비 — 만료 60초 전이면 회전해 저장하고 Bearer 를 돌려준다. 번들 없음 = null.
 *  자격의 읽기·쓰기는 권위 이음새(authority.credential/setCredential)를 지난다 */
export async function oauthHeader(authority: Authority, pkg: string, service: string): Promise<string | null> {
  const key = credKey(pkg, service);
  // 회전이 돌고 있으면 끝난 뒤에 읽는다 — 낡은 refresh_token 을 손에 쥐고 출발하지 않기 위해
  const inflight = refreshing.get(key);
  if (inflight) await inflight.catch(() => { /* 앞선 회전의 실패는 내 판정을 막지 않는다 */ });
  const raw = await authority.credential(key);
  if (!raw) return null;
  let b: OAuthBundle;
  try {
    b = JSON.parse(raw);
  } catch {
    return `Bearer ${raw}`; // 번들 이전 시대의 생 토큰 — 그대로 소비(회전 축 없음)
  }
  if (b.expires_at != null && b.expires_at < Date.now() + 60_000 && b.refresh_token) {
    b = await rotate(authority, key, b);
  }
  return `Bearer ${b.access_token}`;
}

/** 서비스 자격 헤더 — token(생 토큰)과 oauth(번들·회전)를 한 자리에서 푼다 */
export async function serviceAuthHeader(authority: Authority, pkg: string, service: string, auth: AuthDecl | undefined): Promise<string | undefined> {
  if (auth?.kind === "token") {
    const c = await authority.credential(credKey(pkg, service));
    return c ? `Bearer ${c}` : undefined;
  }
  if (auth?.kind === "oauth") return (await oauthHeader(authority, pkg, service)) ?? undefined;
  return undefined;
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

/** 흐름 시작 — 즉시 돌아온다. 진행은 serviceOAuthStatus 로 본다.
 *  같은 (pkg, service)의 흐름이 이미 돌고 있으면 거절한다(브라우저 창 둘이 뜨는 혼란 방지) */
export function startServiceOAuth(
  authority: Authority,
  pkg: string,
  service: string,
  serviceUrl: string,
  auth: AuthDecl,
  opts: { clientId?: string } = {},
): OAuthRun {
  const key = credKey(pkg, service);
  const cur = runs.get(key);
  if (cur && !cur.done) throw new Error("이미 진행 중인 인가 흐름이 있습니다 — 브라우저 창을 확인하세요");
  const run: OAuthRun = { started: Date.now(), done: false, ok: false, error: null };
  runs.set(key, run);
  void runOAuthFlow(serviceUrl, auth, {
    // client: registered — 화면이 미리 받아 실어 준다. 없으면 흐름이 사유와 함께 실패한다
    clientId: opts.clientId ? async () => opts.clientId! : undefined,
  })
    .then(async (bundle) => {
      await authority.setCredential(key, JSON.stringify(bundle));
      run.ok = true;
    })
    .catch((e) => {
      run.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      run.done = true;
      void authority.audit("oauth", { pkg, service, ok: run.ok, ...(run.error ? { error: run.error } : {}) });
    });
  return run;
}

export function serviceOAuthStatus(pkg: string, service: string): OAuthRun & { running: boolean } {
  const r = runs.get(credKey(pkg, service)) ?? { started: 0, done: true, ok: false, error: null };
  return { ...r, running: !r.done };
}

// ── auth.verify 집행 ─────────────────────────────────────────────────────────
// 문법에 있던 선언(auth.verify.{url,headers})의 집행자다. 없던 동안 "저장됨 ≠ 유효"를
// 서비스 축에서는 아무도 판정하지 않았다 — 채널은 verifyChannel 이 이미 하던 일이다.
// 판정은 실왕복 하나: 조립된 자격으로 선언된 url 을 두드려 2xx 면 유효다.

export async function verifyService(
  authority: Authority,
  pkg: string,
  service: string,
  auth: AuthDecl | undefined,
): Promise<{ ok: boolean; note: string }> {
  if (!auth || auth.kind === "none") return { ok: true, note: "자격이 필요 없는 서비스입니다" };
  if (!auth.verify?.url) return { ok: false, note: "auth.verify 미선언 — 이 서비스는 기판이 검증할 수 없습니다(저장만 됩니다)" };
  const header = await serviceAuthHeader(authority, pkg, service, auth);
  if (!header) return { ok: false, note: "자격이 없습니다 — 먼저 연결하세요" };
  try {
    const res = await fetch(auth.verify.url, {
      headers: { ...(auth.verify.headers ?? {}), authorization: header },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, note: `${res.status} ${res.statusText}` };
    // 본문 앞머리만 싣는다 — 자격 값이 에코될 수 있는 자리라 길게 나르지 않는다
    return { ok: false, note: `${res.status} ${res.statusText}${res.status === 401 || res.status === 403 ? " — 자격이 거부되었습니다" : ""}` };
  } catch (e) {
    return { ok: false, note: `왕복 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}
