// 묶음 — 설치본 여럿이 폴더 하나로 묶이고, 그 묶음이 봉투 하나(.relaypackages)로 나가고 들어온다.
// 설치 순서(제공자 먼저)·안쪽 봉인 대조·왕복 뒤의 결재 복원이 계약이다.
//
//   node --experimental-strip-types --test runner/supply/suites.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-suites-"));
process.env.HOME = path.join(ROOT, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });

const { loadLedger, saveLedger } = await import("./ledger.ts");
const { installPkg } = await import("./install.ts");
const { loadSuites, upsertSuite, removeSuite, installOrder, suiteClosure, packSuite, isSuiteArchive, prepareSuite, activateSuite } = await import("./suites.ts");
const { listArtifact, packDir } = await import("./pack.ts");

/** 판정을 통과하는 최소 패키지 — 하네스·에이전트 없음(설치가 setup·conform 을 건너뛴다) */
function seat(name: string, extra: string, opts: { components?: boolean } = {}): string {
  const d = path.join(ROOT, "src", name);
  fs.mkdirSync(path.join(d, "surfaces", "view"), { recursive: true });
  fs.writeFileSync(path.join(d, "surfaces", "view", "index.html"), `<!doctype html><p>${name}</p>`);
  let surfaces = "surfaces:\n  view:\n    source: surfaces/view\n";
  if (opts.components) {
    fs.mkdirSync(path.join(d, "surfaces", "components"), { recursive: true });
    fs.writeFileSync(path.join(d, "surfaces", "components", "index.js"), "export function mount(){return{unmount(){}}}");
    surfaces += "  components:\n    source: surfaces/components\n";
  }
  fs.writeFileSync(path.join(d, "relay.yaml"), `schema: relay/v1\nname: "@t/${name}"\nversion: 0.1.0\ndisplay_name: "${name}"\ndescription: "${name}"\n${surfaces}${extra}`);
  return d;
}

const ledger = loadLedger();
// 제공자(bank) → 소비자(hub): 설치는 제공자가 먼저여야 components edge 가 풀린다
await installPkg(ledger, seat("bank", "", { components: true }));
await installPkg(ledger, seat("hub", `edges:\n  - provider: "@t/bank"\n    components: true\n`));
await installPkg(ledger, seat("solo", ""));

test("묶음 기록 — 구성원은 설치본만, 허브는 구성원만, 이름은 슬러그만", () => {
  assert.throws(() => upsertSuite(ledger, { name: "Cards", label: "", members: ["hub"], hub: null }), /이름 형식/);
  assert.throws(() => upsertSuite(ledger, { name: "cards", label: "", members: ["hub", "nope"], hub: null }), /미설치 패키지는 묶을 수 없습니다: nope/);
  assert.throws(() => upsertSuite(ledger, { name: "cards", label: "", members: ["hub"], hub: "bank" }), /허브는 구성원이어야/);
  assert.throws(() => upsertSuite(ledger, { name: "cards", label: "", members: [], hub: null }), /구성원이 없습니다/);
  const s = upsertSuite(ledger, { name: "cards", label: " 카드뉴스 ", members: ["hub", "bank", "hub"], hub: "hub" });
  assert.deepEqual(s, { name: "cards", label: "카드뉴스", members: ["hub", "bank"], hub: "hub" });
  // 같은 이름은 갈아 끼운다 — 폴더가 둘이 되지 않는다
  upsertSuite(ledger, { name: "cards", label: "카드뉴스", members: ["hub", "bank", "solo"], hub: "hub" });
  assert.equal(loadSuites().length, 1);
  assert.deepEqual(loadSuites()[0].members, ["hub", "bank", "solo"]);
});

test("설치 순서 — edges 의 provider 가 먼저 선다. 순환은 fail-loud", () => {
  assert.deepEqual(installOrder(ledger, ["hub", "solo", "bank"]), ["solo", "bank", "hub"]);
  // 서로를 요구하는 둘 — 장부에 손으로 앉힌 순환
  const a = seat("cyc-a", `edges:\n  - provider: "@t/cyc-b"\n    tools: [x]\n`);
  const b = seat("cyc-b", `edges:\n  - provider: "@t/cyc-a"\n    tools: [x]\n`);
  const l = { ...ledger, packages: { ...ledger.packages, "cyc-a": { path: a }, "cyc-b": { path: b } } };
  assert.throws(() => installOrder(l as never, ["cyc-a", "cyc-b"]), /서로를 먼저 요구합니다/);
});

