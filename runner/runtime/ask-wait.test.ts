// 대기 중 질문은 고착이 아니다 — 스톨 워치독이 사람을 기다리는 턴을 죽이지 않는가.
//
// 이 시험이 필요한 이유(2026-08-26): 어댑터의 10분 자동 기본값을 걷어내 질문이 답을 무기한
// 기다리게 했는데, 그것만으로는 반쪽이다. 기판에는 별도의 시계가 돈다 — 무이벤트가
// RELAY_TURN_STALL_S 를 넘으면 cancel 을 넣는다. 두 시계가 싸우면 늘 긴 쪽이 틀린 방향으로
// 이긴다: 사람이 오래 고민하면 기판이 그 질문을 취소해 버린다. 그래서 ask 가 지나가면 시계를
// 멈추고, 답이 돌아가면 다시 돌린다.
//
// 시험이 셋인 이유: 면제만 재면 **워치독이 통째로 죽어도 통과한다**. 그래서 먼저 워치독이
// 판정선에서 실제로 우는 것을 보이고(①), 그 다음 질문 앞에서 침묵하는 것을(②), 마지막으로
// 답이 돌아간 뒤 같은 턴에서 다시 우는 것을(③) 잰다.
//
// 실제 자식 프로세스로 증명한다 — 명부는 프로세스 지역이고 stdin 은 진짜 파이프여야 한다.
//
//   node --experimental-strip-types --test runner/runtime/ask-wait.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ask-wait-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4751";
// 판정선을 1초로 당긴다 — 검사 주기가 이 값을 따라가야(STALL_TICK_MS) 실제로 울 수 있다.
// 60초 고정이던 시절에는 이 설정이 아무 일도 하지 않아 워치독을 시험할 방법 자체가 없었다.
process.env.RELAY_TURN_STALL_S = "1";

const { runSession, deliverAnswer, localSessionIO } = await import("./harness.ts");
const { localAuthority } = await import("../authority.ts");

const AGENT = "fixture";
/** 워치독이 울었다는 어댑터의 증언 — cancel 을 받은 자리에서만 나온다 */
const BARKED = "워치독이 울었다";

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 프롬프트가 모드다. 어느 모드든 cancel 을 받으면 그 사실을 봉투에 적으므로, 워치독이 울었는지
// 안 울었는지가 턴의 결과로 그대로 드러난다.
//   silent — 아무 이벤트도 없이 침묵(질문 없음). 판정선에서 취소되어야 한다.
//   ask    — 질문을 내고 대기. 답을 받으면 tool end 만 내고 **다시 침묵**한다: 그 뒤로는
//            면제가 풀려 취소되어야 한다(면제가 턴 전체로 번지지 않는다는 증거).
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  'if [ "${1:-}" = "info" ]; then',
  `  printf '%s\\n' '{"name":"ask-fixture","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":["ask","cancel"]}'`,
  "  exit 0",
  "fi",
  `if [ "\${1:-}" = "models" ]; then printf '%s\\n' '["m"]'; exit 0; fi`,
  `if [ "\${1:-}" = "commands" ]; then printf '%s\\n' '[]'; exit 0; fi`,
  'if [ "${1:-}" = "setup" ]; then exit 0; fi',
  'if [ "${2:-}" = "ask" ]; then',
  `  printf '%s\\n' '{"event":"tool","status":"start","id":"toolu_x","name":"AskUserQuestion"}'`,
  `  printf '%s\\n' '{"event":"ask","id":"req-1","tool":"toolu_x","questions":[{"question":"기다릴까요?"}]}'`,
  "fi",
  // 이 줄부터 어댑터는 아무것도 내지 않는다 — 워치독에게는 완전한 무이벤트 구간이다
  "while IFS= read -r -t 30 line; do",
  '  case "$line" in',
  `    *'"type":"cancel"'*) printf '%s\\n' '{"event":"error","message":"${BARKED}"}'; exit 130;;`,
  `    *'"type":"answer"'*) printf '%s\\n' '{"event":"tool","status":"end","id":"toolu_x","name":"AskUserQuestion","ok":true,"result":"answered"}';;`,
  "  esac",
  "done",
  `printf '%s\\n' '{"event":"error","message":"제어줄이 오지 않았다"}'`,
  "exit 1",
].join("\n") + "\n";

const PKG = "ask-fixture";
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
  'description: "대기 중 질문의 스톨 면제 검증용"',
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
  secret: "ask-wait-secret",
  packages: { [PKG]: { path: PKG_DIR, workspace: mk(path.join(ROOT, "ws")) } },
  grants: [],
};
const io = localSessionIO(() => ledger);
const authority = localAuthority(() => ledger);
const turnOf = (slot: string, prompt: string) => runSession({ ledger, pkg: PKG, authority, io, prompt, slot });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("① 워치독은 판정선에서 운다 — 질문 없이 침묵하는 턴은 취소된다", async () => {
  // 이 시험이 없으면 아래 둘이 "워치독이 아예 죽었다" 로도 통과한다
  await assert.rejects(turnOf("silent-1", "silent"), new RegExp(BARKED));
});

test("② 질문이 서 있으면 판정선의 몇 배를 기다려도 취소되지 않는다", async () => {
  const turn = turnOf("ask-1", "ask");
  await sleep(5_000); // 판정선(1초)의 5배
  // 살아 있다는 증거 — 진행 명부에 자식이 서 있어야 회송이 성립한다
  assert.equal(deliverAnswer(PKG, "ask-1", "req-1", [{ question: "기다릴까요?", selected: ["네"] }]), true);
  await turn.catch(() => null);
});

test("③ 답이 돌아가면 시계가 다시 돈다 — 면제가 턴 전체로 번지지 않는다", async () => {
  const turn = turnOf("ask-2", "ask");
  await sleep(1_500);
  assert.equal(deliverAnswer(PKG, "ask-2", "req-1", [{ question: "기다릴까요?", selected: ["네"] }]), true);
  // 어댑터는 tool end 만 내고 다시 침묵한다. 면제가 여기서 안 풀리면 이 턴은 남은 수명 내내
  // 워치독 밖이고, 그러면 진짜 고착이 영영 안 풀린다 — 이 단언이 그 자리를 지킨다.
  await assert.rejects(turn, new RegExp(BARKED));
});
