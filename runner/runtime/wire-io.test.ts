// 계약 축 이음새(ClientWireIO)의 주입 경로가 실제로 도는가 — 기본 구현(현행 동작)이 계속
// 유일한 소비자이므로, 스텁 이음새를 꽂아 계약 문(docs/client-protocol.md)이 그 좌표를 쓰는지
// **실제 HTTP 왕복**으로 증명한다. 문을 직접 부르지 않고 서버를 세우는 이유는 SSE 때문이다:
// 턴 관찰은 응답 스트림의 수명이 곧 판정(§5.2-20)이라 가짜 res 로는 밟히지 않는다.
// 하네스는 봉투 두 줄만 내는 가짜 어댑터다 — 도구 설치 없이 턴 전 구간이 돈다.
//
//   node --experimental-strip-types --test runner/client-wire-io.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { SessionIO, SessionMessage } from "./harness.ts";
import type { ClientWireDeps, ClientWireIO, HarnessConfig, SessionRow } from "./wire.ts";

// state.ts 는 적재 시점에 RELAY_HOME·API_PORT·홈을 각인한다 — 주입 없는 기본 경로를 검증하려면
// 모듈을 들여오기 **전에** 그 좌표를 임시 자리로 돌려야 한다(사용자의 진짜 홈에 쓰지 않는다)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wire-io-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4747";

const { handleClientWire, tapSessionEvent } = await import("./wire.ts");
const { setEnvelopeTap } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");

// 봉투 방청 배선 — api.ts createApi 가 하는 한 줄. 없으면 stream 이 reply 만 보고
// delta 가 통째로 사라진다(왕복은 성공하는데 스트리밍만 죽는 형태)
setEnvelopeTap(tapSessionEvent);

const PKG = "wire-fixture";
const AGENT = "fixture";
const PKG_DIR = path.join(ROOT, "pkg");
const EMBED = path.join(ROOT, "embed");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ── 픽스처 패키지 — 판정을 통과하는 최소 매니페스트 + 하네스 변형 둘(harness-variants 축) ──
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  'if [ "${1:-}" = "info" ]; then',
  // capabilities 가 빈 목록인 것이 판정의 근거다 — 스텁은 effort 를 답하므로 개막 목록이 갈린다
  `  printf '%s\\n' '{"name":"fake","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":[]}'`,
  "  exit 0",
  "fi",
  'if [ "${1:-}" = "models" ]; then',
  `  printf '%s\\n' '["local-model"]'`,
  "  exit 0",
  "fi",
  'if [ "${1:-}" = "commands" ]; then',
  `  printf '%s\\n' '[{"name":"local-cmd"}]'`,
  "  exit 0",
  "fi",
  'if [ "${1:-}" = "setup" ]; then exit 0; fi',
  `printf '%s\\n' '{"event":"delta","text":"생각"}'`,
  `printf '%s\\n' '{"event":"reply","text":"기록됨"}'`,
].join("\n") + "\n";

mk(path.join(PKG_DIR, "agents", AGENT));
fs.writeFileSync(path.join(PKG_DIR, "agents", AGENT, "AGENT.md"), "픽스처 페르소나.\n");
for (const v of ["alpha", "beta"]) {
  mk(path.join(PKG_DIR, "harness", v));
  fs.writeFileSync(path.join(PKG_DIR, "harness", v, "run"), ADAPTER, { mode: 0o755 });
}
fs.writeFileSync(path.join(PKG_DIR, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@local/wire-fixture"',
  "version: 0.1.0",
  'display_name: "계약 축 픽스처"',
  'description: "계약 축 이음새 주입 경로 검증용"',
  "harness:",
  "  variants:",
  "    - name: alpha",
  "      source: harness/alpha",
  "      entry: run",
  "    - name: beta",
  "      source: harness/beta",
  "      entry: run",
  "agents:",
  `  - name: ${AGENT}`,
  "    default: true",
  `    persona: agents/${AGENT}/AGENT.md`,
  "",
].join("\n"));

const ledger: Ledger = {
  secret: "wire-fixture-secret",
  packages: { [PKG]: { path: PKG_DIR, workspace: path.join(ROOT, "default-ws") } },
  grants: [],
};

// ── 스텁 이음새 — 임베더 자리. 세션 살림은 메모리 행, 좌표는 embed/ 아래, 하네스는 자기 카탈로그 ──
const book: { slot: string; msg: SessionMessage }[] = [];
const rows = new Map<string, SessionRow>();
const seen: string[] = []; // 어느 문이 실제로 불렸는가 — 조립만 되고 안 불리면 이음새가 장식이다
let seq = 0;
const config = { model: null as string | null, effort: null as string | null, harness: null as string | null };

