// 문은 자기 정체를 말한다 — /instance 가 홈(인스턴스의 신원)을 낸다.
//
// 포트는 홈의 부속이라 같은 포트에 다른 홈의 기판이 설 수 있다. 부르는 쪽(CLI tryApi)은 넘기기 전에
// 이 문으로 대조하고, 다르면 넘기지 않는다 — 그러지 않으면 남의 인스턴스에 설치·발행이 앉는다
// (실사고 2026-08-28: 데스크톱이 ~/.relay-app 으로 옮겨 간 뒤 체크아웃 CLI 가 옛 홈에 계속 썼다).
//
//   node --experimental-strip-types --test runner/runtime/instance-door.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-instance-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = mk(path.join(ROOT, "relay-home"));
process.env.RELAY_PORT = String(await freePort());

const { createApi, RUNNER_ID } = await import("../daemon.ts");
const { homeId, API_PORT, API_URL } = await import("../supply/ledger.ts");
const { localAuthority } = await import("../authority.ts");
const { Ticker } = await import("./triggers.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

const ledger: Ledger = { secret: "inst", packages: {}, grants: [] } as unknown as Ledger;
const authority = localAuthority(() => ledger);
const host = {} as HostBridge;
const ticker = new Ticker(() => ledger, host, authority);
const server = createApi(() => ledger, host, ticker, authority);
await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
test.after(() => {
  ticker.stop();
  server.close();
});

test("/instance — 홈의 실경로와 듣는 자리, 사람, 그리고 뜬 러너. 장부도 자격도 싣지 않는다", async () => {
  const res = await fetch(API_URL + "/instance");
  assert.equal(res.status, 200);
  const d = (await res.json()) as Record<string, unknown>;
  assert.equal(d.home, homeId());
  assert.equal(d.home, fs.realpathSync(process.env.RELAY_HOME!));
  assert.equal(d.port, API_PORT);
  assert.equal(d.principal, authority.principal());
  // 러너 신원 — 감독자(데스크톱 앱)가 "이 데몬이 내 번들에서 떴는가" 를 묻는 자리다.
  // 포트가 답한다는 사실만으로는 최신인지 알 수 없다(Node 는 적재한 모듈을 다시 읽지 않는다)
  assert.equal(d.runner, RUNNER_ID.dir);
  assert.equal(d.version, RUNNER_ID.version);
  assert.equal(d.runner, fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
  // 신원뿐이다 — 장부·자격이 새어 나가지 않는다
  assert.deepEqual(Object.keys(d).sort(), ["home", "port", "principal", "runner", "version"]);
});

test("신원은 실경로다 — 심링크로 같은 홈을 다르게 불러도 대조가 성립한다", () => {
  // 데스크톱은 앱 번들 안의 상대 경로로, 터미널은 ~ 로 같은 자리를 부른다. 문자열 비교만 하면
  // 같은 인스턴스가 남처럼 보여 CLI 가 자기 데몬을 두고 로컬로 물러난다
  const link = path.join(ROOT, "home-link");
  if (!fs.existsSync(link)) fs.symlinkSync(process.env.RELAY_HOME!, link);
  assert.notEqual(link, homeId());
  assert.equal(fs.realpathSync(link), homeId());
});
