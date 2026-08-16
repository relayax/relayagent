// OAuth 커넥터 자격 — 개인 기판의 자기 흐름: PKCE(S256) + DCR(RFC 7591) + 회전(refresh).
// 어휘(auth.kind oauth·client dcr|registered·oauth_client)는 문법에 이미 있었고, 이 파일이
// 그 실행이다. 자격 번들은 vault 에 서비스 소속으로 앉고(access·refresh·만료·client_id),
// 소비는 요청 시점 pull — 만료 60초 전이면 자동 회전한다. env 상주 없음(oauth 는 만료·회전
// 축이라 env 상주가 애초에 성립하지 않는다 — 조직 기판과 같은 결론).
// 브라우저 열기와 client_id 입력은 주입 가능(opts) — 검사·헤드리스가 같은 흐름을 지난다.
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { credKey } from "./vault.ts";
import type { Authority } from "./authority-contract.ts";
import type { AuthDecl } from "./manifest.ts";

export interface OAuthBundle {
  access_token: string;
  refresh_token?: string;
  /** epoch ms — 없으면 만료 축 없는 토큰(회전 불필요) */
  expires_at?: number;
  token_endpoint: string;
  client_id: string;
}

interface OAuthMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 메타 해석 — 선언(auth_meta) 우선, 없으면 RFC 8414 디스커버리 */
export async function discoverMeta(baseUrl: string, auth: AuthDecl): Promise<OAuthMeta> {
  const declared = (auth.oauth_client as { auth_meta?: Record<string, string> } | undefined)?.auth_meta;
  if (declared?.authorization_endpoint && declared?.token_endpoint) return declared as unknown as OAuthMeta;
  const origin = new URL(baseUrl).origin;
  const res = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`OAuth 디스커버리 실패(${res.status}) — auth_meta 에 endpoint 를 명시하세요: ${origin}`);
  const j = (await res.json()) as OAuthMeta;
  if (!j.authorization_endpoint || !j.token_endpoint) throw new Error("디스커버리 응답에 endpoint 없음");
  return j;
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`토큰 교환 실패(${res.status}): ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

function toBundle(tok: Record<string, unknown>, tokenEndpoint: string, clientId: string, prev?: OAuthBundle): OAuthBundle {
  if (typeof tok.access_token !== "string") throw new Error("토큰 응답에 access_token 없음");
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
      const reg = await fetch(meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "relay",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const rj = (await reg.json().catch(() => ({}))) as { client_id?: string };
      if (!reg.ok || !rj.client_id) throw new Error(`DCR 실패(${reg.status})`);
      clientId = rj.client_id;
    }

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const u = new URL(meta.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    if (oc.scopes?.length) u.searchParams.set("scope", oc.scopes.join(" "));
    for (const [k, v] of Object.entries(oc.auth_meta?.authorize_params ?? {})) u.searchParams.set(k, v);

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
      (opts.open ?? ((url: string) => spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref()))(u.toString());
    });

    const tok = await postForm(meta.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    return toBundle(tok, meta.token_endpoint, clientId);
  } finally {
    server.close();
  }
}

/** 자격 소비 — 만료 60초 전이면 회전해 저장하고 Bearer 를 돌려준다. 번들 없음 = null.
 *  자격의 읽기·쓰기는 권위 이음새(authority.credential/setCredential)를 지난다 */
export async function oauthHeader(authority: Authority, pkg: string, service: string): Promise<string | null> {
  const raw = await authority.credential(credKey(pkg, service));
  if (!raw) return null;
  let b: OAuthBundle;
  try {
    b = JSON.parse(raw);
  } catch {
    return `Bearer ${raw}`; // 번들 이전 시대의 생 토큰 — 그대로 소비(회전 축 없음)
  }
  if (b.expires_at != null && b.expires_at < Date.now() + 60_000 && b.refresh_token) {
    const tok = await postForm(b.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: b.refresh_token,
      client_id: b.client_id,
    });
    b = toBundle(tok, b.token_endpoint, b.client_id, b);
    await authority.setCredential(credKey(pkg, service), JSON.stringify(b));
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
