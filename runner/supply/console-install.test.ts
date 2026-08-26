// 콘솔의 설치 이름은 기판마다 다르다 — 장부의 매니페스트 이름으로 찾는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consoleInstall } from "./ledger.ts";

function seat(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-console-"));
  fs.writeFileSync(path.join(d, "relay.yaml"), `schema: relay/v1\nname: "${name}"\nversion: 0.1.0\n`);
  return d;
}

test("설치 이름이 system 이 아니어도 매니페스트 이름 @relay/system 으로 콘솔을 찾는다", () => {
  const ledger = { secret: "s", grants: [], packages: { "@relay/system": { path: seat("@relay/system") }, other: { path: seat("@acme/other") } } };
  assert.equal(consoleInstall(ledger as never), "@relay/system");
});

test("콘솔이 없으면 관례 system — 1인 기판의 기본 설치 이름", () => {
  const ledger = { secret: "s", grants: [], packages: { other: { path: seat("@acme/other") } } };
  assert.equal(consoleInstall(ledger as never), "system");
});
