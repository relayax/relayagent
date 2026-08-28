// dir 문의 집행 — 선언이 캡이고, 감금은 기판의 몫이다.
//
// 이 축이 조용히 회귀하는 자리라 시험을 붙인다: 감금이 뚫리면 "폴더 하나"라고 고지한 선언이
// 파일시스템 전체가 된다. 문은 동사 문(ctx.service) 하나다 — 세션에 폴더 도구(dir__*)를 세우던
// 축은 2026-08-28 은퇴했고, 그것이 다시 서지 않는 것도 여기서 지킨다(서비스는 동사가 감싸서만 소비된다).
//
//   node --experimental-strip-types --test runner/runtime/dirs.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dirs-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { runScript } = await import("./scripts.ts");
const { handleMcp } = await import("./tools.ts");
const { jail, dirCall } = await import("./dirs.ts");
const { judge, loadManifest, ManifestError } = await import("../supply/manifest.ts");
const { localAuthority } = await import("../authority.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 선언은 `~` 신청이고 설치 결재가 그것을 실제 폴더에 묶는다 — 여기서는 임시 홈이 그 자리다
const INBOX = path.join(process.env.HOME!, "inbox");
const OUTSIDE = mk(path.join(ROOT, "outside"));
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "남의 것");

// 폴더 하나를 선언하고, 그 폴더를 문으로 쓰는 동사들을 가진 최소 패키지
const PKG = mk(path.join(ROOT, "orders"));
fs.writeFileSync(
  path.join(PKG, "relay.yaml"),
  [
    "schema: relay/v1",
    'name: "@t/orders"',
    "version: 0.1.0",
    'display_name: "주문"',
    'description: "dir 문 시험 픽스처"',
    "harness:",
    "  variants:",
    "    - name: shell",
    "      source: harness",
    "      entry: run",
    "agents:",
    "  - name: orders",
    "    persona: AGENT.md",
    "    scripts: [get, ls]",
    "scripts:",
    "  source: scripts",
    "services:",
    "  - name: inbox",
    '    dir: "~/inbox"',
  ].join("\n") + "\n",
);
fs.writeFileSync(path.join(PKG, "AGENT.md"), "주문 에이전트\n");
fs.writeFileSync(path.join(mk(path.join(PKG, "harness")), "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const SCRIPTS = mk(path.join(PKG, "scripts"));
const verb = (name: string, body: string) => fs.writeFileSync(path.join(SCRIPTS, name + ".ts"), body);
verb("put", 'export default async function (i: any, ctx: any) { return await ctx.service("inbox").call("write", { path: i.path, content: i.content }); }\n');
verb("get", 'export default async function (i: any, ctx: any) { return await ctx.service("inbox").call("read", { path: i.path }); }\n');
verb("ls", 'export default async function (_i: any, ctx: any) { return await ctx.service("inbox").call("list", {}); }\n');
verb("escape", 'export default async function (_i: any, ctx: any) { return await ctx.service("inbox").call("read", { path: "../outside/secret.txt" }); }\n');
verb("absolute", 'export default async function (i: any, ctx: any) { return await ctx.service("inbox").call("read", { path: i.path }); }\n');
verb("rest", 'export default async function (_i: any, ctx: any) { return await ctx.service("inbox").fetch("/x"); }\n');
verb("bogus", 'export default async function (_i: any, ctx: any) { return await ctx.service("inbox").call("chmod", {}); }\n');

const ledger: Ledger = { packages: { orders: { path: PKG } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const run = (verbName: string, input: unknown = {}) =>
  runScript(ledger, "orders", verbName, input, { principal: "local" }, null, authority);

test("동사는 선언한 폴더에 파일 문으로 닿는다 — 쓰고 읽고 나열한다", async () => {
  await run("put", { path: "2026-08/order-1.txt", content: "주문 하나" });
  const read = (await run("get", { path: "2026-08/order-1.txt" })) as { content: string; bytes: number };
  assert.equal(read.content, "주문 하나");
  const listed = (await run("ls")) as { entries: { path: string; dir: boolean }[] };
  assert.ok(listed.entries.some((e) => e.path === "2026-08" && e.dir));
});

test("`..` 등반은 막힌다 — 선언한 폴더가 곧 캡이다", async () => {
  await assert.rejects(() => run("escape"), /폴더 밖 경로/);
});

test("절대경로는 받지 않는다 — 이 문의 좌표는 폴더 기준 상대경로뿐이다", async () => {
  await assert.rejects(() => run("absolute", { path: path.join(OUTSIDE, "secret.txt") }), /절대경로는 받지 않습니다/);
});

test("심링크로도 나가지 못한다 — resolve 는 링크를 따라가지 않으므로 realpath 로 한 번 더 본다", () => {
  const link = path.join(INBOX, "shortcut");
  if (!fs.existsSync(link)) fs.symlinkSync(OUTSIDE, link);
  assert.throws(() => jail(INBOX, "shortcut/secret.txt"), /폴더 밖 경로/);
});

test("폴더 문에는 fetch 가 없고, 없는 연산은 조용히 통과하지 않는다", async () => {
  await assert.rejects(() => run("rest"), /폴더 문에는 fetch 가 없습니다/);
  await assert.rejects(() => run("bogus"), /dir 문에 없는 연산: chmod/);
});

test("폴더 뿌리는 지울 수 없다 — 이 문이 사는 자리다", async () => {
  await assert.rejects(() => dirCall(INBOX, "remove", { path: "." }), /뿌리는 지울 수 없습니다/);
});

test("판정은 은퇴한 agents[].dirs 를 처방과 함께 거부한다 — 조용히 무시하면 저작자는 도구가 서는 줄 안다", () => {
  const m = loadManifest(PKG);
  const bad = { ...m, agents: [{ name: "orders", persona: "AGENT.md", dirs: ["inbox"] }] };
  assert.throws(
    () => judge(bad as typeof m, PKG),
    (e: unknown) => e instanceof ManifestError && e.issues.some((i) => i.includes("agents[orders].dirs 는 은퇴했습니다")),
  );
});

// ── 세션 문 — 에이전트가 실제로 보는 것 ──────────────────────────────────────
// 폴더는 동사가 감싸서만 닿는다: 세션의 목록에 폴더 도구가 없고, 이름을 알아도 열리지 않는다.

/** 데몬의 응답 자리 — handleMcp 는 json(res, …) 로만 쓴다(writeHead + end) */
function fakeRes(): { body: () => any; res: any } {
  let payload = "";
  const res = { writeHead: () => res, end: (b?: string) => { payload = b ?? ""; } };
  return { body: () => JSON.parse(payload || "{}"), res };
}

const mcp = async (method: string, params?: unknown): Promise<any> => {
  const { body, res } = fakeRes();
  await handleMcp(ledger, authority, {} as never, "orders", "orders", { jsonrpc: "2.0", id: 1, method, params }, res as never, null);
  return body();
};

test("세션의 목록에는 폴더 도구가 없다 — 보이는 것은 폴더를 감싼 동사뿐이다", async () => {
  const names = ((await mcp("tools/list")).result.tools as { name: string }[]).map((t) => t.name);
  assert.deepEqual(names.filter((n) => n.startsWith("dir__")), []);
  assert.deepEqual(names.filter((n) => n === "get" || n === "ls").sort(), ["get", "ls"]);
});

test("옛 이름을 알아도 폴더는 열리지 않는다 — 목록과 집행이 같은 집합을 본다", async () => {
  await run("put", { path: "note.txt", content: "한 줄" });
  const r = await mcp("tools/call", { name: "dir__inbox__read", arguments: { path: "note.txt" } });
  assert.ok(r.error || r.result?.isError, "은퇴한 폴더 도구가 열렸다");
  assert.doesNotMatch(JSON.stringify(r), /한 줄/);
  // 같은 파일은 동사로는 닿는다
  const via = await mcp("tools/call", { name: "get", arguments: { path: "note.txt" } });
  assert.match(JSON.stringify(via.result), /한 줄/);
});