const stubSession: SessionIO = {
  sessionDir: (pkg, slot) => mk(path.join(EMBED, "sessions", pkg, slot)),
  workspaceDir: (pkg) => mk(path.join(EMBED, "ws", pkg)),
  stageDir: (pkg) => mk(path.join(EMBED, "stage", pkg)),
  apiUrl: "http://127.0.0.1:18080/embedder",
  denyRoots: ["/opt/embedder/home"],
  appendMessage: (_pkg, slot, msg) => {
    book.push({ slot, msg });
    const r = rows.get(slot);
    if (r) r.updated = Date.now();
  },
  readMessages: (_pkg, slot) => book.filter((b) => b.slot === slot).map((b) => b.msg),
  mcpServers: () => ({}),
};

const stub: ClientWireIO = {
  session: stubSession,
  listSessions: () => {
    seen.push("listSessions");
    return [...rows.values()];
  },
  createSession: (pkg, binding) => {
    seen.push("createSession");
    const id = "c-" + (++seq).toString(36) + "-embed";
    rows.set(id, { session: id, label: "임베더 대화 " + seq, updated: Date.now(), archived: false, pinned: false, ...binding });
    // 자동 제목 억제 — 이 임베더는 대화 이름을 자기가 짓는다. 억제하지 않으면 첫 턴마다
    // 제목 턴이 하나 더 돌아 픽스처 어댑터가 두 번 뜬다(autoTitleSession 은 세션 살림의
    // label/auto-label 파일을 본다)
    fs.writeFileSync(path.join(stubSession.sessionDir(pkg, id), "label"), "임베더 대화");
    return id;
  },
  updateSession: (_pkg, slot, patch) => {
    seen.push("updateSession");
    const r = rows.get(slot);
    if (!r) return false;
    if ("label" in patch) r.label = patch.label ?? "(자동)";
    if ("archived" in patch) r.archived = !!patch.archived;
    if ("pinned" in patch) r.pinned = !!patch.pinned;
    return true;
  },
  removeSession: (_pkg, slot) => {
    seen.push("removeSession");
    rows.delete(slot);
  },
  harnessQuery: (_pkg, verb) => {
    seen.push("harnessQuery:" + verb);
    if (verb === "models") return { ok: true, value: ["embed-model"] };
    if (verb === "commands") return { ok: true, value: [{ name: "embed-cmd" }] };
    return { ok: true, value: { name: "embedder", protocol: 3 } };
  },
  harnessCapabilities: () => {
    seen.push("harnessCapabilities");
    return ["effort"]; // 동봉 어댑터는 빈 목록을 답한다 — 개막에 effort 가 뜨면 이 문이 답한 것
  },
  setHarnessConfig: (_pkg, patch): HarnessConfig => {
    seen.push("setHarnessConfig");
    if (patch.harness) {
      config.harness = patch.harness;
      config.model = null; // 모델 어휘는 하네스 소속(§5.5-30-a)
    }
    if ("model" in patch) config.model = patch.model ?? null;
    if ("effort" in patch) config.effort = patch.effort ?? null;
    return { ...config, ...(patch.harness ? { ready: { ok: true, note: "임베더 준비됨" } } : {}) };
  },
};

