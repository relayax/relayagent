// 살림 이사(layout 1 → 2) — 저작 트리가 기판 장기에서 보이는 땅으로 나왔다.
//
// 시험을 붙이는 이유는 하나다: 여기서 움직이는 것은 **사용자의 작업 사본**이다. 조용히
// 사라지거나 조용히 덮이면 잃은 줄도 모른 채 잃는다. 못박는 것 셋 — 옮긴다, 이름이 겹치면
// 덮지 않고 남긴다, 한 번만 돈다.
//
//   node --experimental-strip-types --test runner/supply/layout.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-layout-"));
const HOME = mk(path.join(ROOT, "home"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.RELAY_HOME = mk(path.join(ROOT, "relay-home"));

// 이사 전 상태를 먼저 세운다 — 모듈이 적재되며 좌표를 각인하므로 import 는 그 뒤다
const OLD = mk(path.join(process.env.RELAY_HOME, "drafts"));
const PACKAGES = path.join(HOME, "Relay", "packages");
write(path.join(OLD, "moves", "relay.yaml"), "옮겨질 것");
write(path.join(OLD, "collides", "relay.yaml"), "옛 것");
write(path.join(PACKAGES, "collides", "relay.yaml"), "새 것 — 덮이면 안 된다");
fs.writeFileSync(path.join(process.env.RELAY_HOME, "version"), "1\n");

const { loadLedger, packagesPath } = await import("./ledger.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

test("작업 사본은 보이는 땅으로 옮겨진다", () => {
  loadLedger();
  assert.equal(packagesPath(), PACKAGES);
  assert.equal(fs.readFileSync(path.join(PACKAGES, "moves", "relay.yaml"), "utf8"), "옮겨질 것");
  assert.ok(!fs.existsSync(path.join(OLD, "moves")), "옛 자리에 사본이 남았다");
});

test("이름이 겹치면 덮지 않고 옛 자리에 남긴다 — 어느 쪽이 최신인지 기판은 모른다", () => {
  assert.equal(fs.readFileSync(path.join(PACKAGES, "collides", "relay.yaml"), "utf8"), "새 것 — 덮이면 안 된다");
  assert.equal(fs.readFileSync(path.join(OLD, "collides", "relay.yaml"), "utf8"), "옛 것");
});

test("한 번만 돈다 — 판이 올라가면 다음 적재는 손대지 않는다", () => {
  assert.equal(fs.readFileSync(path.join(process.env.RELAY_HOME!, "version"), "utf8").trim(), "2");
  write(path.join(OLD, "after", "relay.yaml"), "이사 뒤에 생긴 것");
  loadLedger();
  assert.ok(!fs.existsSync(path.join(PACKAGES, "after")), "판이 2인데 다시 옮겼다");
});
