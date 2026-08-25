// edge 소비(ctx.edge)의 집행 — 선언은 캡, 결재는 승인. 세션 문(edge__*)과 동사 문이 같은
// 판정 한 벌을 지나므로, 여기서 막히는 것은 양쪽에서 막힌다.
//
// 이 축이 조용히 회귀하는 자리라 시험을 붙인다: 결재 없이 통과하면 남의 동사가 무단으로
// 열리고(캡이 광고가 된다), 순환을 못 끊으면 서로 부르는 두 패키지가 스택을 태우고 죽는데
// 그 실패에는 원인이 남지 않는다.
//
//   node --experimental-strip-types --test runner/runtime/edge-consume.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

// 모듈 적재 시점에 각인되는 좌표(RELAY_HOME·홈)를 임시 자리로 돌린다 — 사용자의 진짜 장부에 쓰지 않는다
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-edge-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { runScript } = await import("./scripts.ts");
const { localAuthority } = await import("../authority.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 판정을 통과하는 최소 패키지 하나 — 동사 몇 개와 선택적 edges 선언 */
function fixture(install: string, lineage: string, verbs: Record<string, string>, edges = ""): string {
  const dir = mk(path.join(ROOT, install));
  fs.writeFileSync(
    path.join(dir, "relay.yaml"),
    [
      "schema: relay/v1",
      `name: "${lineage}"`,
      "version: 0.1.0",
      `display_name: "${install}"`,
      `description: "edge 소비 시험 픽스처"`,
      "scripts:",
      "  source: scripts",
      edges,
    ].filter(Boolean).join("\n") + "\n",
  );
  const sdir = mk(path.join(dir, "scripts"));
  for (const [file, body] of Object.entries(verbs)) fs.writeFileSync(path.join(sdir, file), body);
  return dir;
}

// provider — 자기 데이터를 자기가 읽어 돌려주는 동사 둘(하나는 결재 밖으로 남긴다)
const PROV = fixture("prov", "@t/prov", {
  "answers-read.ts": "export default async function (input: any) { return { offer: input.offer, cells: { C25: '값' } }; }\n",
  "secret-read.ts": "export default async function () { return { secret: true }; }\n",
  // 순환 시험 — provider 가 소비자를 되부른다
  "bounce.ts": "export default async function (_i: any, ctx: any) { return await ctx.edge('@t/cons').call('use', {}); }\n",
}, ["edges:", '  - provider: "@t/cons"', "    tools: [use]"].join("\n"));

// consumer — 남의 동사로만 재료를 읽는다(남의 폴더를 dir 로 가리키지 않는다)
const CONS = fixture("cons", "@t/cons", {
  "use.ts": "export default async function (_i: any, ctx: any) { return await ctx.edge('@t/prov').call('answers-read', { offer: 'x' }); }\n",
  "peek.ts": "export default async function (_i: any, ctx: any) { return await ctx.edge('@t/prov').call('secret-read', {}); }\n",
  "loop.ts": "export default async function (_i: any, ctx: any) { return await ctx.edge('@t/prov').call('bounce', {}); }\n",
  "ghost.ts": "export default async function (_i: any, ctx: any) { return await ctx.edge('@t/nobody').call('x', {}); }\n",
}, ["edges:", '  - provider: "@t/prov"', "    tools: [answers-read, secret-read, bounce]"].join("\n"));

const ledger: Ledger = { packages: { prov: { path: PROV }, cons: { path: CONS } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const caller = { principal: "local" };
const run = (pkg: string, verb: string) => runScript(ledger, pkg, verb, {}, caller, null, authority);

test("결재 없는 소비는 막힌다 — 선언만으로는 열리지 않는다", async () => {
  await assert.rejects(() => run("cons", "use"), /E_NO_GRANT: cons -> prov\/answers-read/);
});

test("결재된 동사 하나가 열린다 — 값은 provider 의 실행 결과다", async () => {
  ledger.grants.push({ consumer: "cons", provider: "prov", tools: ["answers-read"] });
  assert.deepEqual(await run("cons", "use"), { offer: "x", cells: { C25: "값" } });
});

test("결재는 동사 단위다 — 같은 provider 라도 결재 밖 동사는 막힌다", async () => {
  await assert.rejects(() => run("cons", "peek"), /E_NO_GRANT: cons -> prov\/secret-read/);
});

test("순환 소비는 사슬을 실어 끊는다 — 스택을 태우지 않는다", async () => {
  ledger.grants.push({ consumer: "cons", provider: "prov", tools: ["bounce"] });
  ledger.grants.push({ consumer: "prov", provider: "cons", tools: ["use"] });
  await assert.rejects(() => run("cons", "loop"), /E_EDGE_CYCLE:.*cons -> prov -> cons/);
});

test("미설치 provider 는 사유를 실어 거절한다 — 없는 기록으로 죽지 않는다", async () => {
  await assert.rejects(() => run("cons", "ghost"), /E_NO_PROVIDER/);
});
