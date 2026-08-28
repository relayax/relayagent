// 포트는 홈의 부속이다 — 데몬이 홈에 적고 CLI 가 따라간다. RELAY_PORT 는 명시 선언이라 늘 이긴다.
//
//   node --experimental-strip-types --test runner/supply/instance-port.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-port-"));
process.env.HOME = path.join(ROOT, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
delete process.env.RELAY_PORT;

const { discoverApiPort, runningDaemonPid, runningDaemonPort, runningDaemonRunner, takeoverReason, markDaemonStarting, markDaemonListening, clearDaemonMark, API_PORT } = await import("./ledger.ts");
const RUN = path.join(process.env.RELAY_HOME, "run");

test("기록이 없으면 기본 4747 — 모듈 적재 시점의 판정도 같다", () => {
  assert.equal(discoverApiPort({}), 4747);
  assert.equal(API_PORT, 4747);
  assert.equal(runningDaemonPid(), null);
});

test("데몬이 적은 기록을 따라간다 — pid 가 살아 있고(이 프로세스) 포트가 적혀 있을 때", () => {
  markDaemonStarting();
  assert.equal(runningDaemonPid(), process.pid);
  // 문이 열리기 전에는 포트가 없다 — CLI 는 기본값으로 물러난다(빈 문을 두드리지 않도록 데몬이 나중에 적는다)
  assert.equal(runningDaemonPort(), null);
  assert.equal(discoverApiPort({}), 4747);
  markDaemonListening(4848);
  assert.equal(runningDaemonPort(), 4848);
  assert.equal(discoverApiPort({}), 4848);
});

test("RELAY_PORT 는 기록보다 먼저다 — 명시 선언", () => {
  assert.equal(discoverApiPort({ RELAY_PORT: "5757" }), 5757);
  assert.throws(() => discoverApiPort({ RELAY_PORT: "abc" }), /포트가 아니다/);
  assert.throws(() => discoverApiPort({ RELAY_PORT: "70000" }), /포트가 아니다/);
});

test("죽은 pid 의 기록은 지워지고 기본값으로 돌아간다 — 옛 기록이 새 데몬의 자리를 정하지 않는다", () => {
  fs.writeFileSync(path.join(RUN, "daemon.pid"), "999999999\n");
  fs.writeFileSync(path.join(RUN, "daemon.port"), "6000\n");
  assert.equal(runningDaemonPid(), null);
  assert.equal(discoverApiPort({}), 4747);
  assert.ok(!fs.existsSync(path.join(RUN, "daemon.pid")));
  assert.ok(!fs.existsSync(path.join(RUN, "daemon.port")));
});

test("종료는 두 기록을 함께 지운다", () => {
  markDaemonStarting();
  markDaemonListening(4949);
  clearDaemonMark();
  assert.ok(!fs.existsSync(path.join(RUN, "daemon.pid")));
  assert.ok(!fs.existsSync(path.join(RUN, "daemon.port")));
  assert.equal(discoverApiPort({}), 4747);
});

test("물려받을 이유 — 같은 판이면 없고(거부), 러너가 다르거나 판이 다르거나 기록이 없으면 있다", () => {
  const mine = { dir: "/app/runner", version: "0.3.15" };
  assert.equal(takeoverReason({ ...mine }, mine), null);
  assert.match(takeoverReason(null, mine)!, /자리 기록이 없는 지난 판/);
  assert.match(takeoverReason({ dir: "/checkout/runner", version: "0.3.15" }, mine)!, /다른 러너/);
  assert.match(takeoverReason({ dir: "/app/runner", version: "0.3.14" }, mine)!, /옛 판 v0\.3\.14/);
});

test("러너 신원은 자리 기록과 함께 앉고 함께 지워진다 — 기록 없는 지난 판과 구별된다", () => {
  markDaemonStarting();
  assert.equal(runningDaemonRunner(), null); // 아직 문을 안 열었다 = 신원도 없다
  markDaemonListening(4848, { dir: "/app/runner", version: "0.3.15" });
  assert.deepEqual(runningDaemonRunner(), { dir: "/app/runner", version: "0.3.15" });
  clearDaemonMark();
  assert.equal(runningDaemonRunner(), null);
  assert.ok(!fs.existsSync(path.join(RUN, "daemon.runner")));
});