// ── 문 하나 — handleClientWire 를 그대로 마운트한다(api.ts 의 한 줄과 같은 배선) ──
async function door(deps: ClientWireDeps): Promise<{ base: string; root: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handleClientWire(deps, req, res, url)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "E_ROUTE", message: url.pathname } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const root = `http://127.0.0.1:${port}`;
  return {
    root,
    base: `${root}/pkg/${PKG}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const jsonReq = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** 턴이 종결할 때까지 이력을 되묻는다 — busy 축(§5.3-24)이 그 판정의 정본이다 */
async function settle(base: string, session: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const h = await (await fetch(`${base}/sessions/${session}/history`)).json();
    if (!h.busy && (h.messages as unknown[]).length >= 2) return h;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("턴이 종결하지 않았다");
}

test("주입한 이음새로 계약 축이 선다 — 개막·개설·목록·이력·설정이 그 문을 지난다", async () => {
  const d = await door({ getLedger: () => ledger, authority: localAuthority(() => ledger), io: stub });
  try {
    // 개막(§3-7) — effort 는 동봉 어댑터가 답하지 않는 capability 다
    const caps = await (await fetch(`${d.base}/capabilities`)).json();
    assert.equal(caps.protocol, 1);
    assert.ok(caps.capabilities.includes("effort"), JSON.stringify(caps));
    assert.ok(caps.capabilities.includes("harness-variants"));
    assert.ok(seen.includes("harnessCapabilities"));

    // 개설(§5.3-22) — id 는 이음새가 발급하고, 판정(선언 밖 에이전트)은 계약이 한다
    const bad = await fetch(`${d.base}/sessions`, jsonReq({ agent: "없는-에이전트" }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "E_BAD_AGENT");
    const orphan = await fetch(`${d.base}/sessions`, jsonReq({ param: "무엇" }));
    assert.equal((await orphan.json()).error.code, "E_BAD_PARAM");

    const made = await (await fetch(`${d.base}/sessions`, jsonReq({ agent: AGENT, param: "대상" }))).json();
    assert.match(made.session, /-embed$/, "id 를 이음새가 발급하지 않았다");

    // 목록(§5.3-21) — 행은 이음새에서, 정렬(고정 우선)은 계약에서
    const second = await (await fetch(`${d.base}/sessions`, jsonReq({}))).json();
    await fetch(`${d.base}/sessions/${made.session}/pin`, jsonReq({ pinned: true }));
    const list = await (await fetch(`${d.base}/sessions`)).json();
    assert.deepEqual(list.sessions.map((s: SessionRow) => s.session), [made.session, second.session]);
    assert.equal(list.sessions[0].agent, AGENT);
    assert.equal(list.sessions[0].param, "대상");
    assert.equal(list.sessions[0].pinned, true);

    // 없는 세션의 메타 갱신은 404 — 실재 판정은 이음새가 답한다(§5.3-23)
    const ghost = await fetch(`${d.base}/sessions/c-nosuch/rename`, jsonReq({ label: "x" }));
    assert.equal(ghost.status, 404);
    assert.equal((await ghost.json()).error.code, "E_NO_SESSION");

    // 하네스 조회(§5.5-29) — 병합(패키지 커맨드)은 계약이, 값은 이음새가
    const models = await (await fetch(`${d.base}/harness/models`)).json();
    assert.deepEqual(models.value, ["embed-model"]);
    const commands = await (await fetch(`${d.base}/harness/commands`)).json();
    assert.deepEqual(commands.value, [{ name: "embed-cmd" }]);

    // 설정 쓰기(§5.5-30/30-a) — known 은 같은 문의 models 로 판정된다
    const set = await (await fetch(`${d.base}/model`, jsonReq({ model: "embed-model", effort: "high" }))).json();
    assert.deepEqual(
      { ok: set.ok, model: set.model, effort: set.effort, known: set.known },
      { ok: true, model: "embed-model", effort: "high", known: true },
    );
    const switched = await (await fetch(`${d.base}/model`, jsonReq({ harness: "beta" }))).json();
    assert.equal(switched.harness, "beta");
    assert.equal(switched.model, null, "변형 전환이 모델 오버라이드를 지우지 않았다");
    assert.deepEqual(switched.ready, { ok: true, note: "임베더 준비됨" });
    // 1인 기판 장부는 손대지 않았다 — 정본이 둘이 되면 200 {ok:true} 뒤에 값이 사라진다
    assert.equal(ledger.packages[PKG].model, undefined);
    assert.equal(ledger.packages[PKG].harness, undefined);
  } finally {
    await d.close();
  }
});

test("턴이 주입한 좌표를 딛는다 — 장부·무대·턴 장부·SSE", async () => {
  const d = await door({ getLedger: () => ledger, authority: localAuthority(() => ledger), io: stub });
  try {
    const s = await (await fetch(`${d.base}/sessions`, jsonReq({}))).json();

    // 업로드(§5.4-25) — 무대는 세션 이음새가 답한다
    const up = await (await fetch(`${d.base}/upload?name=note.txt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "첨부 본문",
    })).json();
    assert.equal(up.path, "uploads/note.txt");
    assert.ok(fs.existsSync(path.join(EMBED, "stage", PKG, "uploads", "note.txt")));
    const down = await fetch(`${d.base}/file/${up.path}`);
    assert.equal(await down.text(), "첨부 본문");

    // 턴 개설은 202 — 종결을 붙들지 않는다(§5.1-12)
    const started = await fetch(`${d.base}/turns`, jsonReq({ session: s.session, message: "안녕" }));
    assert.equal(started.status, 202);
    const { turn } = await started.json();

    // 관찰(§5.2) — 라이브든 장부 재생이든 같은 어휘가 나온다
    const live = await (await fetch(`${d.base}/turns/${turn}/stream`)).text();
    const events = live.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    assert.equal(events[0].status, "started");
    assert.equal(events.at(-1).status, "settled");
    assert.equal(events.at(-1).ok, true);
    assert.ok(events.some((e) => e.event === "delta" && e.text === "생각"), live);
    assert.ok(events.some((e) => e.event === "reply" && e.text === "기록됨"), live);

    // 이력(§5.3-24) — 세션 이음새의 장부를 그대로 본다(계약 축이 자기 리더를 갖지 않는다)
    const h = await settle(d.base, s.session);
    assert.deepEqual(
      (h.messages as { role: string; text: string }[]).map((m) => [m.role, m.text]),
      [["user", "안녕"], ["bot", "기록됨"]],
    );
    assert.equal(h.busy, false);
    assert.deepEqual(book.filter((b) => b.slot === s.session).map((b) => b.msg.role), ["user", "bot"]);

    // 턴 장부는 주입된 세션 좌표를 따라간다 — 재기동 후 재생(§5.1-13)의 원천
    const ledgerFile = path.join(EMBED, "sessions", PKG, s.session, "turns", turn + ".jsonl");
    assert.ok(fs.existsSync(ledgerFile), ledgerFile);

    // 종결 턴 재생 — 후보 슬롯이 이음새 목록에서 온다(메모리 레코드는 종결과 함께 내려갔다)
    seen.length = 0;
    const replay = await (await fetch(`${d.base}/turns/${turn}/stream`)).text();
    assert.ok(seen.includes("listSessions"), "재생이 이음새 열거를 지나지 않았다");
    assert.ok(replay.includes('"기록됨"'), replay);
    assert.ok(replay.includes('"settled"'), replay);

    // 기본 좌표는 손대지 않았다 — 장부가 파일로도 새면 정본이 둘이 된다
    assert.equal(fs.existsSync(path.join(process.env.RELAY_HOME!, "sessions", PKG, s.session)), false);

    // 삭제는 이음새를 지난다 — 진행 명부 정리(상주 은퇴)는 계약이 먼저 한다
    assert.equal((await (await fetch(`${d.base}/sessions/${s.session}/delete`, jsonReq({}))).json()).ok, true);
    assert.equal(rows.has(s.session), false);
  } finally {
    await d.close();
  }
});

