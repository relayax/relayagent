// 관찰 다중화(client-protocol §5.2-20-a, capability observe) — 세션 여러 개의 턴이 SSE 한 줄기로
// 오는가. 실제 HTTP 왕복 + 실제 자식 프로세스로 증명한다.
//
// 이 시험이 필요한 이유(2026-08-27): 탭 셸이 세션마다 관찰 SSE 를 열어 브라우저 origin 커넥션
// 예산(6)을 잠식했고, 그것을 막으려던 "인스턴스당 관찰 1개" 규칙은 두 세션이 서로를 끊게 했다.
// 줄기 하나에 여러 세션을 싣는 것이 답이다. 못박는 것:
//  1. 개막이 observe 를 선언한다.
//  2. 줄기 하나에 두 세션의 턴이 turn·session 좌표를 달고 함께 흐르고, 구독 뒤에 선 턴은
//     observe/turn 으로 알린 뒤 started→…→settled 까지 실린다.
//  3. 구독을 걷은 세션의 이벤트는 더 오지 않는다.
//  4. 잘못된 관찰자 id 는 400, 없는 줄기에 대한 구독 편집은 404.
//
//   node --experimental-strip-types --test runner/runtime/observe.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { ClientWireDeps } from "./wire.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-observe-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4757";

const { handleClientWire, tapSessionEvent } = await import("./wire.ts");
const { setEnvelopeTap, localSessionIO } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");

setEnvelopeTap(tapSessionEvent); // 봉투 방청 배선 — 없으면 라이브 줄기에 delta 가 실리지 않는다

const AGENT = "fixture";
const PKG = "observe-fixture";

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 픽스처 어댑터 — 주입마다 delta 하나·reply 하나를 내고 끝난다 */
function adapter(): string {
  return [
    "#!/bin/bash",
    "set -eu",
    'if [ "${1:-}" = "info" ]; then',
    `  printf '%s\\n' '{"name":"observe-fixture","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":[]}'`,
    "  exit 0",
    "fi",
    `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["local-model"]'; exit 0; fi`,
    `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
    'if [ "${1:-}" = "setup" ]; then exit 0; fi',
    `printf '%s\\n' '{"event":"delta","text":"돌고 있음"}'`,
    `printf '%s\\n' '{"event":"reply","text":"정산"}'`,
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
    'description: "관찰 다중화 검증용 픽스처"',
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
  secret: "observe-fixture-secret",
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
  return {
    base: `http://127.0.0.1:${port}/pkg/${PKG}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** 자동 제목 억제 — 첫 교환 뒤 제목 턴이 하나 더 돌면 줄기에 낯선 턴이 섞인다 */
function nameIt(slot: string): void {
  fs.writeFileSync(path.join(localSessionIO(() => ledger).sessionDir(PKG, slot), "label"), "픽스처 대화");
}

type Line = Record<string, unknown>;

/** 줄기를 열고 data: 줄을 JSON 으로 모은다 */
async function openStream(url: string): Promise<{ lines: Line[]; close: () => void; until: (pred: (l: Line[]) => boolean, ms?: number) => Promise<void> }> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const lines: Line[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const l of chunk.split("\n")) {
            if (!l.startsWith("data:")) continue;
            try { lines.push(JSON.parse(l.slice(5).trim())); } catch { /* 주석·부분 줄 */ }
          }
        }
      }
    } catch { /* 닫힘 */ }
  })();
  const until = async (pred: (l: Line[]) => boolean, ms = 15_000): Promise<void> => {
    const t0 = Date.now();
    while (!pred(lines)) {
      if (Date.now() - t0 > ms) throw new Error("기다리던 줄이 오지 않았다: " + JSON.stringify(lines.slice(-5)));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { lines, close: () => ctrl.abort(), until };
}

const settledOf = (lines: Line[], turn: string) =>
  lines.some((l) => l.event === "turn" && l.status === "settled" && l.turn === turn);

test("관찰 다중화 — 줄기 하나에 두 세션의 턴이 좌표를 달고 함께 흐른다", async () => {
  const d = await door();
  const base = d.base;
  try {
    const caps = await (await fetch(`${base}/capabilities`)).json();
    assert.ok(caps.capabilities.includes("observe"), JSON.stringify(caps));

    // 잘못된 id / 없는 줄기
    assert.equal((await fetch(`${base}/observe?id=bad%20id`)).status, 400);
    assert.equal((await post(`${base}/observe/nope/sessions`, { add: [] })).status, 404);

    const st = await openStream(`${base}/observe?id=obs-1`);
    await st.until((l) => l.some((x) => x.event === "observe" && x.status === "ready"));

    const { session: s1 } = await (await post(`${base}/sessions`, {})).json();
    const { session: s2 } = await (await post(`${base}/sessions`, {})).json();
    nameIt(s1); nameIt(s2);

    const sub = await post(`${base}/observe/obs-1/sessions`, { add: [s1, s2] });
    assert.equal(sub.status, 200);
    await st.until((l) => l.filter((x) => x.event === "observe" && x.status === "session").length === 2);
    for (const l of st.lines.filter((x) => x.event === "observe" && x.status === "session")) {
      assert.deepEqual(l.turns, [], "아직 선 턴이 없다");
    }

    const t1 = (await (await post(`${base}/turns`, { session: s1, message: "하나" })).json()).turn as string;
    const t2 = (await (await post(`${base}/turns`, { session: s2, message: "둘" })).json()).turn as string;
    await st.until((l) => settledOf(l, t1) && settledOf(l, t2));

    // 개설 알림이 각 턴에 하나씩, 그 뒤 수명주기·delta·reply 가 좌표를 달고 왔다
    const notices = st.lines.filter((x) => x.event === "observe" && x.status === "turn");
    assert.deepEqual(notices.map((n) => [n.session, n.turn]).sort(), [[s1, t1], [s2, t2]].sort());
    for (const [sid, tid] of [[s1, t1], [s2, t2]] as const) {
      const mine = st.lines.filter((x) => x.event !== "observe" && x.turn === tid);
      assert.ok(mine.every((x) => x.session === sid), "모든 줄이 세션 좌표를 단다");
      assert.deepEqual(
        mine.map((x) => x.event + (x.status ? "/" + x.status : "")),
        ["turn/started", "delta", "reply", "turn/settled"],
        JSON.stringify(mine),
      );
    }
    assert.ok(st.lines.every((x) => x.event === "observe" || (typeof x.turn === "string" && typeof x.session === "string")), "좌표 없는 줄은 없다");

    // 구독을 걷은 세션의 턴은 줄기에 오지 않는다
    assert.equal((await post(`${base}/observe/obs-1/sessions`, { remove: [s2] })).status, 200);
    const before = st.lines.length;
    const t3 = (await (await post(`${base}/turns`, { session: s2, message: "셋" })).json()).turn as string;
    for (let i = 0; i < 200; i++) {
      const h = await (await fetch(`${base}/sessions/${s2}/history`)).json();
      if (!h.busy && (h.messages as unknown[]).length >= 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(st.lines.length, before, "걷은 세션의 줄은 오지 않는다");
    assert.ok(!st.lines.some((x) => x.turn === t3));

    // 아직 구독 중인 세션은 계속 흐른다
    const t4 = (await (await post(`${base}/turns`, { session: s1, message: "넷" })).json()).turn as string;
    await st.until((l) => settledOf(l, t4));

    st.close();
  } finally {
    await d.close();
  }
});
