// OAuth 자격의 세 구멍 — 인가가 주지 않는 부속 칸(auth.fields), 콜백을 받는 **고정** 문, 그리고
// 표준 밖 방언(단기→장기 교환·토큰으로 하는 회전).
//
// 전에는 셋 다 없었다: oauth 형에는 칸 자리가 없어 계정 번호 같은 부속 값이 앉을 곳이 없었고
// (그래서 앱이 자기 파일에 이사시켰다), 콜백은 흐름마다 임시 포트라 등록형 앱(redirect_uri 를 미리
// 적어야 하는 제공자)은 이을 길이 없었으며, refresh_token 을 주지 않고 access_token 으로 회전시키는
// 제공자의 자격은 만료와 함께 조용히 죽었다.
//
//   node --experimental-strip-types --test runner/runtime/oauth-connect.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { AuthDecl, Manifest } from "../supply/manifest.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-oauth-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_VAULT = "file";

const { fixedRedirect, receiveOAuthCallback, runOAuthFlow, serviceCredential } = await import("./oauth.ts");
const { publicFields } = await import("./credential.ts");
const { localAuthority } = await import("../authority.ts");
const { credKey } = await import("../vault.ts");
const { judge, ManifestError } = await import("../supply/manifest.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 가짜 인가 서버 — 표준 교환(POST /token)과 제공자 방언 둘(GET /exchange · GET /refresh)
const hits: { url: string; body: string }[] = [];
const as = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", () => {
    const url = req.url ?? "";
    hits.push({ url, body: Buffer.concat(chunks).toString("utf8") });
    const json = (o: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.startsWith("/token")) return json({ access_token: "short", expires_in: 3600 });
    if (url.startsWith("/exchange")) return json({ access_token: "long", expires_in: 5_184_000 });
    if (url.startsWith("/refresh")) return json({ access_token: "long-2", expires_in: 5_184_000 });
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => as.listen(0, "127.0.0.1", r));
as.unref();
const AS = `http://127.0.0.1:${(as.address() as { port: number }).port}`;
test.after(() => as.close());

const CALLBACK = "http://localhost:4747/oauth/cb";
const meta = {
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  exchange_endpoint: `${AS}/exchange`,
  exchange_params: { grant_type: "ig_exchange_token" },
  refresh_endpoint: `${AS}/refresh`,
  refresh_params: { grant_type: "ig_refresh_token" },
};
const AUTH: AuthDecl = {
  kind: "oauth",
  client: "registered",
  accounts: true,
  inject: { query: "access_token" },
  oauth_client: { client_id: "cid-1", scopes: ["business_basic"], auth_meta: meta },
  fields: [{ key: "user_id", label: "계정 번호", required: true }],
};

const ledger: Ledger = { secret: "oa", packages: {}, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);

/** 사람 대신 브라우저 왕복을 한다 — 인가 URL 의 state 를 읽어 고정 문에 답을 넣는다 */
const answerWith = (params: (state: string) => Record<string, string>) => (url: string) => {
  const state = new URL(url).searchParams.get("state") ?? "";
  setTimeout(() => receiveOAuthCallback(new URLSearchParams(params(state))), 0);
};

