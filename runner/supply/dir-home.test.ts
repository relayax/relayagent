// 기판 장기는 dir 로 열 수 없다 — 담장이 한 축에서만 서면 담장이 아니다.
//
// 세션에는 ~/.relay 가 항상 deny 로 주입되는데, dir 선언은 그 담장과 대조되지 않았다. 동사가
// ctx.service 로 그 폴더를 열 수 있는 한 그 구멍이 곧 기판 장기의 문이다 — 그 안에 자격
// (vault)과 장부의 시크릿(패키지 토큰 민팅 키)이 산다.
//
// 함께 못박는 반대편: **상대경로 선언은 막지 않는다.** 발행본은 ~/.relay/releases/<이름>/<버전>
// 에 살아서, 여기까지 막으면 상대 dir 을 선언한 모든 발행 패키지가 설치 불가가 된다.
//
//   node --experimental-strip-types --test runner/supply/dir-home.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Manifest } from "./manifest.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dirhome-"));
const HOME = mk(path.join(ROOT, "home"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.RELAY_HOME = mk(path.join(HOME, ".relay"));

const { judgeDirGrants } = await import("./install.ts");
const { ManifestError } = await import("./manifest.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
const withDir = (dir: string): Manifest => ({ services: [{ name: "data", dir }] }) as Manifest;
const refuses = (fn: () => unknown): void => {
  assert.throws(fn, (e: unknown) => e instanceof ManifestError && e.issues.some((i) => i.includes("기판 장기")));
};

test("기판 장기 안쪽을 신청하면 설치가 거부한다", () => {
  refuses(() => judgeDirGrants(withDir("~/.relay/authoring"), undefined));
  refuses(() => judgeDirGrants(withDir("~/.relay"), undefined));
});

test("장기 밖의 신청은 통과한다 — 막는 것은 장기 하나다", () => {
  assert.equal(judgeDirGrants(withDir("~/Documents/orders-inbox"), undefined), undefined);
  assert.equal(judgeDirGrants(withDir("~/Relay/packages"), undefined), undefined);
});

test("상대경로 선언은 보지 않는다 — 발행본의 트리가 장기 안에 앉기 때문이다", () => {
  assert.equal(judgeDirGrants(withDir("./.data/authoring"), undefined), undefined);
  assert.equal(judgeDirGrants(withDir("data"), undefined), undefined);
});

test("결재(--bind)도 같은 판정을 지난다 — 선언이 깨끗해도 결재로 열면 같은 구멍이다", () => {
  refuses(() => judgeDirGrants(withDir("~/Documents/inbox"), { data: path.join(process.env.RELAY_HOME!, "vault") }));
  const ok = judgeDirGrants(withDir("~/Documents/inbox"), { data: "~/Documents/other" });
  assert.deepEqual(ok, { data: "~/Documents/other" });
});

test("심링크로도 우회하지 못한다 — 경로 비교만 보면 밖처럼 생겼다", () => {
  const link = path.join(HOME, "shortcut");
  if (!fs.existsSync(link)) fs.symlinkSync(process.env.RELAY_HOME!, link);
  refuses(() => judgeDirGrants(withDir("~/Documents/inbox"), { data: link }));
});

test("결재가 선언을 넘는 판정은 그대로다 — 이 변경이 앞선 게이트를 밀어내지 않았다", () => {
  assert.throws(
    () => judgeDirGrants(withDir("~/Documents/inbox"), { ghost: "~/x" }),
    (e: unknown) => e instanceof ManifestError && e.issues.some((i) => i.includes("선언된 dir 서비스가 아닙니다")),
  );
});
