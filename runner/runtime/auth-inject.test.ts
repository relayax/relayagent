// 자격이 **어디에** 실리는가(services[].auth.inject)와 **어디까지** 나갈 수 있는가(services[].bases).
//
// 두 축은 같은 문장의 두 반쪽이다: 기판이 자격을 붙이고 목적지를 묶기 때문에 "동사는 자격을 쥐지
// 않는다"가 사실이 된다. 헤더 한 자리만 알던 동안, 토큰을 질의·폼으로 받는 API(인스타그램 그래프의
// access_token)는 자격을 동사 손에 쥐여 주는 길로만 열렸고 — 그 길에는 base 판정도 회전도 없다.
// 호스트가 하나뿐이던 동안에는 교환 주소가 다른 호스트에 사는 제공자가 같은 구멍으로 샜다.
//
//   node --experimental-strip-types --test runner/runtime/auth-inject.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { AuthDecl, Manifest } from "../supply/manifest.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inject-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_VAULT = "file";

const { apiTarget, runScript } = await import("./scripts.ts");
const { attachCredential, verifyService } = await import("./oauth.ts");
const { localAuthority } = await import("../authority.ts");
const { credKey } = await import("../vault.ts");
const { judge, ManifestError } = await import("../supply/manifest.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 가짜 몸 둘 — 주 베이스와 보조 베이스(교환이 다른 호스트에 사는 제공자의 모양)
const seen: { url: string; auth?: string; body: string; type?: string }[] = [];
function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    const c: Buffer[] = [];
    req.on("data", (x) => c.push(Buffer.from(x)));
    req.on("end", () => r(Buffer.concat(c).toString("utf8")));
  });
}
const mkServer = (): Promise<http.Server> =>
  new Promise((r) => {
    const s = http.createServer(async (req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: await body(req), type: req.headers["content-type"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null }));
    });
    s.listen(0, "127.0.0.1", () => r(s));
  });
const graph = await mkServer();
const other = await mkServer();
graph.unref();
other.unref();
const GRAPH = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
const OTHER = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
test.after(() => { graph.close(); other.close(); });

const PKG = mk(path.join(ROOT, "feed"));
fs.writeFileSync(path.join(PKG, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/feed"',
  "version: 0.1.0",
  'display_name: "피드"',
  'description: "자격 주입 픽스처"',
  "scripts:",
  "  source: scripts",
  "services:",
  "  - name: graph",
  `    api: "${GRAPH}"`,
  `    bases: ["${OTHER}"]`,
  "    auth:",
  "      kind: token",
  "      inject: { query: access_token }",
].join("\n") + "\n");
const S = mk(path.join(PKG, "scripts"));
fs.writeFileSync(path.join(S, "me.ts"), 'export default async function (_i: any, ctx: any) { return await (await ctx.service("graph").fetch("/v1/me?fields=id")).json(); }\n');
fs.writeFileSync(path.join(S, "cross.ts"), `export default async function (_i: any, ctx: any) { return await (await ctx.service("graph").fetch("${OTHER}/oauth/access_token")).json(); }\n`);
fs.writeFileSync(path.join(S, "away.ts"), 'export default async function (_i: any, ctx: any) { return await ctx.service("graph").fetch("https://evil.example/x"); }\n');

