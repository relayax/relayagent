// 동사는 데몬 밖에서 돈다 — 동사 안의 동기 자식 프로세스·예외·process.exit 가 기판을 붙들거나
// 죽이지 않고, ctx 의 문(폴더·REST·edge·host·신원)은 워커에서도 기판의 판정으로 그대로 열린다.
//
// 실측 2026-08-28: 동사 안의 spawnSync("sleep 5")·python3·gh 가 데몬 프로세스 안에서 돌아 콘솔·
// 위젯·세션 전부가 그 시간만큼 멈췄고, 사용자에게는 기판이 주기적으로 재기동되는 것으로 보였다.
//
//   node --experimental-strip-types --test runner/runtime/script-isolation.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { threadId } from "node:worker_threads";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-isolation-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { runScript, runScriptFrom, scriptMeta } = await import("./scripts.ts");
const { localAuthority } = await import("../authority.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 가짜 REST 몸 — 받은 헤더와 본문을 되돌려준다
const seen: { auth?: string; principal?: string; body: string; method: string }[] = [];
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ auth: req.headers.authorization, principal: req.headers["x-relay-principal"] as string | undefined, body, method: req.method ?? "" });
    res.writeHead(201, { "content-type": "application/json", "x-echo": "yes" });
    res.end(JSON.stringify({ echoed: body, path: req.url }));
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
api.unref();
const API = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

const PKG = mk(path.join(ROOT, "lab"));
fs.writeFileSync(path.join(PKG, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/lab"',
  "version: 0.1.0",
  'display_name: "격리 시험"',
  'description: "동사 격리 픽스처"',
  "scripts:",
  "  source: scripts",
  "services:",
  "  - name: box",
  '    dir: "~/box"',
  "  - name: rest",
  `    api: "${API}"`,
  "    auth: { kind: none }",
].join("\n") + "\n");
const S = mk(path.join(PKG, "scripts"));
const verb = (name: string, body: string) => fs.writeFileSync(path.join(S, name + ".ts"), body);
verb("block", 'import { spawnSync } from "node:child_process"; import { threadId } from "node:worker_threads";\nexport default async function () { spawnSync("sleep", ["1"]); return { threadId }; }\n');
verb("boom", 'export default async function () { throw new Error("터짐"); }\n');
verb("exit", 'export default async function () { process.exit(3); }\n');
verb("who", 'export default async function (_i: any, ctx: any) { return { pkg: ctx.pkg, caller: ctx.caller, host: ctx.host ? "yes" : "no", ws: ctx.workspace }; }\n');
verb("door", [
  "export default async function (i: any, ctx: any) {",
  '  await ctx.service("box").call("write", { path: i.path, content: i.content });',
  '  const back = await ctx.service("box").call("read", { path: i.path });',
  '  return { content: back.content, dir: ctx.dir("box"), url: ctx.service("box").url };',
  "}",
].join("\n") + "\n");
verb("rest", [
  "export default async function (i: any, ctx: any) {",
  '  const res = await ctx.service("rest").fetch("/things", { method: "POST", headers: { "content-type": "text/plain" }, body: i.text });',
  '  return { ok: res.ok, status: res.status, echo: res.headers.get("x-echo"), json: await res.json(), connected: await ctx.service("rest").connected() };',
  "}",
].join("\n") + "\n");
verb("late", [
  'import fs from "node:fs";',
  "export default async function (i: any, ctx: any) {",
  '  setTimeout(() => { void ctx.service("box").call("write", { path: "late.txt", content: "늦은 문" }); }, 150);',
  "  return { started: true };",
  "}",
].join("\n") + "\n");
verb("ring", 'export default async function (_i: any, ctx: any) { return { reg: await ctx.host.registry(), nested: await ctx.host.draftRead("x", "y") }; }\n');
verb("capped", 'export default async function (_i: any, ctx: any) { return await ctx.host.remove("x"); }\n');
verb("meta", 'export const meta = { description: "메타 시험", input: { type: "object" } };\nexport default async function () { return {}; }\n');
verb("badret", 'export default async function () { return { fn() {} }; }\n');

