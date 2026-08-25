// dispatch-recovery.test.ts — 위임이 사람에게 닿는 두 관문.
//
// ① 관찰 창: wire 밖에서 열린 턴(도구 위임·트리거·CLI)도 턴 id 를 갖는가. 없으면 /history 는
//    busy 만 답하고 화면은 붙을 곳을 못 찾아, 도는 위임이 "멈춘 것처럼" 보인다.
// ② 배달의 내구성: 기판이 죽어 메모리의 배달 약속이 사라져도, 다음 기동이 장부를 주워
//    배달하는가. 2026-08-25 실사고 — 재시작이 진행 중 위임의 배달을 지웠고 발신 대화의
//    마지막 말은 "180초 안에 안 끝났습니다"로 남았다. 로그조차 안 남았다.
//
//   node --experimental-strip-types --test runner/runtime/dispatch-recovery.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

// 좌표는 모듈 적재 시점에 각인된다 — 들여오기 전에 임시 자리로 돌린다
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4749";

const { runSession, setEnvelopeTap, setTurnTap, localSessionIO, INTERRUPTED_MARK } = await import("./harness.ts");
const { handleClientWire, tapSessionEvent, adoptSessionTurn, releaseSessionTurn } = await import("./wire.ts");
const { sweepPendingDeliveries } = await import("./tools.ts");
const { localAuthority } = await import("../authority.ts");
const { saveLedger } = await import("../supply/ledger.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 배선 — createApi 가 하는 두 줄. 두 번째가 이 시험의 대상이다
setEnvelopeTap(tapSessionEvent);
setTurnTap({ open: adoptSessionTurn, close: releaseSessionTurn });

const PKG = "cons";
const AGENT = "front";
const PROBE = path.join(ROOT, "delivered.txt");
process.env.DISPATCH_PROBE = PROBE;

// 받은 프롬프트를 흘리고, FAKE_DELAY 만큼 붙들었다가 답하는 가짜 어댑터
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  "if [ \"${1:-}\" = \"info\" ]; then",
  "  printf '%s\\n' '{\"name\":\"fake\",\"provider\":\"none\",\"protocol\":3,\"verbs\":[\"session\",\"info\"],\"capabilities\":[]}'",
  "  exit 0",
  "fi",
  "printf '%s\\n===\\n' \"${2:-}\" >> \"$DISPATCH_PROBE\"",
  "sleep \"${FAKE_DELAY:-0}\"",
  "printf '%s\\n' '{\"event\":\"delta\",\"text\":\"생각 중\"}'",
  "printf '%s\\n' '{\"event\":\"reply\",\"text\":\"끝났다\"}'",
].join("\n") + "\n";

const PKG_DIR = mk(path.join(ROOT, "pkg"));
mk(path.join(PKG_DIR, "agents", AGENT));
fs.writeFileSync(path.join(PKG_DIR, "agents", AGENT, "AGENT.md"), "위임을 보내는 픽스처.\n");
mk(path.join(PKG_DIR, "harness", "fake"));
fs.writeFileSync(path.join(PKG_DIR, "harness", "fake", "run"), ADAPTER, { mode: 0o755 });
fs.writeFileSync(path.join(PKG_DIR, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/cons"',
  "version: 0.1.0",
  'display_name: "위임 픽스처"',
  'description: "관찰 창·배달 내구성 검증용"',
  "harness:",
  "  variants:",
  "    - name: fake",
  "      source: harness/fake",
  "      entry: run",
  "agents:",
  `  - name: ${AGENT}`,
  "    default: true",
  `    persona: agents/${AGENT}/AGENT.md`,
  "",
].join("\n"));

const ledger: Ledger = {
  secret: "dispatch-fixture-secret",
  packages: { [PKG]: { path: PKG_DIR, workspace: mk(path.join(ROOT, "ws")) } },
  grants: [],
};
// 배달 사다리는 파일 장부를 다시 읽는다(약속이 한 시간 뒤에 앉을 수 있어 스냅샷을 안 믿는다)
saveLedger(ledger);
const authority = localAuthority(() => ledger);
const io = localSessionIO(() => ledger);

