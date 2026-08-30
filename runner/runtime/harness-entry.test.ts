import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// POOL_DIR 은 모듈 적재 시점의 RELAY_HOME 을 딛는다 — import 전에 홈을 갈라야 사용자의 실제
// 풀을 건드리지 않는다. 자격 축도 같이 격리한다(테스트가 Keychain 을 오염시키는 것은 사고다)
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pool-test-"));
process.env.RELAY_HOME = HOME;
process.env.RELAY_VAULT = "file";

const { POOL_DIR, poolNames, poolVariant, harnessCandidates, harnessSite, chooseHarness } =
  await import("./harness-entry.ts");

function putPool(name: string, decl: Record<string, unknown> = {}): void {
  const dir = path.join(POOL_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "harness.json"), JSON.stringify(decl));
}

function clearPool(): void {
  fs.rmSync(POOL_DIR, { recursive: true, force: true });
}

test("풀이 비면 후보는 동봉분뿐 — 풀이 없는 기판에서 현행 동작 그대로", () => {
  clearPool();
  const m = { harness: { variants: [{ name: "claude-code", source: "harness/claude-code", entry: "run" }] } };
  assert.deepEqual(harnessCandidates(m as never).map((v) => v.name), ["claude-code"]);
  assert.equal(poolNames().length, 0);
});

test("동봉 이름이 풀에도 있으면 후보가 풀 전체로 열린다 — 스캐폴드 한 줄이 잠금이 되지 않는다", () => {
  clearPool();
  putPool("claude-code", { llm: { provider: "anthropic", auth: { kind: "oauth" } } });
  putPool("codex", { llm: { provider: "openai", auth: { kind: "oauth" } } });
  putPool("kimi", { llm: { provider: "moonshot", auth: { kind: "token" } } });
  // 설치본 9개 중 8개가 이 모양이었다 — claude-code 한 줄만 동봉해서 피커에 선택지가 하나였다
  const m = { harness: { variants: [{ name: "claude-code", source: "harness/claude-code", entry: "run" }] } };
  assert.deepEqual(harnessCandidates(m as never).map((v) => v.name).sort(), ["claude-code", "codex", "kimi"]);
});

test("선언이 아예 없어도 풀 전체가 후보다", () => {
  clearPool();
  putPool("codex");
  putPool("kimi");
  assert.deepEqual(harnessCandidates({} as never).map((v) => v.name).sort(), ["codex", "kimi"]);
});

test("풀이 사본을 이긴다 — 판이 갈린 동봉 어댑터가 정본 행세를 하지 않는다", () => {
  clearPool();
  putPool("claude-code", { llm: { provider: "anthropic" } });
  const v = { name: "claude-code", source: "harness/claude-code", entry: "run" };
  const site = harnessSite("/some/package", v as never);
  assert.equal(site.origin, "pool");
  assert.equal(site.entry, path.join(POOL_DIR, "claude-code", "run"));
});

test("풀에 없는 이름은 사본으로 돈다 — 새 하네스가 들어오는 문", () => {
  clearPool();
  putPool("claude-code");
  const v = { name: "hermes", source: "harness/hermes", entry: "run" };
  const site = harnessSite("/some/package", v as never);
  assert.equal(site.origin, "bundled");
  assert.equal(site.entry, path.join("/some/package", "harness/hermes/run"));
});

test("requires 는 능력 선언으로 후보를 거른다", () => {
  clearPool();
  putPool("claude-code", { capabilities: ["cancel", "vision", "steer"] });
  putPool("kimi", { capabilities: ["cancel", "resume"] });
  const m = { harness: { requires: ["vision"] } };
  const c = chooseHarness(m as never);
  assert.equal(c.variant?.name, "claude-code");
  assert.deepEqual(c.candidates.map((v) => v.name), ["claude-code"]);
});

test("능력을 선언하지 않은 변형은 requires 를 만족으로 세지 않는다 — 모르는 것을 된다고 하지 않는다", () => {
  clearPool();
  putPool("mystery", {}); // capabilities 선언 없음
  const c = chooseHarness({ harness: { requires: ["vision"] } } as never);
  assert.equal(c.variant, null);
  assert.match(c.reason ?? "", /vision/);
});

test("후보가 비면 조용히 첫 번째로 넘어가지 않고 사유를 낸다", () => {
  clearPool();
  const c = chooseHarness({} as never);
  assert.equal(c.variant, null);
  assert.match(c.reason ?? "", /하네스가 없습니다/);
});

