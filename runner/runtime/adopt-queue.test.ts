// 입양한 턴 뒤에도 줄을 선다(client-protocol §5.1-12) — wire 밖에서 열린 턴(도구 위임·트리거)이 도는
// 동안 도착한 wire 턴이 즉시 실패하지 않고 그 턴의 종결을 기다리는가.
//
// 이 시험이 필요한 이유(2026-08-28 실사고): 위임 탭에서 보낸 말이 전부 "이 대화는 아직 이전 요청을
// 처리하는 중입니다"로 종결됐다. 세션 사슬이 wire 가 연 턴끼리만 줄을 세워, agent_dispatch 가 runSession
// 으로 직접 연 턴은 사슬에 없었다 — 그 뒤에 온 wire 턴은 줄 대신 runSession 문지기에 부딪혔다.
//
//   node --experimental-strip-types --test runner/runtime/adopt-queue.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { ClientWireDeps } from "./wire.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adopt-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4761";

const { handleClientWire, tapSessionEvent, adoptSessionTurn, releaseSessionTurn } = await import("./wire.ts");
const { setEnvelopeTap, localSessionIO } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");

setEnvelopeTap(tapSessionEvent);

const AGENT = "fixture";
const PKG = "adopt-fixture";

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function adapter(): string {
  return [
    "#!/bin/bash",
    "set -eu",
    'if [ "${1:-}" = "info" ]; then',
    `  printf '%s\\n' '{"name":"adopt-fixture","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":[]}'`,
    "  exit 0",
    "fi",
    `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["local-model"]'; exit 0; fi`,
    `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
    'if [ "${1:-}" = "setup" ]; then exit 0; fi',
    `printf '%s\\n' '{"event":"delta","text":"뒤에 선 답"}'`,
    `printf '%s\\n' '{"event":"reply","text":"뒤에 선 답"}'`,
  ].join("\n") + "\n";
}

function seat(): string {
  const dir = mk(path.join(ROOT, PKG));
  mk(path.join(dir, "agents", AGENT));
  fs.writeFileSync(path.join(dir, "agents", AGENT, "AGENT.md"), "픽스처 페르소나.\n");
  mk(path.join(dir, "harness", "only"));
  fs.writeFileSync(path.join(dir, "harness", "only", "run"), adapter(), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "relay.yaml"), [
    "schema: relay/v1",
    `name: "@local/${PKG}"`,
    "version: 0.1.0",
    `display_name: "${PKG}"`,
    'description: "입양 턴 직렬화 검증용 픽스처"',
    "harness:",
    "  variants:",
    "    - name: only",
    "      source: harness/only",
    "      entry: run",
    "agents:",
    `  - name: ${AGENT}`,
    "    default: true",
    `    persona: agents/${AGENT}/AGENT.md`,
    "",
  ].join("\n"));
  return dir;
}

const ledger: Ledger = {
  secret: "adopt-fixture-secret",
  packages: { [PKG]: { path: seat(), workspace: mk(path.join(ROOT, "ws")) } },
  grants: [],
};
const deps: ClientWireDeps = { getLedger: () => ledger, authority: localAuthority(() => ledger) };

async function door(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handleClientWire(deps, req, res, url)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "E_ROUTE", message: url.pathname } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/pkg/${PKG}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const ledgerOf = (file: string): Record<string, unknown>[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];

test("입양한 턴이 도는 동안 도착한 wire 턴은 즉시 실패하지 않고 그 뒤에 선다", async () => {
  const d = await door();
  const base = d.base;
  try {
    const { session } = await (await post(`${base}/sessions`, {})).json();
    const sdir = localSessionIO(() => ledger).sessionDir(PKG, session);
    fs.writeFileSync(path.join(sdir, "label"), "픽스처 대화"); // 자동 제목 턴 억제
    const turnsDir = mk(path.join(sdir, "turns"));

    // 도구 위임이 연 턴 — wire 밖에서 열리고 turnTap 으로 입양된다(daemon.ts setTurnTap 배선의 재현)
    const adopted = path.join(turnsDir, "adopted-1.jsonl");
    fs.writeFileSync(adopted, "");
    adoptSessionTurn(PKG, session, { id: "adopted-1", file: adopted });
    const h0 = await (await fetch(`${base}/sessions/${session}/history`)).json();
    assert.equal(h0.busy, true);
    assert.equal(h0.turn, "adopted-1", "관찰 창의 턴은 입양 턴이다");

    // 그 사이 도착한 wire 턴 — 202 로 받고 줄에 선다. 시작(started)도 실패(error)도 없어야 한다
    const started = await post(`${base}/turns`, { session, message: "뒤에 서라" });
    assert.equal(started.status, 202);
    const { turn } = await started.json();
    await new Promise((r) => setTimeout(r, 400));
    const early = ledgerOf(path.join(turnsDir, turn + ".jsonl"));
    assert.deepEqual(early.map((e) => e.event), [], JSON.stringify(early));
    const h1 = await (await fetch(`${base}/sessions/${session}/history`)).json();
    assert.equal(h1.turn, "adopted-1", "입양 턴이 끝나기 전엔 창의 턴이 바뀌지 않는다");

    // 입양 턴 종결 → 줄에 선 턴이 돌아 정산한다
    releaseSessionTurn(PKG, session, "adopted-1", { ok: true, result: { reply: "입양 답", code: 0 } });
    let after: Record<string, unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      after = ledgerOf(path.join(turnsDir, turn + ".jsonl"));
      if (after.some((e) => e.event === "turn" && e.status === "settled")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const kinds = after.map((e) => e.event + (e.status ? "/" + e.status : ""));
    assert.ok(kinds[0] === "turn/started", JSON.stringify(kinds));
    assert.ok(!after.some((e) => e.event === "error"), "문지기에 부딪히지 않는다: " + JSON.stringify(after));
    const reply = after.find((e) => e.event === "reply") as { text?: string } | undefined;
    assert.equal(reply?.text, "뒤에 선 답");
    assert.ok(kinds[kinds.length - 1] === "turn/settled");
    const h2 = await (await fetch(`${base}/sessions/${session}/history`)).json();
    assert.equal(h2.busy, false);
  } finally {
    await d.close();
  }
});
