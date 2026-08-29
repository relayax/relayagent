// liveness.test.ts — "지금 살아 있나" 의 세 조각.
//
// 이 시험이 필요한 이유(2026-08-29): 사용자가 위임을 걸어 놓고 "진행중인가요?" 를 반복해서
// 물어야 했다. 화면에 상태가 둘뿐이었기 때문이다 — 스피너가 돌거나, 안 돌거나. 30분째 도는
// 위임과 죽은 위임이 목록에서 똑같이 생겼고, 목록은 디스크만 읽고 생존은 이 파일의 메모리에만
// 있어 둘이 만나는 자리가 없었다.
//
// 여기서 재는 것은 셋이다.
//  1. **박동은 활동이 아니다.** 어댑터가 `alive` 를 뛰는 동안에도 스톨 워치독은 진짜 침묵을
//     읽어야 한다. 접어서 갱신하면 고착이 영원히 건강해 보인다 — 워치독을 통째로 무력화하는
//     회귀이므로 이것이 이 파일에서 가장 중요한 시험이다.
//  2. **박동은 장부에 안 남는다.** 15초마다 한 줄이면 긴 도구 하나가 턴 장부를 박동으로 채우고,
//     재생이 그 침묵을 진행으로 오독한다.
//  3. **목록 행이 생존을 싣는다.** busy·lastEvent·parent 가 세션 행에 나와야 화면이 "돌고 있음"
//     을 말할 수 있다.
//
//   node --experimental-strip-types --test runner/runtime/liveness.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-live-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4757";
// 워치독을 시험 시간 안으로 당긴다 — 검사 주기는 판정선을 따라 촘촘해진다(STALL_TICK_MS)
process.env.RELAY_TURN_STALL_S = "2";

const { runSession, enableResidents, localSessionIO, retireResidents, sessionLiveness } = await import("./harness.ts");
const { localClientWireIO } = await import("./wire.ts");
const { localAuthority } = await import("../authority.ts");

enableResidents();

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const AGENT = "fixture";
const PKG = "live-fixture";

