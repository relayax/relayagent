// edges[].agent_access — 세션이 edge 로 무엇을 만지는가. 기본 scripts-only: edge 도구는 언제나
// provider 의 동사다(서비스는 동사가 감싸서만 소비된다). full 은 명시 opt-in: provider 가
// services[].url.tools 에 선언한 원격 MCP 도구가 소비자 세션에 raw 로 선다.
//
// 세 문이 같은 답을 봐야 한다 — 목록(tools/list)·집행(callEdgeTool)·결재(addGrant). 하나라도
// 갈리면 "목록엔 있는데 못 부른다"거나 "결재는 됐는데 도구가 없다"가 된다.
//
//   node --experimental-strip-types --test runner/runtime/edge-access.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-edge-access-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { handleMcp } = await import("./tools.ts");
const { runScript } = await import("./scripts.ts");
const { localAuthority } = await import("../authority.ts");
const { addGrant } = await import("../supply/install.ts");
const { judge, loadManifest, ManifestError } = await import("../supply/manifest.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ── 가짜 원격 MCP 서버 — 도구 하나(search). 받은 신원 헤더를 결과에 실어 되돌린다 ──
const seen: Record<string, string | undefined>[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    seen.push({ method: msg.method, principal: req.headers["x-relay-principal"] as string | undefined, agent: req.headers["x-relay-agent"] as string | undefined });
    const result = msg.method === "tools/list"
      ? { tools: [{ name: "search", description: "ERP 검색", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }
      : { content: [{ type: "text", text: JSON.stringify({ echo: msg.params?.arguments ?? {} }) }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
server.unref();
const URL_ = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

function fixture(install: string, lineage: string, verbs: Record<string, string>, extra: string[]): string {
  const dir = mk(path.join(ROOT, install));
  fs.writeFileSync(path.join(dir, "relay.yaml"), [
    "schema: relay/v1",
    `name: "${lineage}"`,
    "version: 0.1.0",
    `display_name: "${install}"`,
    'description: "agent_access 시험 픽스처"',
    "scripts:",
    "  source: scripts",
    ...extra,
  ].join("\n") + "\n");
  const sdir = mk(path.join(dir, "scripts"));
  for (const [file, body] of Object.entries(verbs)) fs.writeFileSync(path.join(sdir, file), body);
  return dir;
}

// provider — 원격 MCP 서비스 하나(raw 로 빌려줄 수 있는 도구: search)와 그것을 감싼 동사 하나(wrap)
const PROV = fixture("prov", "@t/prov", {
  "wrap.ts": 'export default async function (i: any, ctx: any) { return { wrapped: await ctx.service("erp").call("search", { q: i.q }) }; }\n',
}, ["services:", "  - name: erp", `    url: "${URL_}"`, "    tools: [search]", "    auth: { kind: none }"]);
// 소비자 둘 — 같은 결재, agent_access 만 다르다
const CONS = fixture("cons", "@t/cons", {
  "peek.ts": 'export default async function (_i: any, ctx: any) { return await ctx.edge("@t/prov").call("search", { q: "x" }); }\n',
}, ["edges:", '  - provider: "@t/prov"', "    tools: [search, wrap]"]);
const RAWC = fixture("rawc", "@t/rawc", {
  "peek.ts": 'export default async function (_i: any, ctx: any) { return await ctx.edge("@t/prov").call("search", { q: "x" }); }\n',
}, ["edges:", '  - provider: "@t/prov"', "    tools: [search, wrap]", "    agent_access: full"]);

const ledger: Ledger = {
  secret: "edge-access-secret",
  packages: { prov: { path: PROV }, cons: { path: CONS }, rawc: { path: RAWC } },
  grants: [],
} as unknown as Ledger;
const authority = localAuthority(() => ledger);

async function mcp(pkg: string, method: string, params?: unknown): Promise<any> {
  let payload = "";
  const res = { writeHead: () => res, end: (s?: string) => void (payload = s ?? "") } as unknown as http.ServerResponse;
  await handleMcp(ledger, authority, null as unknown as HostBridge, pkg, pkg, { jsonrpc: "2.0", id: 1, method, params }, res, null);
  return JSON.parse(payload);
}
const names = async (pkg: string): Promise<string[]> => ((await mcp(pkg, "tools/list")).result.tools as { name: string }[]).map((t) => t.name);
/** MCP 결과 봉투의 본문 — content[0].text 를 JSON 으로 읽는다(원격 결과는 문 안에 한 번 더 싸여 온다) */
const bodyOf = (result: any): any => JSON.parse(result.content[0].text);

test("판정 — agent_access 는 scripts-only|full 만, tools 형에만", () => {
  const m = loadManifest(CONS);
  const bad = { ...m, edges: [{ provider: "@t/prov", tools: ["search"], agent_access: "ful" }] };
  assert.throws(() => judge(bad as typeof m, CONS), (e: unknown) => e instanceof ManifestError && e.issues.some((i) => i.includes("agent_access: scripts-only | full 만")));
  const wrong = { ...m, edges: [{ provider: "@t/prov", mission: "ask", agent_access: "full" }] };
  assert.throws(() => judge(wrong as typeof m, CONS), (e: unknown) => e instanceof ManifestError && e.issues.some((i) => i.includes("tools 형에만")));
});

test("결재 — raw 전용 도구는 full 없이 결재되지 않는다(처방을 싣는다); 동사는 언제나 결재된다", () => {
  assert.throws(() => addGrant(ledger, { consumer: "cons", provider: "prov", tools: ["search"] }), /agent_access: full/);
  addGrant(ledger, { consumer: "cons", provider: "prov", tools: ["wrap"] });
  addGrant(ledger, { consumer: "rawc", provider: "prov", tools: ["search", "wrap"] });
  assert.equal(ledger.grants.length, 2);
});

test("scripts-only — 목록에 raw 도구가 서지 않고, 이름을 알아도 E_RAW_ACCESS 로 막힌다(세션 문·동사 문 같은 답)", async () => {
  // 결재를 우회한 장부(직접 push)라도 집행이 막는다 — 결재와 집행은 별개의 담장이다
  ledger.grants.push({ consumer: "cons", provider: "prov", tools: ["search"] });
  const list = await names("cons");
  assert.ok(list.includes("edge__prov__wrap"), "감싼 동사는 선다");
  assert.ok(!list.includes("edge__prov__search"), "raw 도구는 scripts-only 목록에 서지 않는다");
  const r = await mcp("cons", "tools/call", { name: "edge__prov__search", arguments: { q: "x" } });
  assert.match(JSON.stringify(r), /E_RAW_ACCESS/);
  await assert.rejects(() => runScript(ledger, "cons", "peek", {}, { principal: "local" }, null, authority), /E_RAW_ACCESS/);
  // 동사로 감싼 길은 열려 있다 — 서비스는 동사가 감싸서 소비된다
  const via = await mcp("cons", "tools/call", { name: "edge__prov__wrap", arguments: { q: "hi" } });
  assert.deepEqual(bodyOf(bodyOf(via.result).wrapped), { echo: { q: "hi" } });
});

test("full — raw 도구가 서술·스키마와 함께 서고, provider 자격·호출자 신원으로 나간다", async () => {
  const r = await mcp("rawc", "tools/list");
  const raw = (r.result.tools as { name: string; description?: string; inputSchema?: unknown }[]).find((t) => t.name === "edge__prov__search");
  assert.ok(raw, "full 소비자에게는 raw 도구가 선다");
  assert.match(raw!.description ?? "", /ERP 검색/);
  assert.match(raw!.description ?? "", /raw/);
  assert.deepEqual(raw!.inputSchema, { type: "object", properties: { q: { type: "string" } } });
  const call = await mcp("rawc", "tools/call", { name: "edge__prov__search", arguments: { q: "y" } });
  assert.deepEqual(bodyOf(call.result), { echo: { q: "y" } });
  const last = seen[seen.length - 1];
  assert.equal(last.method, "tools/call");
  assert.equal(last.principal, authority.principal(), "신원은 호출자의 것");
  assert.equal(last.agent, "rawc", "agent 는 소비 세션의 얼굴");
  const viaVerb = await runScript(ledger, "rawc", "peek", {}, { principal: "local" }, null, authority);
  assert.deepEqual(viaVerb, { content: [{ type: "text", text: '{"echo":{"q":"x"}}' }] });
});

test("고지서 — full 은 raw 로 표시된다", async () => {
  const { disclosure } = await import("../supply/manifest.ts");
  assert.ok(disclosure(loadManifest(RAWC)).borrows[0].includes("raw"));
  assert.ok(!disclosure(loadManifest(CONS)).borrows[0].includes("raw"));
});
