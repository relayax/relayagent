// 세션 이음새(SessionIO)의 주입 경로가 실제로 도는가 — 기본 구현(현행 동작)이 계속 유일한
// 소비자이므로, 스텁 이음새를 꽂아 세션이 그 좌표를 쓰는지 실행으로 증명한다.
// 하네스는 봉투 한 줄만 내고 자기가 본 좌표를 파일로 흘리는 가짜 어댑터다 — 도구 설치 없이
// 세션 전 구간(번들 조립·스폰 env·장부·인수인계)이 돈다.
//
//   node --experimental-strip-types --test runner/session-io.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";
import type { McpDoor, SessionIO, SessionMessage } from "./harness.ts";

// state.ts 는 적재 시점에 RELAY_HOME·API_PORT·홈을 각인한다 — 주입 없는 기본 경로를 검증하려면
// 모듈을 들여오기 **전에** 그 좌표를 임시 자리로 돌려야 한다(사용자의 진짜 홈에 쓰지 않는다)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-io-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4747";

const { runSession, recoverDanglingTurns } = await import("./harness.ts");

const PKG = "seam-fixture";
const AGENT = "fixture";
const PKG_DIR = path.join(ROOT, "pkg");
const EMBED = path.join(ROOT, "embed");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ── 픽스처 패키지 — 판정을 통과하는 최소 매니페스트 + 하네스 변형 둘(전환 인수인계용) ──
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  'if [ "${1:-}" = "info" ]; then',
  `  printf '%s\\n' '{"name":"fake","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":[]}'`,
  "  exit 0",
  "fi",
  "{",
  `  printf 'cwd=%s\\n' "$PWD"`,
  `  printf 'api=%s\\n' "\${RELAY_API:-}"`,
  `  printf 'bundle=%s\\n' "\${RELAY_BUNDLE:-}"`,
  `  printf 'agent=%s\\n' "\${RELAY_AGENT:-}"`,
  '} > "$FAKE_PROBE"',
  `printf '%s' "\${2:-}" > "$FAKE_PROBE.prompt"`,
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
  'name: "@local/seam-fixture"',
  "version: 0.1.0",
  'display_name: "이음새 픽스처"',
  'description: "세션 이음새 주입 경로 검증용"',
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
  '    greeting: "픽스처 인사말"',
  "",
].join("\n"));

const ledger: Ledger = {
  secret: "seam-fixture-secret",
  packages: { [PKG]: { path: PKG_DIR, workspace: path.join(ROOT, "default-ws") } },
  grants: [],
};

// ── 스텁 이음새 — 임베더 자리. 장부는 메모리, 좌표는 전부 embed/ 아래, 문은 복수 ──
const book: { pkg: string; slot: string; msg: SessionMessage }[] = [];
const stub: SessionIO = {
  sessionDir: (pkg, slot) => mk(path.join(EMBED, "sessions", pkg, slot)),
  workspaceDir: (pkg) => mk(path.join(EMBED, "ws", pkg)),
  stageDir: (pkg) => mk(path.join(EMBED, "stage", pkg)),
  apiUrl: "http://127.0.0.1:18080/embedder",
  denyRoots: ["/opt/embedder/home"],
  appendMessage: (pkg, slot, msg) => void book.push({ pkg, slot, msg }),
  readMessages: (pkg, slot) => book.filter((b) => b.pkg === pkg && b.slot === slot).map((b) => b.msg),
  mcpServers: (pkg, agent, slot, relay: McpDoor) => ({
    ask: { url: "http://127.0.0.1:18081/mcp", headers: { "x-turn": `${pkg}/${agent}/${slot}` } },
    scripts: { url: relay.url, authorization: relay.authorization },
  }),
};

function probe(name: string): { read: () => Record<string, string>; prompt: () => string } {
  const file = path.join(ROOT, `probe-${name}.txt`);
  process.env.FAKE_PROBE = file;
  return {
    read: () => Object.fromEntries(
      fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
        const at = l.indexOf("=");
        return [l.slice(0, at), l.slice(at + 1)];
      }),
    ),
    prompt: () => fs.readFileSync(file + ".prompt", "utf8"),
  };
}

const messages = (slot: string): SessionMessage[] => book.filter((b) => b.slot === slot).map((b) => b.msg);