test("우선순위: 사용자 선택 → prefers → 전역 선호 → 첫 후보", () => {
  clearPool();
  putPool("claude-code");
  putPool("codex");
  putPool("kimi");
  const m = { harness: { prefers: "codex" } } as never;
  assert.equal(chooseHarness(m, "kimi", "claude-code").variant?.name, "kimi", "사용자 선택이 최우선");
  assert.equal(chooseHarness(m, undefined, "claude-code").variant?.name, "codex", "저자의 prefers 가 전역 선호를 이긴다");
  assert.equal(chooseHarness({} as never, undefined, "kimi").variant?.name, "kimi", "선언이 없으면 전역 선호");
  assert.equal(chooseHarness({} as never).variant?.name, "claude-code", "아무것도 없으면 첫 후보(정렬 순)");
});

test("사라진 이름은 조용히 무시되고 다음 우선순위로 넘어간다", () => {
  clearPool();
  putPool("codex");
  // 장부에는 claude-code 인데 풀에서 사라진 상황 — 종전 `?? vs[0]` 은 말없이 넘어갔고
  // 화면은 계속 claude-code 를 그렸다. 지금도 넘어가지만 그 답이 후보 안이라는 보증이 있다
  const c = chooseHarness({} as never, "claude-code");
  assert.equal(c.variant?.name, "codex");
});

test("풀 좌표는 slug 만 받는다 — 상위 이동으로 밖을 읽지 않는다", () => {
  clearPool();
  putPool("codex");
  assert.equal(poolVariant("../../etc"), null);
  assert.equal(poolVariant("Codex"), null); // 대문자도 slug 가 아니다
  assert.notEqual(poolVariant("codex"), null);
});

// ── 제공사 집계 ────────────────────────────────────────────────────────────
const { providerStatuses } = await import("./connections.ts");

test("제공사 목록은 풀에서 나온다 — 앱을 하나도 안 깔아도 선다", async () => {
  clearPool();
  putPool("claude-code", { llm: { provider: "anthropic", auth: { kind: "oauth" } } });
  putPool("kimi", { llm: { provider: "moonshot", auth: { kind: "token" } } });
  const ps = await providerStatuses({ packages: {} } as never, async () => null);
  assert.deepEqual(ps.map((p) => p.provider), ["anthropic", "moonshot"]);
  assert.deepEqual(ps.map((p) => p.kind), ["oauth", "token"]);
  assert.ok(ps.every((p) => p.origin === "pool"));
});

test("자격 값은 응답에 절대 실리지 않는다 — hasCred 만 나간다", async () => {
  clearPool();
  putPool("kimi", { llm: { provider: "moonshot", auth: { kind: "token" } } });
  const SECRET = "sk-this-must-never-leave";
  const ps = await providerStatuses({ packages: {} } as never, async () => SECRET);
  assert.equal(ps[0].hasCred, true);
  assert.ok(!JSON.stringify(ps).includes(SECRET), "직렬화 어디에도 자격 값이 없어야 한다");
});

test("provider 를 말하지 않는 어댑터는 목록에 서지 않는다 — 연결할 것이 없다", async () => {
  clearPool();
  putPool("mystery", {});
  assert.deepEqual(await providerStatuses({ packages: {} } as never, async () => null), []);
});

test("oauth 형은 금고가 비어 있어도 '연결 안 됨'이 아니다 — 자격이 도구 소유라 금고는 영영 빈다", async () => {
  clearPool();
  putPool("claude-code", { llm: { provider: "anthropic", auth: { kind: "oauth" } } });
  const ps = await providerStatuses({ packages: {} } as never, async () => null);
  const a = ps.find((p) => p.provider === "anthropic")!;
  assert.equal(a.hasCred, false, "금고는 비어 있다 — 그것이 설계다");
  // 화면이 그리는 것은 ready 다. 목록만으로는 **모른다** — null 이지 false 가 아니다.
  // false 로 두면 claude 가 멀쩡히 도는데 화면이 "연결 안 됨" 이라 말한다(실사고 2026-08-30)
  assert.equal(a.ready, null, "안 물어봤으면 모르는 것이지 안 되는 것이 아니다");
  assert.equal(a.reason, null);
});

test("준비 상태는 어댑터의 답을 provider 축으로 접는다 — 한 쪽만 준비돼도 그 provider 는 쓸 수 있다", async () => {
  const { probeProviders } = await import("./connections.ts");
  const got = await probeProviders({ packages: { system: { path: "/x" } } } as never, async () => [
    { provider: "anthropic", ready: false, reason: "no-auth" as const, account: null },
    { provider: "anthropic", ready: true, reason: "ok" as const, account: { email: "a@b.c" } },
    { provider: null, ready: true, reason: "ok" as const, account: null },
  ]);
  assert.equal(got.anthropic.ready, true);
  assert.deepEqual(got.anthropic.account, { email: "a@b.c" });
  assert.equal(Object.keys(got).length, 1, "provider 를 말하지 않는 어댑터는 접히지 않는다");
});

