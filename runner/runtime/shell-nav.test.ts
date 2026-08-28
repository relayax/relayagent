// 사이드바 자리 판정 — 접힘의 근거는 결재(장부의 components 결재)이고 선언(shell.nav)은 오버라이드다.
//
//   node --experimental-strip-types --test runner/runtime/shell-nav.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-shellnav-"));
process.env.HOME = path.join(ROOT, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });

const { shellNav, facesOf } = await import("./shell.ts");
const { loadManifest } = await import("../supply/manifest.ts");
type Ledger = import("../supply/ledger.ts").Ledger;

/** 판정을 통과하는 최소 패키지 — view 는 손저작 HTML, components 는 손저작 ESM(out 없음) */
function seat(name: string, extra: string, opts: { components?: boolean } = {}): string {
  const d = path.join(ROOT, "pkgs", name);
  fs.mkdirSync(path.join(d, "surfaces", "view"), { recursive: true });
  fs.writeFileSync(path.join(d, "surfaces", "view", "index.html"), "<!doctype html><p>hi</p>");
  let surfaces = "surfaces:\n  view:\n    source: surfaces/view\n";
  if (opts.components) {
    fs.mkdirSync(path.join(d, "surfaces", "components"), { recursive: true });
    fs.writeFileSync(path.join(d, "surfaces", "components", "index.js"), "export function mount(){return{unmount(){}}}");
    surfaces += "  components:\n    source: surfaces/components\n";
  }
  fs.writeFileSync(
    path.join(d, "relay.yaml"),
    `schema: relay/v1\nname: "@t/${name}"\nversion: 0.1.0\ndisplay_name: "${name}"\ndescription: "${name}"\n${surfaces}${extra}`,
  );
  return d;
}

const hub = seat("hub", `edges:\n  - provider: "@t/forge"\n    components: true\n  - provider: "@t/bank"\n    components: true\n`);
const forge = seat("forge", `edges:\n  - provider: "@t/bank"\n    components: true\n`, { components: true });
const bank = seat("bank", "", { components: true });
const pinned = seat("pinned", "shell:\n  nav: always\n", { components: true });
const ghost = seat("ghost", "shell:\n  nav: never\n");
const solo = seat("solo", "");

const ledger = {
  secret: "s",
  packages: { hub: { path: hub }, forge: { path: forge }, bank: { path: bank }, pinned: { path: pinned }, ghost: { path: ghost }, solo: { path: solo } },
  grants: [
    { consumer: "hub", provider: "forge", components: true },
    { consumer: "hub", provider: "bank", components: true },
    { consumer: "forge", provider: "bank", components: true },
    { consumer: "hub", provider: "pinned", components: true },
    // tools 결재는 화면을 마운트하지 않는다 — 접힘의 근거가 아니다
    { consumer: "solo", provider: "bank", tools: ["x"] },
  ],
} as unknown as Ledger;

test("shell.nav 판정 — 미선언은 auto 로, 어휘 밖은 거부", () => {
  assert.equal(loadManifest(solo).shell, undefined);
  assert.equal(loadManifest(pinned).shell?.nav, "always");
  const bad = seat("bad", "shell:\n  nav: sometimes\n");
  assert.throws(() => loadManifest(bad), /shell\.nav: auto \| always \| never/);
  const badKey = seat("badkey", "shell:\n  group: x\n");
  assert.throws(() => loadManifest(badKey), /shell\.group: 미지 키/);
});

test("components 결재가 있는 제공자는 첫 소비자 밑으로 접힌다 — 2단(허브 ▸ 엔진 ▸ 뱅크)도 그대로", () => {
  const nav = shellNav(ledger, []);
  const by = Object.fromEntries(nav.items.map((i) => [i.pkg, i]));
  assert.deepEqual(by.forge.mounted_in, ["hub"]);
  assert.equal(by.forge.parent, "hub");
  // 뱅크는 허브와 엔진 둘이 마운트한다 — 장부 순의 첫 소비자(허브)가 자리이고 둘 다 근거로 실린다
  assert.deepEqual(by.bank.mounted_in, ["hub", "forge"]);
  assert.equal(by.bank.parent, "hub");
  assert.equal(by.hub.parent, null);
  assert.deepEqual(by.hub.mounted_in, []);
  // tools 결재만 받은 제공자 관계는 접지 않는다
  assert.equal(by.solo.parent, null);
  assert.equal(by.solo.hidden, false);
});

test("always 는 결재가 있어도 최상위, never 는 목록 밖(hidden) — 둘 다 항목 자체는 남는다(콘솔·홈이 읽는다)", () => {
  const nav = shellNav(ledger, []);
  const by = Object.fromEntries(nav.items.map((i) => [i.pkg, i]));
  assert.equal(by.pinned.nav, "always");
  assert.deepEqual(by.pinned.mounted_in, ["hub"]);
  assert.equal(by.pinned.parent, null);
  assert.equal(by.ghost.nav, "never");
  assert.equal(by.ghost.hidden, true);
  assert.ok(nav.items.some((i) => i.pkg === "ghost"));
});

test("결재 없는 선언은 접지 않는다 — 허브가 지워지면 모듈은 최상위로 돌아온다", () => {
  const without: Ledger = { ...ledger, packages: { forge: { path: forge }, bank: { path: bank } } };
  const nav = shellNav(without, []);
  const by = Object.fromEntries(nav.items.map((i) => [i.pkg, i]));
  assert.equal(by.forge.parent, null);
  // 엔진 → 뱅크 결재는 둘 다 남아 있으니 뱅크는 엔진 밑
  assert.deepEqual(by.bank.mounted_in, ["forge"]);
  assert.equal(by.bank.parent, "forge");
});

test("묶음은 설치본만 남긴 채 실린다 — 지워진 구성원·허브는 빠진다", () => {
  const nav = shellNav(ledger, [], undefined, [], { credentials: 0 }, [
    { name: "cards", label: "카드뉴스", members: ["hub", "gone", "solo"], hub: "hub" },
    { name: "empty", label: "빈 묶음", members: ["gone"], hub: "gone" },
  ]);
  assert.deepEqual(nav.suites, [
    { name: "cards", label: "카드뉴스", hub: "hub", members: ["hub", "solo"] },
    { name: "empty", label: "빈 묶음", hub: null, members: [] },
  ]);
  assert.deepEqual(shellNav(ledger, []).suites, []);
});

test("facesOf 는 그대로 — components 수출은 얼굴이 아니다(화면이 있으면 view)", () => {
  assert.deepEqual(facesOf(loadManifest(bank)), ["view"]);
  assert.deepEqual(facesOf({ name: "@t/x", surfaces: { components: { source: "x" } } } as never), ["parts"]);
});
