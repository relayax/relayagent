// oauth-rfc — 기판을 가리지 않는 RFC 조각의 시험. fetch 를 바꿔 끼워 왕복 없이 규칙만 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, discoverOAuthMeta, exchangeCode, newPkce, refreshToken, registerClient } from "./oauth-rfc.ts";

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;
function stubFetch(h: Handler): { calls: { url: string; init?: RequestInit }[]; restore: () => void } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = h(u, init);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const META = { authorization_endpoint: "https://as.example/authorize", token_endpoint: "https://as.example/token" };

test("디스커버리 사다리 — RFC 9728 protected-resource 가 가리키는 AS 의 8414 메타를 먼저 본다", async () => {
  const f = stubFetch((u) => {
    if (u === "https://api.example/.well-known/oauth-protected-resource") return { status: 200, body: { authorization_servers: ["https://as.example"] } };
    if (u === "https://as.example/.well-known/oauth-authorization-server") return { status: 200, body: META };
    return null;
  });
  try {
    const m = await discoverOAuthMeta("https://api.example/mcp");
    assert.deepEqual(m, META);
  } finally { f.restore(); }
});

test("디스커버리 — 9728 이 없으면 자원 origin 의 8414 → OIDC 순", async () => {
  const f = stubFetch((u) => (u === "https://api.example/.well-known/openid-configuration" ? { status: 200, body: META } : null));
  try {
    const m = await discoverOAuthMeta("https://api.example/v1");
    assert.equal(m?.token_endpoint, META.token_endpoint);
    assert.ok(f.calls.some((c) => c.url.endsWith("/oauth-authorization-server")), "8414 를 먼저 두드린다");
  } finally { f.restore(); }
});

test("디스커버리 — 완전한 선언은 왕복이 없고, 불완전한 선언은 발견 위에 필드 승", async () => {
  const f = stubFetch((u) => (u === "https://api.example/.well-known/oauth-authorization-server" ? { status: 200, body: { ...META, registration_endpoint: "https://as.example/reg" } } : null));
  try {
    assert.deepEqual(await discoverOAuthMeta("https://api.example", META), META);
    assert.equal(f.calls.length, 0, "완전한 선언은 fetch 0");
    const merged = await discoverOAuthMeta("https://api.example", { token_endpoint: "https://tenant.example/token" });
    assert.equal(merged?.token_endpoint, "https://tenant.example/token");
    assert.equal(merged?.authorization_endpoint, META.authorization_endpoint);
    assert.equal(merged?.registration_endpoint, "https://as.example/reg");
  } finally { f.restore(); }
});

test("인가 URL — 표준 파라미터가 extra 를 이긴다(위조 금지) · PKCE S256 · scope 공백 결합", () => {
  const pkce = newPkce();
  const u = new URL(authorizeUrl(META, { clientId: "c1", redirectUri: "https://box/cb", pkce, scopes: ["a", "b"], extra: { prompt: "consent", client_id: "evil" } })!);
  assert.equal(u.searchParams.get("client_id"), "c1");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(u.searchParams.get("state"), pkce.state);
  assert.equal(u.searchParams.get("scope"), "a b");
  assert.equal(authorizeUrl({ ...META, authorization_endpoint: "not a url" }, { clientId: "c", redirectUri: "r", pkce }), null);
});

test("코드 교환 — form 방언이 기본, client_secret 은 있을 때만, access_token 없으면 null", async () => {
  const f = stubFetch((u, init) => {
    if (u !== META.token_endpoint) return null;
    const body = String(init?.body);
    if (body.includes("client_secret=s3")) return { status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } };
    return { status: 400, body: { error: "invalid_client" } };
  });
  try {
    const bad = await exchangeCode(META.token_endpoint, { code: "c", redirectUri: "r", client: { client_id: "id" }, codeVerifier: "v" });
    assert.equal(bad, null);
    const ok = await exchangeCode(META.token_endpoint, { code: "c", redirectUri: "r", client: { client_id: "id", client_secret: "s3" }, codeVerifier: "v" });
    assert.equal(ok?.access_token, "at");
    assert.equal(f.calls.at(-1)?.init?.headers && (f.calls.at(-1)!.init!.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  } finally { f.restore(); }
});

test("회전 — json 방언은 JSON 본문으로 나간다", async () => {
  const f = stubFetch((u, init) => {
    const j = JSON.parse(String(init?.body));
    return j.grant_type === "refresh_token" && j.refresh_token === "rt" ? { status: 200, body: { access_token: "at2" } } : { status: 400, body: {} };
  });
  try {
    const r = await refreshToken(META.token_endpoint, { refreshToken: "rt", client: { client_id: "id" }, style: "json" });
    assert.equal(r?.access_token, "at2");
    assert.equal((f.calls[0].init!.headers as Record<string, string>)["content-type"], "application/json");
  } finally { f.restore(); }
});

test("DCR — public client 로 등록하고 client_id 를 돌려준다", async () => {
  const f = stubFetch((u, init) => {
    const j = JSON.parse(String(init?.body));
    return j.token_endpoint_auth_method === "none" && j.redirect_uris[0] === "https://box/cb" ? { status: 201, body: { client_id: "dcr-1" } } : { status: 400, body: {} };
  });
  try {
    assert.deepEqual(await registerClient("https://as.example/reg", "https://box/cb", { scopes: ["a"] }), { client_id: "dcr-1" });
  } finally { f.restore(); }
});