test("미주입이면 현행 그대로 — 파일 살림·동봉 어댑터·기판 장부", async () => {
  const d = await door({ getLedger: () => ledger, authority: localAuthority(() => ledger) });
  const home = process.env.RELAY_HOME!;
  try {
    // 동봉 어댑터의 capabilities 는 빈 목록이다 — 스텁이 답하던 effort 가 여기엔 없다
    const caps = await (await fetch(`${d.base}/capabilities`)).json();
    assert.equal(caps.protocol, 1);
    assert.equal(caps.capabilities.includes("effort"), false, JSON.stringify(caps));
    assert.ok(caps.capabilities.includes("harness-models"));

    const s = await (await fetch(`${d.base}/sessions`, jsonReq({}))).json();
    assert.match(s.session, /^s-/, "기본 구현의 id 문법이 아니다");
    assert.ok(fs.existsSync(path.join(home, "sessions", PKG, s.session)));

    // 없는 세션의 이력 조회가 살림을 만들면 안 된다 — 유령 행의 근원
    const ghost = await (await fetch(`${d.base}/sessions/s-nosuch/history`)).json();
    assert.deepEqual(ghost.messages, []);
    assert.equal(fs.existsSync(path.join(home, "sessions", PKG, "s-nosuch")), false);

    await fetch(`${d.base}/sessions/${s.session}/rename`, jsonReq({ label: "손으로 지은 이름" }));
    const list = await (await fetch(`${d.base}/sessions`)).json();
    assert.equal(list.sessions.find((r: SessionRow) => r.session === s.session)?.label, "손으로 지은 이름");
    assert.equal(fs.readFileSync(path.join(home, "sessions", PKG, s.session, "label"), "utf8"), "손으로 지은 이름");

    // 하네스 조회·설정은 동봉 어댑터와 기판 장부를 지난다
    const models = await (await fetch(`${d.base}/harness/models`)).json();
    assert.deepEqual(models.value, ["local-model"]);
    const set = await (await fetch(`${d.base}/model`, jsonReq({ model: "local-model" }))).json();
    assert.equal(set.known, true);
    assert.equal(ledger.packages[PKG].model, "local-model");
    const rejected = await fetch(`${d.base}/model`, jsonReq({ harness: "없는변형" }));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, "E_BAD_REQUEST");

    // 스텁 장부는 기본 턴을 보지 못한다 — 두 좌표가 서로 새지 않는다
    assert.equal(book.some((b) => b.slot === s.session), false);
  } finally {
    ledger.packages[PKG].model = undefined;
    await d.close();
  }
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
