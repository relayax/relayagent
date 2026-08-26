// 얹기(turn.steer, client-protocol §5.1-16-a)가 **진행 중 턴에 실제로 닿는가** — 실제 HTTP
// 왕복 + 실제 자식 프로세스로 증명한다. 가짜 res 나 함수 직접 호출로는 밟히지 않는 것이 둘 있다:
// 진행 명부(live)에 자식이 서 있어야 stdin 이 열리고, 어댑터가 되돌려 준 증언이 턴 장부를
// 지나야 재생이 라이브와 같은 파트를 만든다.
//
// 픽스처 어댑터는 제어 채널에서 steer 한 줄을 **기다렸다가** 정산한다 — 그래서 얹기가 닿지
// 않으면 턴이 정산되지 않고 테스트가 조용히 통과하는 일이 없다.
//
//   node --experimental-strip-types --test runner/runtime/steer.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { ClientWireDeps } from "./wire.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-steer-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4749";

const { handleClientWire, tapSessionEvent } = await import("./wire.ts");
const { setEnvelopeTap, localSessionIO } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");

// 봉투 방청 배선 — 이것이 없으면 어댑터의 steer 증언이 라이브 스트림에 실리지 않는다
setEnvelopeTap(tapSessionEvent);

const AGENT = "fixture";

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 픽스처 어댑터 한 벌. caps 가 선언 목록이고, waits=true 면 정산 전에 steer 를 기다린다 */
function adapter(name: string, caps: string[], waits: boolean): string {
  const wait = waits
    ? [
      // 제어 채널에서 steer 를 기다린다 — 얹기가 닿아야만 이 턴이 정산된다.
      // -t 는 그물이다: 안 오면 매달리는 대신 증언 없이 정산해 테스트가 실패로 드러난다
      "while IFS= read -r -t 20 line; do",
      '  case "$line" in',
      `    *'"type":"steer"'*)`,
      `      text=$(printf '%s' "$line" | sed -e 's/.*"prompt":"//' -e 's/".*//')`,
      `      printf '%s\\n' "{\\"event\\":\\"steer\\",\\"text\\":\\"$text\\"}"`,
      "      break;;",
      "  esac",
      "done",
    ].join("\n")
    : "";
  return [
    "#!/bin/bash",
    "set -eu",
    'if [ "${1:-}" = "info" ]; then',
    `  printf '%s\\n' '{"name":"${name}","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":[${caps.map((c) => `"${c}"`).join(",")}]}'`,
    "  exit 0",
    "fi",
    `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["local-model"]'; exit 0; fi`,
    `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
    'if [ "${1:-}" = "setup" ]; then exit 0; fi',
    `printf '%s\\n' '{"event":"delta","text":"돌고 있음"}'`,
    wait,
    `printf '%s\\n' '{"event":"reply","text":"정산"}'`,
  ].filter(Boolean).join("\n") + "\n";
}

/** 판정을 통과하는 최소 패키지를 세운다 */
function seat(pkg: string, caps: string[], waits: boolean): string {
  const dir = mk(path.join(ROOT, pkg));
  mk(path.join(dir, "agents", AGENT));
  fs.writeFileSync(path.join(dir, "agents", AGENT, "AGENT.md"), "픽스처 페르소나.\n");
  mk(path.join(dir, "harness", "only"));
  fs.writeFileSync(path.join(dir, "harness", "only", "run"), adapter(pkg, caps, waits), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "relay.yaml"), [
    "schema: relay/v1",
    `name: "@local/${pkg}"`,
    "version: 0.1.0",
    `display_name: "${pkg}"`,
    'description: "얹기 계약 검증용 픽스처"',
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

const STEERS = "steer-yes";
const PLAIN = "steer-no";
const ledger: Ledger = {
  secret: "steer-fixture-secret",
  packages: {
    [STEERS]: { path: seat(STEERS, ["steer"], true), workspace: mk(path.join(ROOT, "ws-yes")) },
    [PLAIN]: { path: seat(PLAIN, [], false), workspace: mk(path.join(ROOT, "ws-no")) },
  },
  grants: [],
};

const deps: ClientWireDeps = { getLedger: () => ledger, authority: localAuthority(() => ledger) };

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

/** 자동 제목 억제 — 첫 교환이 끝나면 제목 턴이 하나 더 도는데, 그 턴의 어댑터도 steer 를
 *  기다리므로 테스트가 끝난 뒤까지 자식이 남는다(harness.ts autoTitleSession 의 label 게이트) */
function nameIt(pkg: string, slot: string): void {
  fs.writeFileSync(path.join(localSessionIO(() => ledger).sessionDir(pkg, slot), "label"), "픽스처 대화");
}

async function settled(base: string, session: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const h = await (await fetch(`${base}/sessions/${session}/history`)).json();
    if (!h.busy && (h.messages as unknown[]).length >= 2) return h;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("턴이 종결하지 않았다");
}

test("얹기는 진행 중 턴에 닿고, 이력·장부에 그 자리를 남긴다", async () => {
  const d = await door();
  const base = d.base(STEERS);
  try {
    // 개막 — 어댑터 capability 의 투영(§7)
    const caps = await (await fetch(`${base}/capabilities`)).json();
    assert.ok(caps.capabilities.includes("steer"), JSON.stringify(caps));

    const { session } = await (await post(`${base}/sessions`, {})).json();
    nameIt(STEERS, session);
    const started = await post(`${base}/turns`, { session, message: "첫 말" });
    assert.equal(started.status, 202);
    const { turn } = await started.json();

    // 어댑터가 서기까지의 창 — ok:false 는 실패가 아니라 "아직/이미 없다" 이므로 되묻는다
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      ok = (await (await post(`${base}/turns/${turn}/steer`, { prompt: "얹은 말" })).json()).ok === true;
      if (!ok) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ok, "진행 중 턴에 얹지 못했다");

    // 픽스처는 얹힌 뒤에야 정산한다 — 종결했다는 것 자체가 말이 닿았다는 증거다
    const h = await settled(base, session);
    const msgs = h.messages as { role: string; text: string }[];
    assert.deepEqual(msgs.map((m) => m.role), ["user", "user", "bot"]);
    assert.equal(msgs[0].text, "첫 말");
    // 얹힌 발화는 정산을 기다리지 않고 이력에 앉는다 — 기판이 죽어도 사용자 말이 남는다
    assert.equal(msgs[1].text, "얹은 말");

    // 재생 — 장부를 지난 steer 증언이 라이브와 같은 줄로 다시 나온다(§5.1-13)
    const replay = await (await fetch(`${base}/turns/${turn}/stream`)).text();
    const events = replay.split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    const steer = events.find((e) => e.event === "steer");
    assert.ok(steer, "장부에 steer 증언이 없다: " + replay);
    assert.equal(steer.text, "얹은 말");
    // 순서가 뜻이다 — 얹힌 말은 진행 중(delta 뒤)에 들어갔고 정산(reply)보다 앞이다
    const at = (name: string) => events.findIndex((e) => e.event === name);
    assert.ok(at("delta") < at("steer") && at("steer") < at("reply"), JSON.stringify(events.map((e) => e.event)));

    // 종결한 턴에는 얹을 자리가 없다 — 오류가 아니라 ok:false 다(화면은 새 턴으로 폴백한다)
    const late = await post(`${base}/turns/${turn}/steer`, { prompt: "늦은 말" });
    assert.equal(late.status, 200);
    assert.equal((await late.json()).ok, false);
  } finally {
    await d.close();
  }
});

test("얹기를 모르는 하네스에서 그 동사는 없는 문이다 — 404(§3-8)", async () => {
  const d = await door();
  const base = d.base(PLAIN);
  try {
    const caps = await (await fetch(`${base}/capabilities`)).json();
    assert.ok(!caps.capabilities.includes("steer"), JSON.stringify(caps));

    const { session } = await (await post(`${base}/sessions`, {})).json();
    nameIt(PLAIN, session);
    const { turn } = await (await post(`${base}/turns`, { session, message: "첫 말" })).json();
    const r = await post(`${base}/turns/${turn}/steer`, { prompt: "얹은 말" });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, "E_NO_STEER");
    await settled(base, session);
  } finally {
    await d.close();
  }
});

test("빈 발화는 얹지 않는다 — 400", async () => {
  const d = await door();
  const base = d.base(STEERS);
  try {
    const { session } = await (await post(`${base}/sessions`, {})).json();
    nameIt(STEERS, session);
    const { turn } = await (await post(`${base}/turns`, { session, message: "첫 말" })).json();
    const r = await post(`${base}/turns/${turn}/steer`, { prompt: "   " });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, "E_BAD_PROMPT");
    // 픽스처는 steer 를 기다리므로 정산시켜 자식을 회수한다
    for (let i = 0; i < 100; i++) {
      if ((await (await post(`${base}/turns/${turn}/steer`, { prompt: "마무리" })).json()).ok === true) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await settled(base, session);
  } finally {
    await d.close();
  }
});
