// 계정 축(services[].auth.accounts) — 한 서비스에 자격이 여럿. 금고 좌표(<pkg>/<서비스>@<계정>), 색인,
// 동사의 손잡이(accounts·account), 연결 화면이 읽는 전경이 **같은 축 하나**를 보는지 본다.
//
// 이 축이 없던 동안 같은 서비스의 계정이 여럿인 앱은 자기 비밀 보관소를 따로 지었다(실측 2026-08-28:
// 인스타 데스크가 계정 폴더마다 0600 파일로 토큰을 보관). 그 순간 "자격은 트리에 살지 않는다"가 그
// 패키지에서만 거짓이 되므로, 축의 부재는 편의가 아니라 계약의 구멍이었다.
//
//   node --experimental-strip-types --test runner/runtime/service-accounts.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { Manifest } from "../supply/manifest.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-accounts-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_VAULT = "file"; // 사용자 Keychain 을 시험이 오염시키지 않는다

const { runScript, makeCtx } = await import("./scripts.ts");
const { localAuthority } = await import("../authority.ts");
const { credKey, accountsKey } = await import("../vault.ts");
const { forgetAccount, judgeAccount, listAccounts, rememberAccount } = await import("./credential.ts");
const { serviceStatuses } = await import("./connections.ts");
const { judge, ManifestError, loadManifest } = await import("../supply/manifest.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 받은 요청의 자격을 되돌려 주는 가짜 REST 몸
const seen: { auth?: string; url: string }[] = [];
const api = http.createServer((req, res) => {
  seen.push({ auth: req.headers.authorization, url: req.url ?? "" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null }));
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
api.unref();
const API = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
test.after(() => api.close());

const PKG = mk(path.join(ROOT, "desk"));
fs.writeFileSync(path.join(PKG, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/desk"',
  "version: 0.1.0",
  'display_name: "계정 데스크"',
  'description: "계정 축 픽스처"',
  "scripts:",
  "  source: scripts",
  "services:",
  "  - name: social",
  `    api: "${API}"`,
  "    auth:",
  "      kind: token",
  "      accounts: true",
  "      fields:",
  "        - { key: token, label: 토큰, header: true }",
  "        - { key: user_id, label: 계정 번호 }",
  "  - name: solo",
  `    api: "${API}"`,
  "    auth: { kind: token }",
].join("\n") + "\n");
const S = mk(path.join(PKG, "scripts"));
// 동사가 보는 축 — 열거하고, 고르고, 그 계정의 자격으로 나간다. 자격 값은 동사에 오지 않는다
fs.writeFileSync(path.join(S, "post.ts"), [
  "export default async function (i: any, ctx: any) {",
  '  const svc = ctx.service("social");',
  "  const all = await svc.accounts();",
  "  const one = svc.account(i.handle);",
  '  const res = await one.fetch("/me");',
  "  return { all, connected: await one.connected(), fields: await one.fields(), echo: await res.json() };",
  "}",
].join("\n") + "\n");
fs.writeFileSync(path.join(S, "unpicked.ts"), 'export default async function (_i: any, ctx: any) { return await ctx.service("social").fetch("/me"); }\n');
fs.writeFileSync(path.join(S, "noaxis.ts"), 'export default async function (_i: any, ctx: any) { return ctx.service("solo").account("a").url; }\n');

const ledger: Ledger = { secret: "acc", packages: { desk: { path: PKG, ring: 1 } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const cred = (k: string) => authority.credential(k);
const run = (verb: string, input: unknown = {}) => runScript(ledger, "desk", verb, input, { principal: "local" }, null, authority);

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

test("accounts 는 서비스 자격의 축이다 — boolean 만, llm 자격에는 없다", () => {
  const ok = { ...base(), services: [{ name: "s", api: "https://a.example", auth: { kind: "token", accounts: true } }] } as unknown as Manifest;
  assert.deepEqual(issuesOf(ok), []);
  const bad = { ...base(), services: [{ name: "s", api: "https://a.example", auth: { kind: "token", accounts: "yes" } }] } as unknown as Manifest;
  assert.ok(issuesOf(bad).some((i) => i.includes("accounts: true | false")));
  const llm = {
    ...base(),
    harness: { variants: [{ name: "cc", source: "h", entry: "run", llm: { provider: "anthropic", auth: { kind: "token", accounts: true } } }] },
  } as unknown as Manifest;
  assert.ok(issuesOf(llm).some((i) => i.includes("llm.auth.accounts") && i.includes("services[].auth 에서만")));
});

// ── 좌표와 색인 ──────────────────────────────────────────────────────────────
test("좌표는 계정으로 갈린다 — 계정 없는 좌표와 겹치지 않는다", () => {
  assert.equal(credKey("desk", "social"), "desk/social");
  assert.equal(credKey("desk", "social", "haemin"), "desk/social@haemin");
  assert.equal(credKey("desk", "social", null), "desk/social");
  assert.equal(accountsKey("desk", "social"), "desk/social/accounts");
});

test("계정 이름은 닫힌 형이다 — 좌표에 앉고 화면에 그려지는 값이라 지어낼 수 없다", () => {
  assert.equal(judgeAccount(" haemin "), "haemin");
  assert.equal(judgeAccount("brand.2_a-b"), "brand.2_a-b");
  for (const bad of ["", "a/b", "a@b", "with space", "-lead", "가나다"]) {
    assert.throws(() => judgeAccount(bad), /계정 이름 형식 위반/, `허용되면 안 된다: ${bad}`);
  }
});

test("색인이 열거의 답이다 — 금고에는 열거 API 가 없다", async () => {
  assert.deepEqual(await listAccounts(cred, "desk", "social"), []);
  await rememberAccount(authority, "desk", "social", "alpha");
  await rememberAccount(authority, "desk", "social", "alpha"); // 두 번 넣어도 하나
  await rememberAccount(authority, "desk", "social", "beta");
  assert.deepEqual(await listAccounts(cred, "desk", "social"), ["alpha", "beta"]);
  await forgetAccount(authority, "desk", "social", "alpha");
  assert.deepEqual(await listAccounts(cred, "desk", "social"), ["beta"]);
  await forgetAccount(authority, "desk", "social", "beta");
  assert.deepEqual(await listAccounts(cred, "desk", "social"), []);
});

// ── 동사의 손잡이 ────────────────────────────────────────────────────────────
test("고르지 않은 손잡이는 열거·유무만 답하고 나머지 문은 계정을 고르라고 던진다", async () => {
  const ctx = makeCtx(ledger, "desk", { principal: "local" }, null, authority);
  const svc = ctx.service("social");
  assert.equal(await svc.connected(), false, "앉은 계정이 없으면 연결 아님");
  await authority.setCredential(credKey("desk", "social", "alpha"), JSON.stringify({ token: "t-alpha", user_id: "1" }));
  await rememberAccount(authority, "desk", "social", "alpha");
  assert.equal(await svc.connected(), true, "하나라도 앉으면 연결됨");
  assert.deepEqual(await svc.accounts(), ["alpha"]);
  await assert.rejects(() => svc.fetch("/me"), /계정 축이 선언된 서비스입니다/);
  await assert.rejects(() => svc.fields(), /계정 축이 선언된 서비스입니다/);
});

test("계정 축이 없는 서비스에서 계정을 고르면 던진다 — 없는 좌표로 조용히 나가지 않는다", () => {
  const ctx = makeCtx(ledger, "desk", { principal: "local" }, null, authority);
  assert.throws(() => ctx.service("solo").account("alpha"), /계정 축이 없는 서비스입니다/);
  assert.rejects(() => ctx.service("solo").accounts(), /계정 축이 없는 서비스입니다/);
  // 폴더·몸에는 자격 축 자체가 없다
  assert.throws(() => ctx.service("social").account("bad name"), /계정 이름 형식 위반/);
});

test("동사가 계정을 골라 나간다 — 그 계정의 자격이 붙고 값은 동사에 오지 않는다", async () => {
  await authority.setCredential(credKey("desk", "social", "beta"), JSON.stringify({ token: "t-beta", user_id: "2" }));
  await rememberAccount(authority, "desk", "social", "beta");
  const r = (await run("post", { handle: "beta" })) as { all: string[]; connected: boolean; fields: Record<string, string>; echo: { auth: string } };
  assert.deepEqual(r.all, ["alpha", "beta"]);
  assert.equal(r.connected, true);
  assert.deepEqual(r.fields, { user_id: "2" }, "비밀 아닌 칸만 — header 칸(token)은 오지 않는다");
  assert.equal(r.echo.auth, "Bearer t-beta", "고른 계정의 자격으로 나갔다");
  // 워커의 거울도 같은 판정을 지난다 — 고르지 않으면 나가지 못하고, 축이 없으면 고를 수 없다
  await assert.rejects(() => run("unpicked"), /계정 축이 선언된 서비스입니다/);
  await assert.rejects(() => run("noaxis"), /계정 축이 없는 서비스입니다/);
});

// ── 화면이 읽는 전경 ─────────────────────────────────────────────────────────
test("연결 전경은 계정마다 한 줄을 싣는다 — 값은 실리지 않는다", async () => {
  const st = await serviceStatuses("desk", loadManifest(PKG), cred);
  const social = st.find((s) => s.name === "social")!;
  assert.deepEqual(social.accounts?.map((a) => a.name), ["alpha", "beta"]);
  assert.equal(social.hasCred, true, "계정이 하나라도 있으면 연결됨");
  assert.equal(st.find((s) => s.name === "solo")!.accounts, null, "축 없는 서비스는 null");
  assert.equal(JSON.stringify(st).includes("t-beta"), false, "자격 값이 전경에 실렸다");
});
