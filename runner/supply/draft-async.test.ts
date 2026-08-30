// 초안 목록은 데몬을 붙들지 않는다 — 셸 사이드바가 15초마다 밟는 자리라, 여기의 git 이 동기
// 스폰이면 초안 수만큼 기판 전체(콘솔·위젯·세션·트리거)가 그때마다 멈춘다. 실측
// 2026-08-29: 초안 12개에 한 번 1.17초 였고, 그 정지가 데스크톱 셸의 건강검진에 걸려 셸이
// 데몬을 죽은 것으로 판정하고 대체 데몬을 띄웠다(사용자에게는 "기판이 그냥 꺼졌다"로 보였다).
// runtime/build-async.test.ts 와 같은 축의 시험이다 — 그때 빌드에서 걷어낸 spawnSync 가
// 이 파일에만 남아 있었다.
//
//   node --experimental-strip-types --test runner/supply/draft-async.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-draft-async-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = mk(path.join(ROOT, "relay-home"));

const { listDrafts } = await import("./draft.ts");
const { saveLedger, loadLedger } = await import("./ledger.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const NAMES = ["one", "two", "three", "four"];
/** git 한 번이 무는 시간 — 실제 git 은 밀리초라 동기·비동기의 차이가 잡음에 묻힌다. 느리게
 *  만들어야 "루프를 붙드는가" 가 관측 가능한 축이 된다(build-async 의 holdMs 와 같은 장치) */
const HOLD_MS = 150;

const REAL_GIT = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim();

for (const name of NAMES) {
  const droot = mk(path.join(process.env.HOME, "Relay", "packages", name));
  fs.writeFileSync(path.join(droot, "relay.yaml"), `schema: relay/v1\nname: "@local/${name}"\nversion: 0.1.0\n`);
  const g = (...a: string[]): void => void execFileSync(REAL_GIT, ["-c", "user.name=relay", "-c", "user.email=relay@local", ...a], { cwd: droot });
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "draft open");
  // 기록하지 않은 변경 하나 — changes 가 실제로 세는지 같이 본다
  fs.writeFileSync(path.join(droot, "NOTE.md"), "고친 자리\n");
}

// 느린 git 을 PATH 앞에 세운다 — git() 은 env 를 넘기지 않으므로 호출 시점의 process.env 를 탄다
const SHIM = mk(path.join(ROOT, "bin"));
fs.writeFileSync(path.join(SHIM, "git"), `#!/bin/bash\nsleep ${HOLD_MS / 1000}\nexec ${REAL_GIT} "$@"\n`);
fs.chmodSync(path.join(SHIM, "git"), 0o755);
process.env.PATH = SHIM + path.delimiter + process.env.PATH;

saveLedger({ secret: "s", packages: {}, grants: [] });

test("초안 목록이 도는 동안에도 이벤트 루프가 돈다 — 타이머가 제때 깨어난다", async () => {
  // 시계를 **먼저** 건다 — 동기 구현이면 목록을 부르는 그 줄에서 루프가 멈추므로, 부른 뒤에
  // 거는 시계는 이미 멈춤이 끝난 뒤를 재게 되어 아무것도 잡지 못한다
  const t = Date.now();
  const woke = new Promise((r) => setTimeout(r, 50));
  const listing = listDrafts(loadLedger());
  await woke;
  const lag = Date.now() - t - 50;
  const drafts = await listing;

  assert.equal(drafts.length, NAMES.length);
  assert.deepEqual(drafts.map((d) => d.name).sort(), [...NAMES].sort());
  // 동기 스폰이면 초안 수 × 2 만큼(여기서는 1.2초) 루프가 통째로 멈춘다
  assert.ok(lag < HOLD_MS, `초안 목록이 루프를 붙들었다 — 50ms 타이머가 ${lag}ms 늦게 깼다`);
});

test("초안들은 동시에 읽는다 — 왕복이 줄줄이 붙지 않는다", async () => {
  const t = Date.now();
  const drafts = await listDrafts(loadLedger());
  const took = Date.now() - t;

  // 초안마다 git 한 번이다 — 기록하지 않은 변경이 있으면 "빈 초안" 판정(git log)은 단락된다.
  // 직렬이면 초안 수 × HOLD_MS, 동시면 왕복 한 번어치. 그 사이에 선을 긋는다
  assert.ok(took < NAMES.length * HOLD_MS * 0.6, `초안 목록이 직렬로 돌았다 — ${took}ms`);
  // 세는 일 자체는 그대로다: 기록하지 않은 변경 1건(NOTE.md), 첫 커밋만 있는 이력이지만
  // 변경이 있으므로 "빈 초안"은 아니다
  for (const d of drafts) {
    assert.equal(d.changes, 1, `${d.name}: 미커밋 변경 1건이어야 한다`);
    assert.equal(d.empty, false);
    assert.equal(d.version, "0.1.0");
  }
});
