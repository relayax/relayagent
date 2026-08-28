// 시스템 패키지의 ring-0 동사는 워커에서 돈다 — ctx.host 는 거울이라 모든 호출이 Promise 다.
// 옛 동기 브리지 시절 그대로 결과를 객체에 넣거나 바로 읽으면 "동사 결과를 나를 수 없습니다 …
// #<Promise> could not be cloned"(실사고 2026-08-28, draft-list) 또는 undefined 접근으로 죽는다.
// 여기서는 **실제 시스템 동사 파일**을 워커 경로로 돌려 그 계약을 못박는다 — 브리지는 기판의 것과
// 같은 동기 스텁이고, 거울이 그것을 Promise 로 바꾸는 것까지가 시험 대상이다.
//
//   node --experimental-strip-types --test runner/runtime/ring0-verbs.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ring0-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { runScript } = await import("./scripts.ts");
const { localAuthority } = await import("../authority.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const SYSTEM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "system");
// pkg-read 가 읽을 설치본 하나 — 트리와 파일 원문
const INSTALLED = mk(path.join(ROOT, "memo"));
fs.writeFileSync(path.join(INSTALLED, "relay.yaml"), 'schema: relay/v1\nname: "@t/memo"\nversion: 0.1.0\n');
fs.writeFileSync(path.join(mk(path.join(INSTALLED, "scripts")), "save.ts"), "export default async () => ({})\n");

const ledger: Ledger = { secret: "r0", packages: { system: { path: SYSTEM, ring: 0 } }, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const calls: string[] = [];
// 기판의 makeHostBridge 와 같은 **동기** 반환 — 거울이 이것을 Promise 로 바꾼다
const host = {
  draftList: () => (calls.push("draftList"), [{ name: "todo", version: "0.1.0", changes: 2, installed: false, empty: false }]),
  releaseList: (name: string) => [{ version: "0.1.0", time: 1, live: true, name }],
  registry: () => ({
    packages: [{ name: "memo", path: INSTALLED, workspace: "/w/memo", ring: null, manifest: { name: "@t/memo", version: "0.1.0", display_name: "메모", description: "메모장", agents: [{ name: "memo" }], surfaces: { channels: [{ name: "slack" }] } }, error: null }],
    grants: [{ consumer: "a", provider: "b", tools: ["x"] }],
  }),
  draftRead: (name: string, file?: string) => (file ? { content: `name: "@t/${name}"\nversion: 0.1.0\n`, hash: "h1" } : { files: ["relay.yaml"], status: "open" }),
  draftWrite: (_name: string, files: Record<string, string>) => ({ written: Object.keys(files).length }),
  draftOpen: (name: string) => ({ path: `/drafts/${name}`, from: "empty" }),
} as unknown as HostBridge;
const run = (verb: string, input: unknown = {}) => runScript(ledger, "system", verb, input, { principal: "local", agent: "system" }, host, authority);

test("draft-list — 목록이 객체 안에 풀려서 문을 건넌다(실사고 재현)", async () => {
  const r = (await run("draft-list")) as { drafts: { name: string }[] };
  assert.deepEqual(r.drafts.map((d) => d.name), ["todo"]);
  assert.ok(calls.includes("draftList"));
});

test("release-list — 같은 모양", async () => {
  const r = (await run("release-list", { name: "memo" })) as { releases: { version: string }[] };
  assert.deepEqual(r.releases.map((x) => x.version), ["0.1.0"]);
});

test("pkg-list — 장부를 풀어 읽고 채널·에이전트를 센다", async () => {
  const r = (await run("pkg-list")) as { packages: { name: string; agents: string[]; channels: string[] }[]; grants: unknown[] };
  assert.equal(r.packages.length, 1);
  assert.deepEqual(r.packages[0].agents, ["memo"]);
  assert.deepEqual(r.packages[0].channels, ["slack"]);
  assert.equal(r.grants.length, 1);
});

test("pkg-read — 매니페스트·트리, 그리고 파일 원문", async () => {
  const all = (await run("pkg-read", { name: "memo" })) as { manifest: string; tree: string[] };
  assert.match(all.manifest, /@t\/memo/);
  assert.ok(all.tree.includes("scripts/"));
  const one = (await run("pkg-read", { name: "memo", file: "scripts/save.ts" })) as { content: string };
  assert.match(one.content, /export default/);
  await assert.rejects(() => run("pkg-read", { name: "memo", file: "../relay.yaml" }), /경로 탈출/);
});

test("draft-open — 스캐폴드 판정(draftList·registry)과 열기·읽기 결과의 병합이 전부 풀린 값이다", async () => {
  const r = (await run("draft-open", { name: "fresh", manifest: { name: "@t/fresh", scripts: { source: "scripts" }, agents: [{ name: "fresh", persona: "agents/fresh/AGENT.md" }] } })) as Record<string, unknown>;
  assert.equal(r.path, "/drafts/fresh");
  assert.equal(r.from, "empty");
  assert.deepEqual(r.files, ["relay.yaml"]);
  // 있는 이름 위에 스캐폴드는 거부 — 판정도 풀린 목록으로 한다
  await assert.rejects(() => run("draft-open", { name: "todo", manifest: { name: "@t/todo" } }), /이미 있는 대상/);
});

test("draft-icon — 읽은 매니페스트에 icon 줄을 앉히고 쓴 결과를 병합한다", async () => {
  const r = (await run("draft-icon", { name: "fresh", emoji: "📒" })) as { written: number; icon: string; glyph: string };
  assert.equal(r.icon, "assets/icon.svg");
  assert.equal(r.glyph, "u1F4D2.svg");
  assert.equal(r.written, 2); // icon.svg + icon 줄이 더해진 relay.yaml
});