const ledger: Ledger = { secret: "iso", packages: { lab: { path: PKG, ring: 0 } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const host = {
  registry: () => ({ packages: ["lab"] }),
  draftRead: (name: string, file: string) => `${name}/${file}`,
  remove: () => {
    throw new Error("이 시험에서는 부르면 안 된다");
  },
} as unknown as HostBridge;
const run = (name: string, input: unknown = {}, bridge: HostBridge | null = host) =>
  runScript(ledger, "lab", name, input, { principal: "local", agent: "lab" }, bridge, authority);

test("동사 안의 spawnSync 가 데몬(main)을 붙들지 않는다 — 워커에서 돈다", async () => {
  const p = run("block");
  const t = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  const lag = Date.now() - t;
  assert.ok(lag < 500, `main 이 붙들렸다 — 50ms 타이머가 ${lag}ms 뒤에 깼다`);
  const r = (await p) as { threadId: number };
  assert.notEqual(r.threadId, threadId, "동사가 main 스레드에서 돌았다");
  assert.ok(r.threadId > 0);
});

test("예외는 사유 그대로 건너오고, process.exit 는 워커만 죽인다 — 다음 동사는 새 워커에서 돈다", async () => {
  await assert.rejects(() => run("boom"), /터짐/);
  await assert.rejects(() => run("exit"), /워커가 내려갔습니다\(exit 3\)/);
  const r = (await run("who")) as { pkg: string };
  assert.equal(r.pkg, "lab");
});

test("신원·바닥·host 유무가 그대로 보인다 — 미리보기(브리지 없음)는 host 가 없다", async () => {
  const r = (await run("who")) as { pkg: string; caller: unknown; host: string; ws: string };
  assert.deepEqual(r.caller, { principal: "local", agent: "lab" });
  assert.equal(r.host, "yes");
  assert.ok(fs.existsSync(r.ws), "workspace 는 여는 시점에 생긴다");
  const draft = (await runScriptFrom(ledger, "lab", PKG, "who", {}, { principal: "local" }, null, authority)) as { host: string };
  assert.equal(draft.host, "no");
});

test("폴더 문은 기판의 감금·연산을 그대로 지난다 — 경로와 주소는 동기로 안다", async () => {
  const r = (await run("door", { path: "a/b.txt", content: "상자" })) as { content: string; dir: string; url: string };
  assert.equal(r.content, "상자");
  assert.equal(r.url, "dir://box");
  assert.ok(fs.existsSync(path.join(r.dir, "a", "b.txt")));
  await assert.rejects(() => run("door", { path: "../out.txt", content: "x" }), /폴더 밖 경로/);
});

test("REST 문은 기판이 요청을 대신 나가고 Response 로 되돌아온다 — 상태·헤더·본문이 산다", async () => {
  const r = (await run("rest", { text: "본문" })) as { ok: boolean; status: number; echo: string; json: { echoed: string; path: string }; connected: boolean };
  assert.equal(r.status, 201);
  assert.equal(r.ok, true);
  assert.equal(r.echo, "yes");
  assert.deepEqual(r.json, { echoed: "본문", path: "/things" });
  assert.equal(r.connected, true);
  assert.equal(seen[seen.length - 1].method, "POST");
  assert.equal(seen[seen.length - 1].principal, undefined, "api 형은 신원을 밖에 흘리지 않는다");
});

test("반환 뒤의 문 — 백그라운드로 끝맺는 동사도 문을 잃지 않는다", async () => {
  await run("late");
  const file = path.join(process.env.HOME!, "box", "late.txt");
  for (let i = 0; i < 40 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(file, "utf8"), "늦은 문");
});

test("host 브리지는 거울로 닿고 캡은 기판이 집행한다", async () => {
  const r = (await run("ring")) as { reg: unknown; nested: string };
  assert.deepEqual(r.reg, { packages: ["lab"] });
  assert.equal(r.nested, "x/y");
  // host_methods 선언이 있는 매니페스트 — 목록 밖 메서드는 워커가 아니라 기판이 거절한다
  const capped = fs.readFileSync(path.join(PKG, "relay.yaml"), "utf8") + "host_methods: [host.registry]\n";
  const CAP = mk(path.join(ROOT, "cap"));
  fs.writeFileSync(path.join(CAP, "relay.yaml"), capped.replace('name: "@t/lab"', 'name: "@t/cap"'));
  fs.cpSync(S, path.join(CAP, "scripts"), { recursive: true });
  (ledger.packages as Record<string, unknown>).cap = { path: CAP, ring: 0 };
  await assert.rejects(() => runScript(ledger, "cap", "capped", {}, { principal: "local" }, host, authority), /host_methods 미선언 메서드: host\.remove/);
});

test("meta 도 워커가 읽는다 — 모듈 최상위가 데몬에서 도는 일이 없다", async () => {
  const m = await scriptMeta(ledger, "lab", "meta");
  assert.equal(m?.description, "메타 시험");
  assert.deepEqual(m?.input, { type: "object" });
  assert.equal(await scriptMeta(ledger, "lab", "boom"), null);
});

test("나를 수 없는 결과는 사유를 싣고 거절된다 — 동사 결과는 JSON 직렬화 가능한 값이다", async () => {
  await assert.rejects(() => run("badret"), /JSON 직렬화 가능한 값/);
});