/** 계약 문의 이력 조회 — 화면이 재부착 대상을 찾는 그 왕복이다 */
async function history(slot: string): Promise<{ busy: boolean; turn?: string; messages: unknown[] }> {
  let payload = "";
  const res = {
    writeHead: () => res,
    end: (s?: string) => void (payload = s ?? ""),
  } as unknown as http.ServerResponse;
  const matched = await handleClientWire(
    { getLedger: () => ledger, authority },
    { method: "GET", headers: {} } as unknown as http.IncomingMessage,
    res,
    new URL(`http://127.0.0.1/pkg/${PKG}/sessions/${slot}/history`),
  );
  assert.equal(matched, true, "이력 라우트가 매치되지 않았다");
  return JSON.parse(payload);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const probe = (): string => {
  try {
    return fs.readFileSync(PROBE, "utf8");
  } catch {
    return "";
  }
};
const pendingFile = (id: string): string => path.join(process.env.RELAY_HOME!, "dispatch-pending", id + ".json");
function pending(rec: Record<string, unknown>): void {
  mk(path.dirname(pendingFile(String(rec.id))));
  fs.writeFileSync(pendingFile(String(rec.id)), JSON.stringify(rec));
}

test("wire 밖에서 열린 턴도 관찰 창에 선다 — /history 가 busy 와 함께 턴 id 를 싣는다", async () => {
  process.env.FAKE_DELAY = "1";
  const run = runSession({ ledger, pkg: PKG, authority, prompt: "일해라", slot: "s-live" });
  let h = await history("s-live");
  for (let i = 0; i < 80 && !h.busy; i++) {
    await sleep(50);
    h = await history("s-live");
  }
  assert.equal(h.busy, true);
  // 이 한 줄이 고친 것 — 종전에는 busy 만 참이고 turn 이 없어 화면이 붙을 곳을 못 찾았다
  assert.equal(typeof h.turn, "string");
  const turnId = String(h.turn);
  await run;
  process.env.FAKE_DELAY = "0";

  const after = await history("s-live");
  assert.equal(after.busy, false);
  assert.equal(after.turn, undefined, "종결한 턴은 관찰 창에서 내려간다");

  // 장부가 개설과 종결을 갖는다 — attach 재생이 실황과 같은 것을 본다
  const rows = fs.readFileSync(path.join(io.sessionDir(PKG, "s-live"), "turns", turnId + ".jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[0].event, "turn");
  assert.equal(rows[0].status, "started");
  assert.ok(rows.some((r) => r.event === "delta"), "실황(delta)이 그 장부로 흐른다");
  assert.equal(rows[rows.length - 1].event, "turn");
  assert.equal(rows[rows.length - 1].status, "settled");
  assert.equal(rows[rows.length - 1].ok, true);
});

test("지난 기동이 못 한 배달을 다음 기동이 줍는다 — 위임 대화의 마지막 답이 📬 로 앉는다", async () => {
  fs.rmSync(PROBE, { force: true });
  const since = Date.now() - 30_000;
  io.appendMessage(PKG, "sub-done", { t: new Date(since - 30_000).toISOString(), role: "user", text: "[서브에이전트] 해라" });
  io.appendMessage(PKG, "sub-done", { t: new Date().toISOString(), role: "bot", text: "다 끝냈습니다" });
  pending({ id: "p-done", to: { pkg: PKG, slot: "s-parent", agent: AGENT }, from: { pkg: PKG, slot: "sub-done" }, label: "agent-builder", since, attempts: 0 });

  assert.equal(await sweepPendingDeliveries(authority), 1);
  assert.match(probe(), /📬 위임 완료 — agent-builder\(완료\)/);
  assert.match(probe(), /다 끝냈습니다/);
  assert.equal(fs.existsSync(pendingFile("p-done")), false, "배달한 약속은 장부에서 내려간다");
});

test("중단된 위임은 중단으로 배달된다 — 복구 표식이 그 판정의 정본이다", async () => {
  fs.rmSync(PROBE, { force: true });
  const since = Date.now() - 30_000;
  io.appendMessage(PKG, "sub-cut", { t: new Date(since - 30_000).toISOString(), role: "user", text: "[서브에이전트] 해라" });
  io.appendMessage(PKG, "sub-cut", {
    t: new Date().toISOString(),
    role: "bot",
    text: `draft 에 고쳐 넣겠습니다.\n\n${INTERRUPTED_MARK} 답변이 끝까지 저장되지 못했습니다. 여기까지 오간 내용입니다.)`,
  });
  pending({ id: "p-cut", to: { pkg: PKG, slot: "s-parent", agent: AGENT }, from: { pkg: PKG, slot: "sub-cut" }, label: "agent-builder", since, attempts: 0 });

  assert.equal(await sweepPendingDeliveries(authority), 1);
  assert.match(probe(), /📬 위임 완료 — agent-builder\(중단\)/);
});

test("아직 종결 전인 위임은 배달하지 않고 약속을 지킨다 — 다음 기동이 다시 본다", async () => {
  fs.rmSync(PROBE, { force: true });
  io.appendMessage(PKG, "sub-run", { t: new Date().toISOString(), role: "user", text: "[서브에이전트] 해라" });
  pending({ id: "p-run", to: { pkg: PKG, slot: "s-parent", agent: AGENT }, from: { pkg: PKG, slot: "sub-run" }, label: "agent-builder", since: Date.now(), attempts: 0 });

  assert.equal(await sweepPendingDeliveries(authority), 0);
  assert.equal(probe(), "");
  assert.equal(fs.existsSync(pendingFile("p-run")), true);
  fs.rmSync(pendingFile("p-run"), { force: true });
});

test("재시도 상한을 넘은 약속은 내려놓는다 — 못 앉을 배달을 영원히 들지 않는다", async () => {
  fs.rmSync(PROBE, { force: true });
  const since = Date.now() - 30_000;
  io.appendMessage(PKG, "sub-old", { t: new Date().toISOString(), role: "bot", text: "답" });
  pending({ id: "p-old", to: { pkg: PKG, slot: "s-parent", agent: AGENT }, from: { pkg: PKG, slot: "sub-old" }, label: "agent-builder", since, attempts: 3 });

  assert.equal(await sweepPendingDeliveries(authority), 0);
  assert.equal(probe(), "");
  assert.equal(fs.existsSync(pendingFile("p-old")), false);
});