const ledger: Ledger = { secret: "inj", packages: { feed: { path: PKG, ring: 1 } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
await authority.setCredential(credKey("feed", "graph"), "tok-1");

// ── 목적지 ──────────────────────────────────────────────────────────────────
test("보조 베이스도 같은 판정을 지난다 — 선언된 접두 안이면 지나고 밖이면 막힌다", () => {
  assert.equal(apiTarget("https://a.example", "/v1/me", "s", ["https://b.example"]), "https://a.example/v1/me");
  assert.equal(apiTarget("https://a.example", "https://b.example/oauth/token", "s", ["https://b.example"]), "https://b.example/oauth/token");
  // 보조 베이스가 늘어도 그 밖은 그대로 막힌다 — 접두는 슬래시로 닫아 비교한다
  assert.throws(() => apiTarget("https://a.example", "https://c.example/x", "s", ["https://b.example"]), /base 밖 요청/);
  assert.throws(() => apiTarget("https://a.example", "https://b.example.evil.example/x", "s", ["https://b.example"]), /base 밖 요청/);
  // 거절은 두 주소를 다 싣는다 — 어디까지 열려 있는지 사람이 읽어야 고친다
  assert.throws(
    () => apiTarget("https://a.example", "https://c.example/x", "graph", ["https://b.example"]),
    (e: Error) => e.message.includes("graph") && e.message.includes("a.example") && e.message.includes("b.example"),
  );
});

// ── 자리 ────────────────────────────────────────────────────────────────────
const holding = (value: string | null) => ({ credential: async () => value }) as unknown as Parameters<typeof attachCredential>[0];

test("미선언이면 헤더 — scheme 접두가 붙는다", async () => {
  const r = await attachCredential(holding("t"), "p", "s", { kind: "token", scheme: "Client-ID" } as AuthDecl, null, "https://a.example/x", {});
  assert.equal(r.url, "https://a.example/x");
  assert.equal(new Headers(r.init.headers).get("authorization"), "Client-ID t");
});

test("query 선언이면 질의 파라미터로 — 헤더에는 아무것도 붙지 않는다", async () => {
  const auth = { kind: "token", inject: { query: "access_token" } } as AuthDecl;
  const r = await attachCredential(holding("t-1"), "p", "s", auth, null, "https://a.example/v1/me?fields=id", {});
  assert.equal(r.url, "https://a.example/v1/me?fields=id&access_token=t-1");
  assert.equal(new Headers(r.init.headers).get("authorization"), null);
});

test("form 선언이면 폼 본문의 파라미터로 — 다른 형의 본문은 사유를 실어 거절한다", async () => {
  const auth = { kind: "token", inject: { form: "client_secret" } } as AuthDecl;
  const empty = await attachCredential(holding("s3"), "p", "s", auth, null, "https://a.example/token", {});
  assert.equal(empty.init.body, "client_secret=s3");
  assert.equal(empty.init.method, "POST");
  assert.match(String(new Headers(empty.init.headers).get("content-type")), /application\/x-www-form-urlencoded/);
  const withBody = await attachCredential(holding("s3"), "p", "s", auth, null, "https://a.example/token", { method: "POST", body: new URLSearchParams({ code: "c1" }) });
  assert.equal(withBody.init.body, "code=c1&client_secret=s3");
  await assert.rejects(
    () => attachCredential(holding("s3"), "p", "s", auth, null, "https://a.example/token", { method: "POST", headers: { "content-type": "application/json" }, body: '{"code":"c1"}' }),
    /application\/x-www-form-urlencoded/,
  );
});

test("자격이 없으면 요청은 그대로 나간다 — 동사가 connected() 로 먼저 묻는 축이다", async () => {
  const r = await attachCredential(holding(null), "p", "s", { kind: "token", inject: { query: "access_token" } } as AuthDecl, null, "https://a.example/x", {});
  assert.equal(r.url, "https://a.example/x");
});

test("검증 왕복도 같은 자리를 지난다 — 검증이 헤더로 두드리고 동사가 질의로 나가면 검증이 거짓말이 된다", async () => {
  const auth = { kind: "token", inject: { query: "access_token" }, verify: { url: `${GRAPH}/v1/me` } } as AuthDecl;
  const before = seen.length;
  const v = await verifyService(authority, "feed", "graph", auth);
  assert.equal(v.ok, true, v.note);
  assert.equal(seen[before].url, "/v1/me?access_token=tok-1");
  assert.equal(seen[before].auth, undefined, "질의로 나가는 자격이 헤더에도 실렸다");
});

// ── 동사에서 ─────────────────────────────────────────────────────────────────
test("동사의 요청에 기판이 자격을 싣는다 — 주 베이스도 보조 베이스도, 그 밖은 막힌다", async () => {
  const r = (await runScript(ledger, "feed", "me", {}, { principal: "local" }, null, authority)) as { url: string; auth: string | null };
  assert.equal(r.url, "/v1/me?fields=id&access_token=tok-1");
  assert.equal(r.auth, null, "질의로 나가는 자격이 헤더에도 실렸다");
  const x = (await runScript(ledger, "feed", "cross", {}, { principal: "local" }, null, authority)) as { url: string };
  assert.equal(x.url, "/oauth/access_token?access_token=tok-1", "보조 베이스로도 같은 자격이 나간다");
  await assert.rejects(() => runScript(ledger, "feed", "away", {}, { principal: "local" }, null, authority), /base 밖 요청/);
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
const base = (): Manifest =>
  ({ schema: "relay/v1", name: "@t/probe", version: "0.1.0", display_name: "x", description: "판정 픽스처" }) as unknown as Manifest;
const svc = (s: unknown): Manifest => ({ ...base(), services: [s] }) as unknown as Manifest;

test("inject 는 api 형에서만, 하나만, 헤더 접두와는 함께 쓸 수 없다", () => {
  assert.deepEqual(issuesOf(svc({ name: "g", api: "https://a.example", auth: { kind: "token", inject: { query: "access_token" } } })), []);
  const onUrl = issuesOf(svc({ name: "g", url: "https://a.example/mcp", auth: { kind: "token", inject: { query: "t" } } }));
  assert.ok(onUrl.some((i) => i.includes("inject: api 형 서비스에서만")), onUrl.join("\n"));
  const both = issuesOf(svc({ name: "g", api: "https://a.example", auth: { kind: "token", inject: { query: "t", form: "t" } } }));
  assert.ok(both.some((i) => i.includes("{ query: <파라미터> } 또는 { form: <파라미터> } 중 하나")), both.join("\n"));
  const withScheme = issuesOf(svc({ name: "g", api: "https://a.example", auth: { kind: "token", scheme: "Client-ID", inject: { query: "t" } } }));
  assert.ok(withScheme.some((i) => i.includes("scheme 은 헤더의 접두라")), withScheme.join("\n"));
  const badName = issuesOf(svc({ name: "g", api: "https://a.example", auth: { kind: "token", inject: { query: "a b" } } }));
  assert.ok(badName.some((i) => i.includes("inject.query: 파라미터 이름 형식 위반")), badName.join("\n"));
});

test("bases 는 http(s) 목록이고 api 와 같은 주소를 되풀이하지 않는다", () => {
  assert.deepEqual(issuesOf(svc({ name: "g", api: "https://a.example", bases: ["https://b.example"], auth: { kind: "none" } })), []);
  assert.ok(issuesOf(svc({ name: "g", api: "https://a.example", bases: [] })).some((i) => i.includes("비어 있지 않은 URL 목록")));
  assert.ok(issuesOf(svc({ name: "g", api: "https://a.example", bases: ["ftp://b.example"] })).some((i) => i.includes("http(s) URL 필요")));
  assert.ok(issuesOf(svc({ name: "g", api: "https://a.example", bases: ["https://a.example/"] })).some((i) => i.includes("api 와 같은 주소는 적지 않습니다")));
});
