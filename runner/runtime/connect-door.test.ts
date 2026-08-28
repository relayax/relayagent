// 데몬의 문 셋 — GET 으로 열리는 동사(scripts.get), 인가 콜백의 고정 자리(GET /oauth/cb), 그리고
// 계정 축이 붙은 자격 라우트. 문 앞까지 와서 막히면 축이 있어도 없는 것과 같아 여기서 함께 본다.
//
// 실측 2026-08-28: 동사 문이 POST 하나뿐이라 인가 리다이렉트(GET)를 동사가 받지 못했고, 정적 화면
// 한 장이 코드를 받아 POST 로 넘기는 다리를 저작자가 직접 놓아야 했다.
//
//   node --experimental-strip-types --test runner/runtime/connect-door.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-door-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = mk(path.join(ROOT, "relay-home"));
process.env.RELAY_VAULT = "file";

const { createApi } = await import("../daemon.ts");
const { Ticker } = await import("./triggers.ts");
const { localAuthority } = await import("../authority.ts");
const { credKey } = await import("../vault.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const PKG = mk(path.join(ROOT, "desk"));
fs.writeFileSync(path.join(PKG, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/desk"',
  "version: 0.1.0",
  'display_name: "데스크"',
  'description: "문 픽스처"',
  "scripts:",
  "  source: scripts",
  "  get: [echo, challenge]",
  "services:",
  "  - name: social",
  '    api: "https://graph.example.com"',
  "    auth: { kind: token, accounts: true }",
  "  - name: solo",
  '    api: "https://api.example.com"',
  "    auth: { kind: token }",
].join("\n") + "\n");
const S = mk(path.join(PKG, "scripts"));
fs.writeFileSync(path.join(S, "echo.ts"), "export default async function (input: any) { return { got: input }; }\n");
// 웹훅 검증의 모양 — 상대가 준 값을 본문 그대로 돌려줘야 한다(JSON 봉투가 아니라)
fs.writeFileSync(path.join(S, "challenge.ts"), 'export default async function (i: any) { return String(i.hub_challenge ?? ""); }\n');
fs.writeFileSync(path.join(S, "hidden.ts"), "export default async function () { return { hidden: true }; }\n");

const ledger: Ledger = { secret: "door", packages: { desk: { path: PKG, ring: 1 } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const host = {} as unknown as HostBridge;
const server = createApi(() => ledger, host, new Ticker(() => ledger, host, authority), authority, { door: { listen: false } });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PORT = (server.address() as net.AddressInfo).port;
test.after(() => server.close());

interface Reply { status: number; type: string; text: string }
function call(method: string, p: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const asJson = async (r: Reply): Promise<any> => JSON.parse(r.text);

// ── GET 문 ──────────────────────────────────────────────────────────────────
test("선언된 동사는 GET 으로 열린다 — 질의 문자열이 그대로 입력이다(같은 키가 여럿이면 배열)", async () => {
  const r = await call("GET", "/pkg/desk/script/echo?a=1&a=2&b=x");
  assert.equal(r.status, 200);
  assert.deepEqual((await asJson(r)).result, { got: { a: ["1", "2"], b: "x" } });
});

test("문자열을 돌려주는 동사는 본문 그대로 나간다 — 검증 챌린지를 되돌려 주는 상대가 있다", async () => {
  const r = await call("GET", "/pkg/desk/script/challenge?hub_challenge=42");
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/plain/);
  assert.equal(r.text, "42");
});

test("선언하지 않은 동사는 GET 으로 열리지 않는다 — 문은 선언으로만 열린다", async () => {
  const r = await call("GET", "/pkg/desk/script/hidden");
  assert.equal(r.status, 405);
  assert.match((await asJson(r)).error, /scripts\.get 에 선언한 동사만/);
  // POST 문은 그대로다 — 같은 동사가 문에 따라 다르게 돌지 않는다
  const p = await call("POST", "/pkg/desk/script/hidden", {});
  assert.equal(p.status, 200);
  assert.deepEqual((await asJson(p)).result, { hidden: true });
});

test("scripts.get 은 실재하는 동사만 가리킨다 — 문은 있는데 답이 없는 자리를 만들지 않는다", async () => {
  const { judge, ManifestError, loadManifest } = await import("../supply/manifest.ts");
  const issuesOf = (m: unknown): string[] => {
    try {
      judge(m as never, PKG);
      return [];
    } catch (e) {
      return e instanceof ManifestError ? e.issues : [String(e)];
    }
  };
  const m = loadManifest(PKG);
  assert.deepEqual(issuesOf(m), []);
  assert.ok(issuesOf({ ...m, scripts: { source: "scripts", get: ["nowhere"] } }).some((i) => i.includes("scripts.get 실체 없음: nowhere")));
  assert.ok(issuesOf({ ...m, scripts: { source: "scripts", get: [] } }).some((i) => i.includes("비어 있지 않은 동사 이름 목록")));
  assert.ok(issuesOf({ ...m, scripts: { source: "scripts", get: ["Echo"] } }).some((i) => i.includes("scripts.get 형식 위반")));
  assert.ok(issuesOf({ ...m, scripts: { source: "scripts", post: ["echo"] } }).some((i) => i.includes("미지 scripts 키: post")));
});

// ── 인가 콜백의 고정 문 ──────────────────────────────────────────────────────
test("기다리는 흐름이 없는 콜백은 404 — 이 문은 아무 웹페이지나 두드릴 수 있다", async () => {
  const r = await call("GET", "/oauth/cb?code=c1&state=nobody");
  assert.equal(r.status, 404);
  assert.match(r.text, /기다리는 인가 흐름이 없습니다/);
});

// ── 계정 축이 붙은 자격 라우트 ───────────────────────────────────────────────
test("계정 축이 선언된 서비스는 계정 없이 연결되지 않는다", async () => {
  const r = await call("POST", "/pkg/desk/service/social/connect", { token: "t-1" });
  assert.equal(r.status, 400);
  assert.match((await asJson(r)).error, /계정 축이 선언된 서비스입니다/);
  const bad = await call("POST", "/pkg/desk/service/social/connect", { token: "t-1", account: "빈 칸" });
  assert.equal(bad.status, 400);
  assert.match((await asJson(bad)).error, /계정 이름 형식 위반/);
});

test("계정 축이 없는 서비스에 계정을 실으면 거절한다 — 없는 좌표를 짓지 않는다", async () => {
  const r = await call("POST", "/pkg/desk/service/solo/connect", { token: "t-1", account: "alpha" });
  assert.equal(r.status, 400);
  assert.match((await asJson(r)).error, /계정 축이 없는 서비스입니다/);
});

test("계정으로 연결하면 그 좌표에 앉고 색인에 오른다 — 해제하면 둘 다 사라진다", async () => {
  assert.equal((await call("POST", "/pkg/desk/service/social/connect", { token: "t-alpha", account: "alpha" })).status, 200);
  assert.equal((await call("POST", "/pkg/desk/service/social/connect", { token: "t-beta", account: "beta" })).status, 200);
  assert.equal(await authority.credential(credKey("desk", "social", "alpha")), "t-alpha");
  const list = await asJson(await call("GET", "/pkg/desk/services"));
  const social = list.services.find((s: { name: string }) => s.name === "social");
  assert.deepEqual(social.accounts.map((a: { name: string }) => a.name), ["alpha", "beta"]);
  assert.equal(social.hasCred, true);
  assert.equal(social.inject, "header");
  assert.equal(list.services.find((s: { name: string }) => s.name === "solo").accounts, null);

  assert.equal((await call("POST", "/pkg/desk/service/social/disconnect", { account: "alpha" })).status, 200);
  assert.equal(await authority.credential(credKey("desk", "social", "alpha")), null);
  const after = await asJson(await call("GET", "/pkg/desk/services"));
  assert.deepEqual(after.services.find((s: { name: string }) => s.name === "social").accounts.map((a: { name: string }) => a.name), ["beta"]);
});

test("전 패키지 전경도 같은 답을 읽는다 — 두 화면이 다른 수를 말하지 않는다", async () => {
  const ov = await asJson(await call("GET", "/connections"));
  const desk = ov.packages.find((p: { pkg: string }) => p.pkg === "desk");
  assert.deepEqual(desk.services.find((s: { name: string }) => s.name === "social").accounts.map((a: { name: string }) => a.name), ["beta"]);
  assert.equal(ov.attention, 1, "solo 만 빈 필수 자격이다");
  assert.equal(JSON.stringify(ov).includes("t-beta"), false, "자격 값이 전경에 실렸다");
});