// 하나의 어댑터가 프롬프트로 갈린다 — 변종을 여러 벌 두면 같은 봉투 계약을 여러 곳에 베끼게 된다.
//  · "박동만"  — 박동만 뛰고 진짜 이벤트는 영영 없다(고착 재현). cancel 이 오면 내려간다
//  · "느린일"  — 도구 하나가 오래 물고, 그 사이 박동이 뛴다. 끝에 정상 종결
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  'if [ "${1:-}" = "info" ]; then',
  `  printf '%s\\n' '{"name":"live-fixture","provider":"none","protocol":3,"verbs":["session","serve","info","setup","models","commands"],"capabilities":["cancel"]}'`,
  "  exit 0",
  "fi",
  `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["m"]'; exit 0; fi`,
  `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
  'if [ "${1:-}" = "setup" ]; then exit 0; fi',
  "BEAT=0",
  "beat() { ( while true; do printf '%s\\n' '{\"event\":\"alive\",\"since\":400}'; sleep 0.4; done ) & BEAT=$!; }",
  "while IFS= read -r -t 30 line; do",
  '  case "$line" in',
  `    *'"type":"cancel"'*)`,
  '      if [ "$BEAT" != "0" ]; then kill "$BEAT" 2>/dev/null || true; fi',
  `      printf '%s\\n' '{"event":"error","message":"취소됨"}'`,
  "      exit 130",
  "      ;;",
  // 박동만 — 진짜 이벤트는 하나도 내지 않는다. 워치독이 울지 않으면 이 턴은 영원히 안 끝난다
  `    *'박동만'*)`,
  "      beat",
  "      ;;",
  // 느린 일 — 도구가 물려 있는 동안 박동이 뛰고, 마지막에 정상 종결
  `    *'느린일'*)`,
  // 기판이 박동을 요청했는지 증언한다 — cwd 는 워크스페이스다
  `      printf '%s' "\${RELAY_HEARTBEAT_S:-없음}" > heartbeat-env`,
  "      beat",
  `      printf '%s\\n' '{"event":"tool","status":"start","id":"t1","name":"Bash","detail":"오래 걸리는 일"}'`,
  "      sleep 1.2",
  '      if [ "$BEAT" != "0" ]; then kill "$BEAT" 2>/dev/null || true; BEAT=0; fi',
  `      printf '%s\\n' '{"event":"tool","status":"end","id":"t1","name":"Bash","ok":true,"result":"끝"}'`,
  `      printf '%s\\n' '{"event":"reply","text":"다 했습니다"}'`,
  "      ;;",
  "  esac",
  "done",
  "exit 0",
].join("\n") + "\n";

const PKG_DIR = mk(path.join(ROOT, PKG));
mk(path.join(PKG_DIR, "agents", AGENT));
fs.writeFileSync(path.join(PKG_DIR, "agents", AGENT, "AGENT.md"), "픽스처.\n");
mk(path.join(PKG_DIR, "harness", "only"));
fs.writeFileSync(path.join(PKG_DIR, "harness", "only", "run"), ADAPTER, { mode: 0o755 });
fs.writeFileSync(path.join(PKG_DIR, "relay.yaml"), [
  "schema: relay/v1",
  `name: "@local/${PKG}"`,
  "version: 0.1.0",
  `display_name: "${PKG}"`,
  'description: "생존 축 검증용"',
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

const ledger: Ledger = {
  secret: "live-secret",
  packages: { [PKG]: { path: PKG_DIR, workspace: mk(path.join(ROOT, "ws")) } },
  grants: [],
};
const io = localSessionIO(() => ledger);
const authority = localAuthority(() => ledger);
const wireIO = localClientWireIO(() => ledger);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 시한을 건다 — 회귀하면 이 시험은 실패가 아니라 **영영 안 끝남**으로 나타난다(박동을 활동으로
// 접으면 워치독이 울지 않아 턴이 안 닫힌다). 매달린 시험은 CI 에서 원인이 안 읽힌다
test("박동은 활동이 아니다 — 박동만 뛰는 턴은 스톨 워치독이 끊는다", { timeout: 15_000 }, async () => {
  const slot = "beat-only";
  // 박동을 활동으로 접으면 이 await 는 영영 돌아오지 않는다(그래서 시험이 성립한다).
  // 워치독 판정선 2초 + 취소 왕복만큼만 기다린다
  await assert.rejects(
    runSession({ ledger, pkg: PKG, authority, io, prompt: "박동만 해라", slot }),
    (e: Error) => {
      assert.match(e.message, /취소|하네스/);
      return true;
    },
    "박동이 뛰는 동안 워치독이 울지 않았다 — 고착이 영원히 건강해 보인다",
  );
  retireResidents(PKG);
});

test("박동은 장부에 안 남고, 진짜 이벤트만 남는다", async () => {
  const slot = "slow-work";
  const r = await runSession({ ledger, pkg: PKG, authority, io, prompt: "느린일 해라", slot });
  assert.equal(r.reply, "다 했습니다");

  const dir = path.join(io.sessionDir(PKG, slot), "turns");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length > 0, "턴 장부가 없다");
  const evs = files.flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).event));
  assert.ok(!evs.includes("alive"), "박동이 장부에 남았다: " + JSON.stringify(evs));
  assert.ok(evs.includes("tool") && evs.includes("reply"), JSON.stringify(evs));
  retireResidents(PKG);
});

test("목록 행이 생존을 싣는다 — 도는 동안 busy·lastEvent, 끝나면 사라진다", async () => {
  const slot = "listed";
  const running = runSession({ ledger, pkg: PKG, authority, io, prompt: "느린일 해라", slot });

  // 도구가 물려 있는 창 — 이때 목록이 "돌고 있음"을 말해야 한다
  await sleep(600);
  const live = sessionLiveness(PKG, slot);
  assert.ok(live?.busy, "도는 중인데 sessionLiveness 가 busy 가 아니다");
  const rowLive = (await wireIO.listSessions(PKG)).find((s) => s.session === slot);
  assert.ok(rowLive, "목록에 행이 없다");
  assert.equal(rowLive.busy, true, "목록 행에 busy 가 없다 — 화면이 진행을 말할 근거가 없다");
  assert.ok(typeof rowLive.lastEvent === "number" && rowLive.lastEvent > 0, "lastEvent 가 없다");
  // 박동 축은 활동보다 뒤처지지 않는다 — 도구가 무는 동안에도 봉투는 살아 있다고 말한다
  assert.ok(typeof rowLive.lastAlive === "number" && rowLive.lastAlive >= rowLive.lastEvent, "lastAlive 가 활동보다 이르다");

  assert.equal((await running).reply, "다 했습니다");

  const rowDone = (await wireIO.listSessions(PKG)).find((s) => s.session === slot);
  assert.ok(rowDone, "끝난 뒤 행이 사라졌다");
  assert.equal(rowDone.busy, undefined, "끝났는데 busy 가 남았다 — 죽은 위임이 영원히 도는 것처럼 보인다");
  retireResidents(PKG);
});

test("기판이 박동을 요청한다 — 선언 없이 뛰는 어댑터는 옛 기판의 워치독을 죽인다", () => {
  // 게이트가 사라지면 새 어댑터 + 옛 기판 조합에서 스톨 워치독이 조용히 죽는다. 어댑터 사본은
  // 패키지마다 따로 살고 기판과 따로 갱신되므로(openDraft 는 1회만 심는다) 그 조합은 일상이다
  const seen = fs.readFileSync(path.join(ROOT, "ws", "heartbeat-env"), "utf8");
  assert.notEqual(seen, "없음", "기판이 RELAY_HEARTBEAT_S 를 안 넘겼다 — 어댑터는 영영 안 뛴다");
  assert.ok(Number(seen) > 0, `박동 주기가 양수가 아니다: ${seen}`);
});

test("부모 대화 축은 목록에 그대로 나온다 — 위임이 어디로 보고하는지", async () => {
  // 위임(agent_dispatch)이 세션 폴더에 적는 그 파일이다(runtime/tools.ts). 여기서 재는 것은
  // 읽는 쪽 — 적힌 값이 계약 축으로 나가는가
  const slot = "sub-child";
  fs.writeFileSync(path.join(io.sessionDir(PKG, slot), "parent"), "s-parent-1");
  const row = (await wireIO.listSessions(PKG)).find((s) => s.session === slot);
  assert.ok(row, "행이 없다");
  assert.equal(row.parent, "s-parent-1");

  // 사람이 연 대화에는 없다 — 없음이 정상이다
  const plain = (await wireIO.listSessions(PKG)).find((s) => s.session === "slow-work");
  assert.equal(plain?.parent, undefined);
});