test("폴더의 내용물 — 허브만 묶어도 결재로 마운트하는 제공자가 따라온다(사이드바가 접어 보이는 그대로)", () => {
  assert.deepEqual(suiteClosure(ledger, ["hub"]), ["hub", "bank"]);
  assert.deepEqual(suiteClosure(ledger, ["solo"]), ["solo"]);
  // 허브만 묶은 봉투에도 뱅크가 먼저 앉는다 — 받는 쪽에서 허브가 provider 미설치로 죽지 않게
  upsertSuite(ledger, { name: "hubonly", label: "허브만", members: ["hub"], hub: "hub" });
  const r = packSuite(ledger, "hubonly", path.join(ROOT, "hubonly.relaypackages"));
  assert.deepEqual(r.packages.map((p) => p.ref), ["@t/bank", "@t/hub"]);
  removeSuite("hubonly");
});

test("지워진 설치본은 구성원에서 빠진 채로 읽힌다(ledger 를 줄 때)", () => {
  const l = { ...ledger, packages: { hub: ledger.packages.hub, bank: ledger.packages.bank } };
  const [s] = loadSuites(l as never);
  assert.deepEqual(s.members, ["hub", "bank"]);
  const gone = { ...ledger, packages: { bank: ledger.packages.bank } };
  assert.equal(loadSuites(gone as never)[0].hub, null);
});

let envelope = "";
test("굽기 — 안쪽 봉투를 그대로 담고 묶음 매니페스트가 설치 순서와 봉인을 적는다", () => {
  const r = packSuite(ledger, "cards", path.join(ROOT, "cards.relaypackages"));
  envelope = r.file;
  assert.ok(fs.existsSync(envelope));
  // 구성원 순서(hub, bank, solo)를 보존하되 제공자(bank)가 소비자(hub)보다 앞선다
  assert.deepEqual(r.packages.map((p) => p.ref), ["@t/bank", "@t/solo", "@t/hub"]);
  const names = listArtifact(envelope);
  assert.ok(names.includes("relay-suite.json"));
  assert.ok(names.includes("packages/t-bank-0.1.0.relay"));
  assert.equal(isSuiteArchive(envelope), true);
  // 개별 봉투는 묶음이 아니다
  const single = path.join(ROOT, "single.relay");
  packDir(ledger.packages.solo.path, single);
  assert.equal(isSuiteArchive(single), false);
  assert.throws(() => packSuite(ledger, "nope"), /없는 묶음/);
});

test("받기 — 다른 기판(빈 장부)에 순서대로 앉고, 결재(components)와 묶음이 복원된다", async () => {
  const fresh = { secret: "fresh", packages: {}, grants: [] } as never as ReturnType<typeof loadLedger>;
  // 릴리스 자리는 RELAY_HOME 하나를 같이 쓰므로(같은 봉인 = 같은 스냅샷 재사용) 장부만 새것이다
  const ps = await prepareSuite(fresh, envelope);
  assert.equal(ps.name, "cards");
  assert.equal(ps.label, "카드뉴스");
  assert.equal(ps.hub, "@t/hub");
  assert.deepEqual(ps.items.map((i) => i.name), ["bank", "solo", "hub"]);
  assert.ok(ps.items.every((i) => i.fresh));
  // 준비까지는 장부가 비어 있다 — 동의 전에는 아무것도 앉지 않는다
  assert.deepEqual(Object.keys(fresh.packages), []);
  const r = await activateSuite(fresh, ps);
  assert.deepEqual(Object.keys(fresh.packages).sort(), ["bank", "hub", "solo"]);
  assert.ok(fresh.grants.some((g) => g.consumer === "hub" && g.provider === "bank" && g.components === true));
  assert.deepEqual(r.suite, { name: "cards", label: "카드뉴스", members: ["bank", "solo", "hub"], hub: "hub" });
  saveLedger(ledger); // 원래 장부로 되돌린다 — 아래 테스트가 읽는다
});

test("안쪽 봉투를 바꿔 끼운 묶음은 거부된다 — 매니페스트의 봉인과 다르다", async () => {
  const { unpackArtifact, packEntries } = await import("./pack.ts");
  const dir = path.join(ROOT, "tamper");
  unpackArtifact(envelope, dir);
  const entries = [];
  for (const rel of listArtifact(envelope)) {
    let content = fs.readFileSync(path.join(dir, rel));
    if (rel === "packages/t-solo-0.1.0.relay") content = Buffer.concat([content, Buffer.from([0])]); // 한 바이트
    entries.push({ rel, content, mode: 0o644 });
  }
  const bad = path.join(ROOT, "tampered.relaypackages");
  fs.writeFileSync(bad, packEntries(entries));
  await assert.rejects(prepareSuite({ secret: "x", packages: {}, grants: [] } as never, bad), /봉인 불일치/);
  await assert.rejects(prepareSuite({ secret: "x", packages: {}, grants: [] } as never, path.join(ROOT, "single.relay")), /묶음 봉투가 아닙니다/);
});

test("제거 — 묶음만 사라지고 설치본은 그대로", () => {
  assert.equal(removeSuite("cards"), true);
  assert.equal(removeSuite("cards"), false);
  assert.deepEqual(loadSuites(), []);
  assert.ok(ledger.packages.hub);
});