// ── seedPool 왕복 ──────────────────────────────────────────────────────────
// 위 시험들이 못 잡은 부류: putPool() 이 harness.json 을 **손으로** 써서, 실제 변환
// (seedPool → poolVariant)을 지나는 시험이 하나도 없었다. 그래서 seedPool 이 선언을
// 떨어뜨려도 16개가 전부 통과했다(실사고 2026-08-30). 여기서는 진짜 seedPool 을 태운다.
const { seedPool, poolRecipe } = await import("./harness-entry.ts");

/** 콘솔 패키지 흉내 — 어댑터 하나를 동봉하고 relay.yaml 로 선언한다 */
function fakeConsole(dir: string, yaml: string): { packages: Record<string, { path: string }> } {
  fs.mkdirSync(path.join(dir, "harness", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "harness", "demo", "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "relay.yaml"), yaml);
  return { packages: { system: { path: dir } } };
}

const DECL = `schema: relay/v1
name: "@relay/demo"
version: 0.1.0
display_name: 데모
description: 왕복 시험용 가짜 콘솔 패키지
requires:
  binaries:
    - name: demo-cli
      manager: npm
      package: "@demo/cli"
      install: "npm i -g @demo/cli"
harness:
  variants:
    - name: demo
      source: harness/demo
      entry: run
      binary: demo-cli
      protocol: 3
      capabilities: [cancel, vision, steer]
      llm:
        provider: demoprov
        auth: { kind: token, env: DEMO_KEY }
`;

test("seedPool 왕복 — 선언이 손실 없이 풀에 실린다 (protocol·capabilities·레시피)", () => {
  clearPool();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "relay-seed-"));
  const seeded = seedPool(fakeConsole(src, DECL), "system");
  assert.deepEqual(seeded?.seeded, ["demo"]);

  const v = poolVariant("demo")!;
  // 이 셋이 종전에 증발했다 — 그래서 harness.requires 가 전부 실패했다
  assert.equal(v.protocol, 3, "protocol 이 풀에 실려야 한다");
  assert.deepEqual(v.capabilities, ["cancel", "vision", "steer"], "capabilities 가 풀에 실려야 한다");
  assert.equal(v.llm?.provider, "demoprov");
  assert.equal(v.llm?.auth?.env, "DEMO_KEY");

  // 레시피 — 이름만 나르면 소비 패키지가 그 이름을 자기 매니페스트에서 못 찾는다
  const r = poolRecipe("demo");
  assert.equal(r?.name, "demo-cli");
  assert.equal(r?.manager, "npm");
  assert.equal(r?.package, "@demo/cli");
});

test("풀을 지난 뒤에도 requires 가 산다 — 왕복이 끝난 상태로 후보를 거른다", () => {
  clearPool();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "relay-seed-"));
  seedPool(fakeConsole(src, DECL), "system");

  assert.equal(chooseHarness({ harness: { requires: ["vision"] } } as never).variant?.name, "demo");
  const miss = chooseHarness({ harness: { requires: ["remote"] } } as never);
  assert.equal(miss.variant, null, "없는 능력은 여전히 걸러야 한다");
  assert.match(miss.reason ?? "", /remote/);
});

test("변환 코드가 바뀌면 다시 편다 — 지문이 소스 mtime 만 보면 낡은 선언이 남는다", () => {
  clearPool();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "relay-seed-"));
  const ledger = fakeConsole(src, DECL);
  seedPool(ledger, "system");
  assert.equal(seedPool(ledger, "system"), null, "그대로면 다시 펴지 않는다");

  // 낡은 판으로 펴진 기판을 흉내낸다 — 어댑터 소스는 그대로인데 선언만 옛것이다
  fs.writeFileSync(path.join(POOL_DIR, "demo", "harness.json"), JSON.stringify({ llm: { provider: "demoprov" } }));
  const stamp = path.join(POOL_DIR, ".source");
  fs.writeFileSync(stamp, fs.readFileSync(stamp, "utf8").replace(/^decl=\d+/, "decl=1"));

  assert.notEqual(seedPool(ledger, "system"), null, "선언 스키마 판이 다르면 다시 편다");
  assert.deepEqual(poolVariant("demo")?.capabilities, ["cancel", "vision", "steer"]);
});
