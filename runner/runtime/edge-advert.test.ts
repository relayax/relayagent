// 빌린 동사의 광고 — edge 결재로 세션에 서는 남의 동사(edge__<provider>__<tool>)가 자기 동사와
// 같은 앎(meta 의 서술·입력 스키마)을 싣는가.
//
// 이름만 서던 자리다: 세션은 남의 동사를 부를 수는 있었지만 인자 형을 몰랐고, 그래서
// "타 패키지의 스크립트를 가져온다"가 절반만 성립했다. 또 하나 — provider 의 매니페스트가
// 판정에 실패해도 소비자의 목록은 서야 한다(남의 판정 실패가 내 도구 전부를 지우면 안 된다).
//
//   node --experimental-strip-types --test runner/runtime/edge-advert.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type http from "node:http";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-edge-advert-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { handleMcp } = await import("./tools.ts");
const { localAuthority } = await import("../authority.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function fixture(install: string, lineage: string, verbs: Record<string, string>, extra: string[] = [], manifestOverride?: string): string {
  const dir = mk(path.join(ROOT, install));
  fs.writeFileSync(
    path.join(dir, "relay.yaml"),
    manifestOverride ??
      [
        "schema: relay/v1",
        `name: "${lineage}"`,
        "version: 0.1.0",
        `display_name: "${install}"`,
        `description: "edge 광고 시험 픽스처"`,
        "scripts:",
        "  source: scripts",
        ...extra,
      ].join("\n") + "\n",
  );
  const sdir = mk(path.join(dir, "scripts"));
  for (const [file, body] of Object.entries(verbs)) fs.writeFileSync(path.join(sdir, file), body);
  return dir;
}

const SCHEMA = { type: "object", required: ["offer"], properties: { offer: { type: "string", description: "제안서 id" } } };

// provider — 메타를 수출한 동사 하나, 안 한 동사 하나
const PROV = fixture("prov", "@t/prov", {
  "answers-read.ts":
    `export const meta = { description: "제안서 답변 읽기 — 셀 값을 돌려준다", input: ${JSON.stringify(SCHEMA)} };\n` +
    "export default async function (input) { return { offer: input.offer }; }\n",
  "bare.ts": "export default async function () { return {}; }\n",
});

// consumer — 둘 다 빌린다. 판정 실패 provider(broken)도 빌린다
const CONS = fixture("cons", "@t/cons", {}, [
  "edges:",
  '  - provider: "@t/prov"',
  "    tools: [answers-read, bare]",
  '  - provider: "@t/broken"',
  "    tools: [x]",
]);

// 판정에 실패하는 provider — description 이 없다
const BROKEN = fixture("broken", "@t/broken", { "x.ts": "export default async function () { return {}; }\n" }, [], [
  "schema: relay/v1",
  'name: "@t/broken"',
  "version: 0.1.0",
  "scripts:",
  "  source: scripts",
].join("\n") + "\n");

const ledger: Ledger = {
  secret: "edge-advert-secret",
  packages: { prov: { path: PROV }, cons: { path: CONS }, broken: { path: BROKEN } },
  grants: [
    { consumer: "cons", provider: "prov", tools: ["answers-read", "bare"] },
    { consumer: "cons", provider: "broken", tools: ["x"] },
  ],
} as unknown as Ledger;
const authority = localAuthority(() => ledger);

async function list(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
  let payload = "";
  const res = { writeHead: () => res, end: (s?: string) => void (payload = s ?? "") } as unknown as http.ServerResponse;
  await handleMcp(ledger, authority, null as unknown as HostBridge, "cons", "cons", { jsonrpc: "2.0", id: 1, method: "tools/list" }, res, null);
  return JSON.parse(payload).result.tools;
}

test("메타를 수출한 동사는 빌린 쪽 세션에도 서술·입력 스키마가 선다", async () => {
  const tool = (await list()).find((t) => t.name === "edge__prov__answers-read");
  assert.ok(tool, "결재된 edge 도구가 목록에 있어야 한다");
  assert.match(tool!.description ?? "", /제안서 답변 읽기/);
  assert.match(tool!.description ?? "", /prov/); // 어느 패키지의 동사인지는 남긴다
  assert.deepEqual(tool!.inputSchema, SCHEMA);
});

test("메타 없는 동사는 종전 서술 + 관용 스키마로 선다 — 회귀 없음", async () => {
  const tool = (await list()).find((t) => t.name === "edge__prov__bare");
  assert.ok(tool);
  assert.equal(tool!.description, "edge 소비: prov 의 bare");
  assert.deepEqual(tool!.inputSchema, { type: "object", additionalProperties: true });
});

test("provider 의 판정 실패가 소비자의 목록을 무너뜨리지 않는다 — 그 도구는 이름으로 선다", async () => {
  const tools = await list();
  const tool = tools.find((t) => t.name === "edge__broken__x");
  assert.ok(tool, "판정 실패 provider 의 도구도 이름으로는 서야 한다");
  assert.equal(tool!.description, "edge 소비: broken 의 x");
  assert.ok(tools.some((t) => t.name === "edge__prov__answers-read"), "다른 provider 의 도구가 함께 살아 있어야 한다");
});
