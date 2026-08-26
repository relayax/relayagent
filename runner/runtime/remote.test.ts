// 원격 제어 상주(harness.remote, client-protocol §5.5-30-b)가 **문에서 프로세스까지 닿는가** —
// 실제 HTTP 왕복 + 실제 자식 프로세스로 증명한다. 어댑터가 `remote` 동사를 선언해야만 문이 있고
// (미선언은 404 — 없는 문), 켜면 상주가 서고 끄면 내려간다. 켜짐은 장부에 남는다.
//
//   node --experimental-strip-types --test runner/runtime/remote.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { ClientWireDeps } from "./wire.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-remote-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4751";

const { handleClientWire } = await import("./wire.ts");
const { stopAllRemotes, remoteStatus } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");
const { saveLedger, loadLedger } = await import("../supply/ledger.ts");

const AGENT = "fixture";

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 픽스처 어댑터 — remote 동사는 신호가 올 때까지 잠든다(상주의 최소 형) */
function adapter(name: string, remote: boolean): string {
  const verbs = ["session", "info", "setup", "models", "commands", ...(remote ? ["remote"] : [])];
  const caps = remote ? ["remote"] : [];
  return [
    "#!/bin/bash",
    "set -eu",
    'if [ "${1:-}" = "info" ]; then',
    `  printf '%s\\n' '{"name":"${name}","provider":"none","protocol":3,"verbs":[${verbs.map((v) => `"${v}"`).join(",")}],"capabilities":[${caps.map((c) => `"${c}"`).join(",")}]}'`,
    "  exit 0",
    "fi",
    `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["local-model"]'; exit 0; fi`,
    `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
    'if [ "${1:-}" = "setup" ]; then exit 0; fi',
    'if [ "${1:-}" = "remote" ]; then exec sleep 300; fi',
    `printf '%s\\n' '{"event":"reply","text":"정산"}'`,
  ].join("\n") + "\n";
}

function seat(pkg: string, remote: boolean): string {
  const dir = mk(path.join(ROOT, pkg));
  mk(path.join(dir, "agents", AGENT));
  fs.writeFileSync(path.join(dir, "agents", AGENT, "AGENT.md"), "픽스처 페르소나.\n");
  mk(path.join(dir, "harness", "only"));
  fs.writeFileSync(path.join(dir, "harness", "only", "run"), adapter(pkg, remote), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "relay.yaml"), [
    "schema: relay/v1",
    `name: "@local/${pkg}"`,
    "version: 0.1.0",
    `display_name: "${pkg}"`,
    'description: "원격 제어 계약 검증용 픽스처"',
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

const REMOTE = "remote-yes";
const PLAIN = "remote-no";
const ledger: Ledger = {
  secret: "remote-fixture-secret",
  packages: {
    [REMOTE]: { path: seat(REMOTE, true), workspace: mk(path.join(ROOT, "ws-yes")) },
    [PLAIN]: { path: seat(PLAIN, false), workspace: mk(path.join(ROOT, "ws-no")) },
  },
  grants: [],
};
// startRemote 는 장부 파일(RELAY_HOME)을 읽고 쓴다 — 픽스처 장부를 그 자리에 앉힌다
mk(process.env.RELAY_HOME!);
saveLedger(ledger);

const deps: ClientWireDeps = { getLedger: () => loadLedger(), authority: localAuthority(() => loadLedger()) };

async function door(): Promise<{ base: (pkg: string) => string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handleClientWire(deps, req, res, url)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "E_ROUTE", message: url.pathname } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    base: (pkg) => `http://127.0.0.1:${port}/pkg/${pkg}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("remote 를 선언한 하네스: 켜면 상주가 서고 장부에 남으며, 끄면 내려간다", async () => {
  const d = await door();
  try {
    const on = await (await post(`${d.base(REMOTE)}/harness/remote`, { enabled: true })).json();
    assert.equal(on.ok, true);
    assert.equal(on.running, true);
    assert.equal(typeof on.pid, "number");
    assert.equal(on.variant, "only");
    assert.equal(loadLedger().packages[REMOTE].remote, true, "켜짐이 장부에 남는다");

    const st = await (await fetch(`${d.base(REMOTE)}/harness/remote`)).json();
    assert.equal(st.running, true);
    assert.equal(st.pid, on.pid);

    const off = await (await post(`${d.base(REMOTE)}/harness/remote`, { enabled: false })).json();
    assert.equal(off.running, false);
    assert.equal(loadLedger().packages[REMOTE].remote, undefined, "끄면 장부 표시도 지운다");
    // 프로세스가 실제로 내려갔는가 — close 는 비동기라 잠깐 기다린다
    for (let i = 0; i < 40 && remoteStatus(REMOTE).running; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(remoteStatus(REMOTE).running, false);
  } finally {
    stopAllRemotes();
    await d.close();
  }
});

test("remote 미선언 하네스: 문이 없다(404 E_NO_REMOTE) — 501 이 아니다", async () => {
  const d = await door();
  try {
    const r = await post(`${d.base(PLAIN)}/harness/remote`, { enabled: true });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.error.code, "E_NO_REMOTE");
    assert.equal(loadLedger().packages[PLAIN].remote, undefined);
  } finally {
    stopAllRemotes();
    await d.close();
  }
});
