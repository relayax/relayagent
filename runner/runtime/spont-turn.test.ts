// 주입 없이 열린 턴이 화면에 닿는가 — 자발 턴의 개설·장부·종결.
//
// 이 시험이 필요한 이유(2026-08-27 실사고): 얹기가 남은 샘플링 경계 없이 도착하면 CLI 는 현재
// 턴을 닫고 **그 말로 새 턴을 연다**. 그 턴은 실제로 돌아 파일을 읽고 답까지 냈는데, 어댑터의
// 자발 턴 게이트가 백그라운드 작업만 통과시켜 통째로 버려졌다. 사용자에게는 "답장이 안 온다"
// 였고, 기계는 눈에 보이게 일하고 있었다.
//
// 어댑터 반쪽(게이트)은 그쪽 파일의 일이고, 여기서 재는 것은 **기판 반쪽**이다:
//  1. 자발 턴이 자기 turn id 로 관찰 창에 선다 — 없으면 붙을 좌표가 없어 실황이 버려진다.
//  2. 자기 장부를 갖는다 — 직전 턴 장부에 이어 적으면 그 턴의 재생이 settled 뒤 줄을 다시
//     내놓는다(client-protocol §6-36 위반).
//  3. reply 로 닫힌다 — 안 닫으면 그 슬롯이 영구 busy 다.
//
//   node --experimental-strip-types --test runner/runtime/spont-turn.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-spont-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4753";

const { runSession, enableResidents, localSessionIO, setTurnTap, retireResidents } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");

enableResidents(); // 자발 턴은 상주 전용이다 — 1회 세션은 정산 즉시 내려간다

/** 방청 기록 — 데몬이 wire 의 adoptSessionTurn/releaseSessionTurn 을 꽂는 자리 */
const opened: { id: string; file: string }[] = [];
const closed: { id: string; ok: boolean }[] = [];
setTurnTap({
  open: (_pkg, _slot, turn) => { opened.push({ ...turn }); },
  close: (_pkg, _slot, turnId, outcome) => { closed.push({ id: turnId, ok: outcome.ok }); },
});

const AGENT = "fixture";
function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 주입된 턴을 정산한 **뒤**, 아무도 시키지 않은 턴을 하나 더 낸다 — 미뤄진 얹기의 답이 실제로
// 도착하는 모양 그대로다(어댑터의 openSpont 경로).
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  'if [ "${1:-}" = "info" ]; then',
  `  printf '%s\\n' '{"name":"spont-fixture","provider":"none","protocol":3,"verbs":["session","serve","info","setup","models","commands"],"capabilities":["steer","cancel"]}'`,
  "  exit 0",
  "fi",
  `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["m"]'; exit 0; fi`,
  `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
  'if [ "${1:-}" = "setup" ]; then exit 0; fi',
  // serve — 주입을 기다렸다가 정산하고, 이어서 자발 턴을 낸다
  "while IFS= read -r -t 30 line; do",
  '  case "$line" in',
  `    *'"type":"turn"'*)`,
  `      printf '%s\\n' '{"event":"delta","text":"주입된 답"}'`,
  `      printf '%s\\n' '{"event":"reply","text":"주입된 답"}'`,
  // 여기부터는 주입이 없다. 기판이 이 턴을 열어 주지 않으면 아래 전부가 버려진다
  `      printf '%s\\n' '{"event":"delta","text":"미뤄진 얹기의 답"}'`,
  `      printf '%s\\n' '{"event":"tool","status":"start","id":"t1","name":"Read"}'`,
  `      printf '%s\\n' '{"event":"tool","status":"end","id":"t1","name":"Read","ok":true,"result":"본문"}'`,
  `      printf '%s\\n' '{"event":"reply","text":"미뤄진 얹기의 답","origin":"task"}'`,
  "      ;;",
  "  esac",
  "done",
  "exit 0",
].join("\n") + "\n";

const PKG = "spont-fixture";
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
  'description: "자발 턴 개설 검증용"',
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
  secret: "spont-secret",
  packages: { [PKG]: { path: PKG_DIR, workspace: mk(path.join(ROOT, "ws")) } },
  grants: [],
};
const io = localSessionIO(() => ledger);
const authority = localAuthority(() => ledger);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("주입 없이 열린 턴이 자기 좌표·자기 장부로 서고, reply 로 닫힌다", async () => {
  const slot = "spont-1";
  const r = await runSession({ ledger, pkg: PKG, authority, io, prompt: "물어봐", slot });
  assert.equal(r.reply, "주입된 답");
  await sleep(1_500); // 자발 턴이 흘러들 창

  // ① 관찰 창에 섰다 — 이 개설이 없으면 화면이 붙을 turn id 가 없어 실황이 통째로 버려진다.
  //    개설은 **내용으로** 가른다: 자발 턴은 주입 턴보다 먼저 반환될 수도 있어(어댑터가 정산
  //    직후 이어서 낸다) 개수 증가로 세면 순서에 기대게 된다.
  const spont = opened.find((t) => {
    try { return fs.readFileSync(t.file, "utf8").includes("미뤄진 얹기의 답"); } catch { return false; }
  });
  assert.ok(spont, "자발 턴이 개설되지 않았다: " + JSON.stringify(opened.map((t) => path.basename(t.file))));

  // ② 자기 장부다 — 직전 턴 장부에 이어 적으면 그 턴의 재생이 settled 뒤 줄을 내놓는다
  const lines = fs.readFileSync(spont.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const evs = lines.map((e) => e.event);
  assert.ok(evs.includes("delta") && evs.includes("tool") && evs.includes("reply"), JSON.stringify(evs));
  assert.equal(lines.find((e) => e.event === "reply").text, "미뤄진 얹기의 답");
  // 주입 턴의 장부에는 섞이지 않았다
  const dir = path.join(io.sessionDir(PKG, slot), "turns");
  const others = fs.readdirSync(dir).filter((f) => f !== path.basename(spont.file));
  for (const f of others) {
    assert.ok(!fs.readFileSync(path.join(dir, f), "utf8").includes("미뤄진 얹기의 답"), `${f} 에 섞였다`);
  }

  // ③ 닫혔다 — 안 닫으면 그 슬롯이 영구 busy 다.
  //    **id 로 찾는다**: 주입 턴의 종결과 이 턴의 종결은 서로 다른 경로가 내므로 도착 순서가
  //    고정이 아니다(CI 에서 뒤집혔다). 위치로 집으면 코드가 아니라 스케줄러를 재게 된다.
  assert.deepEqual(closed.filter((c) => c.id === spont.id), [{ id: spont.id, ok: true }]);

  // ④ 이력에도 앉는다 — 상주가 죽어도 그 답이 대화에 남는다
  const texts = io.readMessages(PKG, slot).map((m) => String(m.text));
  assert.ok(texts.includes("미뤄진 얹기의 답"), JSON.stringify(texts));

  retireResidents(PKG);
});