test("고정 문으로 코드가 오고, 선언된 방언이 장기 토큰으로 바꾼다 — 부속 칸과 비밀은 번들에 앉는다", async () => {
  const before = hits.length;
  const bundle = await runOAuthFlow(AS, AUTH, {
    redirect: fixedRedirect(CALLBACK),
    clientSecret: "sec-1",
    fields: { user_id: "42" },
    open: answerWith((state) => ({ code: "c-1", state })),
  });
  assert.equal(bundle.access_token, "long", "장기 교환의 결과가 번들에 앉아야 한다");
  assert.equal(bundle.client_id, "cid-1", "선언된 client_id 는 사람에게 묻지 않는다");
  assert.equal(bundle.client_secret, "sec-1");
  assert.deepEqual(bundle.fields, { user_id: "42" });
  assert.ok((bundle.expires_at ?? 0) > Date.now() + 5_000_000_000, "장기 토큰의 만료가 실려야 한다");
  // 교환 요청은 고정 콜백 주소와 PKCE 검증자를 싣는다 — redirect_uri 는 인가 때와 바이트 동일해야 한다
  const token = hits[before];
  assert.ok(token.url.startsWith("/token"));
  const form = new URLSearchParams(token.body);
  assert.equal(form.get("redirect_uri"), CALLBACK);
  assert.equal(form.get("code"), "c-1");
  assert.equal(form.get("client_secret"), "sec-1");
  assert.ok(form.get("code_verifier"), "PKCE 검증자가 빠졌다");
  // 방언 왕복은 선언된 고정 파라미터 + 방금 받은 토큰
  const ex = new URL(hits[before + 1].url, AS);
  assert.equal(ex.pathname, "/exchange");
  assert.equal(ex.searchParams.get("grant_type"), "ig_exchange_token");
  assert.equal(ex.searchParams.get("access_token"), "short");
  assert.equal(ex.searchParams.get("client_secret"), "sec-1");
});

test("모르는 state 의 답은 받지 않는다 — 이 문은 아무 웹페이지나 두드릴 수 있다", () => {
  assert.equal(receiveOAuthCallback(new URLSearchParams({ code: "x", state: "지어낸-state" })), false);
});

test("인가 거부는 사유가 되어 돌아온다", async () => {
  await assert.rejects(
    () => runOAuthFlow(AS, AUTH, { redirect: fixedRedirect(CALLBACK), open: answerWith((state) => ({ error: "access_denied", state })) }),
    /인가 거부: access_denied/,
  );
});

test("HTTPS 를 요구하는 제공자는 흐름 전에 막힌다 — 제공자의 '주소 불일치'는 원인을 말해 주지 않는다", async () => {
  const https = { ...AUTH, oauth_client: { ...AUTH.oauth_client, https: true } } as AuthDecl;
  await assert.rejects(
    () => runOAuthFlow(AS, https, { redirect: fixedRedirect(CALLBACK), open: () => assert.fail("브라우저를 열면 안 된다") }),
    /HTTPS 를 요구합니다.*RELAY_TLS_PORT/s,
  );
});

test("부속 칸은 동사에게 비밀 아닌 것만 간다 — 토큰·비밀은 번들에 남는다", () => {
  const raw = JSON.stringify({ access_token: "long", client_secret: "sec-1", fields: { user_id: "42" } });
  assert.deepEqual(publicFields(AUTH, raw), { user_id: "42" });
  const secretField = { ...AUTH, fields: [{ key: "user_id", label: "계정" }, { key: "pin", label: "PIN", secret: true }] } as AuthDecl;
  assert.deepEqual(publicFields(secretField, JSON.stringify({ access_token: "t", fields: { user_id: "42", pin: "0000" } })), { user_id: "42" });
  assert.deepEqual(publicFields(AUTH, JSON.stringify({ access_token: "t" })), {}, "칸이 없는 번들은 빈 객체");
});

test("회전 — refresh_token 이 없는 제공자는 선언된 방언으로 돈다. 창은 넓다(만료 뒤에는 회전이 없다)", async () => {
  const key = credKey("desk", "social", "alpha");
  const soon = { access_token: "long", expires_at: Date.now() + 24 * 60 * 60_000, token_endpoint: `${AS}/token`, client_id: "cid-1", fields: { user_id: "42" } };
  await authority.setCredential(key, JSON.stringify(soon));
  const c = await serviceCredential(authority, "desk", "social", AUTH, "alpha");
  assert.equal(c?.token, "long-2", "만료 7일 안이면 방언으로 회전한다");
  assert.equal(c?.scheme, "Bearer");
  const stored = JSON.parse((await authority.credential(key))!);
  assert.equal(stored.access_token, "long-2", "회전 결과가 금고에 앉아야 다음 소비가 새 토큰을 쓴다");
  assert.deepEqual(stored.fields, { user_id: "42" }, "회전이 부속 칸을 잃으면 안 된다");
  // 아직 멀면 왕복이 없다
  const far = { ...soon, access_token: "long-3", expires_at: Date.now() + 30 * 24 * 60 * 60_000 };
  await authority.setCredential(key, JSON.stringify(far));
  const before = hits.length;
  assert.equal((await serviceCredential(authority, "desk", "social", AUTH, "alpha"))?.token, "long-3");
  assert.equal(hits.length, before, "만료가 먼 토큰을 회전시켰다");
});

