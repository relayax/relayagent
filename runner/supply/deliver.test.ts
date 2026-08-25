// 구운 봉투가 사람에게 닿는 길 — 선반은 기판 장기라 세션이 못 연다.
//
// 회귀하면 증상이 조용하다: 굽기는 성공하고 응답도 성공인데, 정작 봉투를 건네지 못해
// 에이전트가 사용자에게 "터미널에서 cp 하세요"로 안내하게 된다(실사고 2026-08-25).
//
//   node --experimental-strip-types --test runner/supply/deliver.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-deliver-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { deliverToStage } = await import("./pack.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const SHELF = mk(path.join(ROOT, "shelf"));
const STAGE = path.join(ROOT, "stage", "system");
const ART = path.join(SHELF, "haemin-offer-workbook-0.1.13.relay");

test("봉투와 서명 사이드카가 함께 무대에 앉는다 — 서명을 잃으면 받는 쪽이 대조할 것이 없다", () => {
  fs.writeFileSync(ART, "봉투");
  fs.writeFileSync(ART + ".sig", "서명");
  const out = deliverToStage(ART, STAGE);
  assert.deepEqual(out, ["haemin-offer-workbook-0.1.13.relay", "haemin-offer-workbook-0.1.13.relay.sig"]);
  assert.equal(fs.readFileSync(path.join(STAGE, "haemin-offer-workbook-0.1.13.relay"), "utf8"), "봉투");
});

test("무대가 없으면 만든다 — 첫 굽기가 첫 전달이다", () => {
  const fresh = path.join(ROOT, "stage-2", "system");
  assert.ok(!fs.existsSync(fresh));
  deliverToStage(ART, fresh);
  assert.ok(fs.existsSync(path.join(fresh, path.basename(ART))));
});

test("같은 버전을 다시 구우면 덮는다 — 무대에 같은 봉투가 여럿이면 어느 것이 방금 것인지 모른다", () => {
  fs.writeFileSync(ART, "다시 구운 봉투");
  deliverToStage(ART, STAGE);
  assert.equal(fs.readFileSync(path.join(STAGE, path.basename(ART)), "utf8"), "다시 구운 봉투");
  assert.equal(fs.readdirSync(STAGE).filter((f) => f.endsWith(".relay")).length, 1);
});

test("서명이 없으면 봉투만 간다 — 없는 사이드카를 지어내지 않는다", () => {
  const bare = path.join(SHELF, "no-sig-0.1.0.relay");
  fs.writeFileSync(bare, "봉투");
  assert.deepEqual(deliverToStage(bare, STAGE), ["no-sig-0.1.0.relay"]);
});