test("주입한 이음새의 좌표로 턴이 선다 — 경로·문 주소·담장·장부·다중 MCP 문", async () => {
  const p = probe("stub");
  const r = await runSession({ ledger, pkg: PKG, prompt: "안녕하세요 첫 턴", slot: "s1", io: stub });
  assert.equal(r.reply, "기록됨");

  const seen = p.read();
  assert.equal(seen.cwd, fs.realpathSync(path.join(EMBED, "ws", PKG)));
  assert.equal(seen.api, "http://127.0.0.1:18080/embedder");
  assert.equal(seen.bundle, path.join(EMBED, "sessions", PKG, "s1", "bundle"));
  assert.equal(seen.agent, AGENT);

  const meta = JSON.parse(fs.readFileSync(path.join(seen.bundle, "meta.json"), "utf8"));
  // 인사말은 그 에이전트 선언에서 온다 — 패키지 전역 표면이 아니라 말하는 쪽 소속
  assert.equal(meta.greeting, "픽스처 인사말");
  assert.equal(meta.cwd, path.join(EMBED, "ws", PKG));
  assert.equal(meta.stage, path.join(EMBED, "stage", PKG));
  assert.deepEqual(meta.hooks.deny, ["/opt/embedder/home"]);
  assert.ok(String(meta.mcp.url).startsWith("http://127.0.0.1:18080/embedder/mcp/"));
  // 다중 문은 additive — 단일 mcp 도 함께 나간다(구형 어댑터가 그것만 읽는다)
  assert.deepEqual(Object.keys(meta.mcpServers).sort(), ["ask", "scripts"]);
  assert.equal(meta.mcpServers.ask.headers["x-turn"], `${PKG}/${AGENT}/s1`);
  assert.equal(meta.mcpServers.scripts.url, meta.mcp.url);
  assert.equal(meta.mcpServers.scripts.authorization, meta.mcp.authorization);

  assert.deepEqual(messages("s1").map((m) => [m.role, m.text]), [["user", "안녕하세요 첫 턴"], ["bot", "기록됨"]]);
  // 기본 좌표는 손대지 않았다 — 장부가 파일로도 새면 정본이 둘이 된다
  assert.equal(fs.existsSync(path.join(process.env.RELAY_HOME!, "sessions")), false);
});

test("인수인계 서문이 주입된 장부에서 온다 — 하네스 전환", async () => {
  const p = probe("handoff");
  ledger.packages[PKG].harness = "beta";
  await runSession({ ledger, pkg: PKG, prompt: "이어서 답하라", slot: "s1", io: stub });
  const prompt = p.prompt();
  assert.ok(prompt.includes("[대화 인수인계"), prompt);
  assert.ok(prompt.includes("사용자: 안녕하세요 첫 턴"), prompt);
  ledger.packages[PKG].harness = undefined;
});

test("끊긴 턴 복구도 주입된 장부를 읽고 쓴다", () => {
  stub.appendMessage(PKG, "s2", { t: new Date().toISOString(), role: "user", text: "답이 없는 물음" });
  assert.equal(recoverDanglingTurns(PKG, "s2", stub), true);
  const rows = messages("s2");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].role, "bot");
  assert.ok(rows[1].text.includes("저장되지 못했습니다"));
  // 이미 답이 있는 슬롯은 복구 대상이 아니다
  assert.equal(recoverDanglingTurns(PKG, "s2", stub), false);
});

test("미주입이면 현행 그대로 — 파일 장부·기판 홈 담장·단일 mcp 문", async () => {
  const p = probe("default");
  const r = await runSession({ ledger, pkg: PKG, prompt: "기본 경로", slot: "d1" });
  assert.equal(r.reply, "기록됨");

  const home = process.env.RELAY_HOME!;
  const dir = path.join(home, "sessions", PKG, "d1");
  const rows = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((m) => [m.role, m.text]), [["user", "기본 경로"], ["bot", "기록됨"]]);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, "bundle", "meta.json"), "utf8"));
  assert.equal("mcpServers" in meta, false); // 이음새가 답하지 않으면 필드 자체가 없다
  assert.ok(String(meta.mcp.url).startsWith("http://127.0.0.1:4747/mcp/"));
  assert.deepEqual(meta.hooks.deny, [home]);

  const seen = p.read();
  assert.equal(seen.api, "http://127.0.0.1:4747");
  assert.equal(seen.cwd, fs.realpathSync(path.join(ROOT, "default-ws")));
  // 스텁 장부는 기본 턴을 보지 못한다 — 두 좌표가 서로 새지 않는다
  assert.equal(messages("d1").length, 0);
});

// 조용한 강등의 자리 — 종전에는 선언 밖 이름이 display_name 으로 지어낸 기본 페르소나로
// 강등돼 대화가 성립했다. 오타가 "이름 없는 에이전트" 로 답하는 것이 침묵의 실패다
test("선언 밖 에이전트는 턴을 열지 못한다 — 기본 페르소나 강등 은퇴", async () => {
  await assert.rejects(
    () => runSession({ ledger, pkg: PKG, agent: "wrker", prompt: "오타 난 이름", slot: "bad", io: stub }),
    (e: Error) => /선언 밖 에이전트/.test(e.message) && e.message.includes(AGENT),
  );
  // 부작용 앞에서 끊는다 — 거절된 턴은 슬롯도 장부도 남기지 않는다
  assert.equal(fs.existsSync(path.join(EMBED, "sessions", PKG, "bad", "bundle")), false);
  assert.equal(messages("bad").length, 0);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