test("계정마다 자격이 따로 산다 — 좌표가 갈리므로 회전도 소비도 서로 모른다", async () => {
  await authority.setCredential(credKey("desk", "social", "beta"), JSON.stringify({ access_token: "beta-tok", token_endpoint: `${AS}/token`, client_id: "cid-1" }));
  assert.equal((await serviceCredential(authority, "desk", "social", AUTH, "beta"))?.token, "beta-tok");
  assert.equal(await serviceCredential(authority, "desk", "social", AUTH, "감마"), null, "앉지 않은 계정은 자격 없음");
});

// ── 문법 ────────────────────────────────────────────────────────────────────
const issuesOf = (m: Manifest): string[] => {
  try {
    judge(m);
    return [];
  } catch (e) {
    return e instanceof ManifestError ? e.issues : [String(e)];
  }
};
const svc = (auth: unknown): Manifest =>
  ({ schema: "relay/v1", name: "@t/probe", version: "0.1.0", display_name: "x", description: "판정 픽스처", services: [{ name: "social", api: "https://a.example", auth }] }) as unknown as Manifest;

test("oauth 형의 칸에는 header 가 없고 전부 key 가 있다 — 헤더로 나가는 것은 번들의 access_token 이다", () => {
  assert.deepEqual(issuesOf(svc(AUTH)), []);
  const header = issuesOf(svc({ ...AUTH, fields: [{ key: "t", label: "토큰", header: true }] }));
  assert.ok(header.some((i) => i.includes("oauth 형의 칸에는 header 가 없습니다")), header.join("\n"));
  const bare = issuesOf(svc({ ...AUTH, fields: [{ label: "값" }] }));
  assert.ok(bare.some((i) => i.includes("전부 key 가 있어야 합니다")), bare.join("\n"));
});

test("oauth_client 는 닫힌 어휘다 — 방언의 반쪽 선언은 조용히 무시되지 않는다", () => {
  const unknown = issuesOf(svc({ ...AUTH, oauth_client: { ...AUTH.oauth_client, secret: "x" } }));
  assert.ok(unknown.some((i) => i.includes("미지") && i.includes("oauth_client 키: secret")), unknown.join("\n"));
  const halfExchange = issuesOf(svc({ ...AUTH, oauth_client: { auth_meta: { ...meta, exchange_endpoint: undefined, exchange_params: { grant_type: "x" } } } }));
  assert.ok(halfExchange.some((i) => i.includes("exchange_params 는 exchange_endpoint 와 함께만")), halfExchange.join("\n"));
  const halfRefresh = issuesOf(svc({ ...AUTH, oauth_client: { auth_meta: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint, refresh_params: { grant_type: "x" } } } }));
  assert.ok(halfRefresh.some((i) => i.includes("refresh_params 는 refresh_endpoint 와 함께만")), halfRefresh.join("\n"));
  const badUrl = issuesOf(svc({ ...AUTH, oauth_client: { auth_meta: { token_endpoint: "not-a-url" } } }));
  assert.ok(badUrl.some((i) => i.includes("auth_meta.token_endpoint: http(s) URL 필요")), badUrl.join("\n"));
  const onToken = issuesOf(svc({ kind: "token", oauth_client: { client_id: "x" } }));
  assert.ok(onToken.some((i) => i.includes("미지 services[social].auth 키(token 형): oauth_client")), onToken.join("\n"));
});
