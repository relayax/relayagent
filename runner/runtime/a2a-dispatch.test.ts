// a2a 위임의 시한과 배달 — 도구가 MCP 시한(claude-code 어댑터 240s)에 잘리기 전에 물러나고,
// 완주한 답이 발신 대화에 앉는가. 이 사다리가 없으면 오래 걸리는 미션의 답은 수신 세션
// 이력에만 남고 발신 세션은 "timed out" 만 본다 — 서브에이전트 위임이 2026-08-20 에 겪은
// 실사고의 쌍둥이다. 슬롯 열쇠도 함께 지킨다: 미션만 열쇠면 모든 소비자가 한 대화에 앉는다.
//
//   node --experimental-strip-types --test runner/runtime/a2a-dispatch.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type http from "node:http";
import type { Ledger } from "../supply/ledger.ts";
import type { HostBridge } from "./scripts.ts";

// 좌표는 모듈 적재 시점에 각인된다 — 들여오기 **전에** 임시 자리로 돌린다(진짜 홈에 쓰지 않는다)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-a2a-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4748";
// 시한 경주를 시험 시간 안으로 접는다 — 축은 "물러나는가"이지 180초가 아니다
process.env.RELAY_DISPATCH_TIMEOUT_S = "1";

const { handleMcp } = await import("./tools.ts");
const { a2aMissionSlot, SLOT_RE } = await import("../protocol.ts");
const { localAuthority } = await import("../authority.ts");
const { saveLedger } = await import("../supply/ledger.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const MISSION = "product-context";
const AGENT = "front";
const PROBE = path.join(ROOT, "delivered.txt");
process.env.A2A_PROBE = PROBE;

// 발신 패키지의 하네스 — 받은 프롬프트를 파일로 흘리는 가짜 어댑터. 배달 턴이 실제로 돌아야
// "배달됐다"가 증명된다(도구 설치 없이 번들 조립·스폰·장부 전 구간이 돈다)
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  "if [ \"${1:-}\" = \"info\" ]; then",
  "  printf '%s\\n' '{\"name\":\"fake\",\"provider\":\"none\",\"protocol\":3,\"verbs\":[\"session\",\"info\"],\"capabilities\":[]}'",
  "  exit 0",
  "fi",
  "printf '%s\\n===\\n' \"${2:-}\" >> \"$A2A_PROBE\"",
  "printf '%s\\n' '{\"event\":\"reply\",\"text\":\"배달 받음\"}'",
].join("\n") + "\n";

// ── 발신(consumer) 픽스처 — 에이전트 하나와 하네스 하나 ──
const CONS_DIR = mk(path.join(ROOT, "cons"));
mk(path.join(CONS_DIR, "agents", AGENT));
fs.writeFileSync(path.join(CONS_DIR, "agents", AGENT, "AGENT.md"), "위임을 보내는 픽스처.\n");
mk(path.join(CONS_DIR, "harness", "fake"));
fs.writeFileSync(path.join(CONS_DIR, "harness", "fake", "run"), ADAPTER, { mode: 0o755 });
fs.writeFileSync(path.join(CONS_DIR, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/cons"',
  "version: 0.1.0",
  'display_name: "위임 발신 픽스처"',
  'description: "a2a 시한·배달 검증용"',
  "harness:",
  "  variants:",
  "    - name: fake",
  "      source: harness/fake",
  "      entry: run",
  "agents:",
  `  - name: ${AGENT}`,
  "    default: true",
  `    persona: agents/${AGENT}/AGENT.md`,
  '    greeting: "픽스처 인사말"',
  "",
].join("\n"));

// ── 수신(provider) 픽스처 — 미션 선언 + 하네스 한 벌.
// 시한·배달 시험은 브리지 스텁으로 돌지만(수신 세션 자리를 가짜로 세운다), 부모 좌표가
// 실제로 앉는지는 **진짜 브리지**로 재야 한다: 그 자리가 비어 있던 것이 이 축의 버그였다 ──
const PROV_DIR = mk(path.join(ROOT, "prov"));
mk(path.join(PROV_DIR, "agents", "recv"));
fs.writeFileSync(path.join(PROV_DIR, "agents", "recv", "AGENT.md"), "미션을 받는 픽스처.\n");
mk(path.join(PROV_DIR, "harness", "fake"));
fs.writeFileSync(path.join(PROV_DIR, "harness", "fake", "run"), [
  "#!/bin/bash",
  "set -eu",
  "if [ \"${1:-}\" = \"info\" ]; then",
  "  printf '%s\\n' '{\"name\":\"fake\",\"provider\":\"none\",\"protocol\":3,\"verbs\":[\"session\",\"info\"],\"capabilities\":[]}'",
  "  exit 0",
  "fi",
  "printf '%s\\n' '{\"event\":\"reply\",\"text\":\"미션 답\"}'",
].join("\n") + "\n", { mode: 0o755 });
fs.writeFileSync(path.join(PROV_DIR, "relay.yaml"), [
  "schema: relay/v1",
  'name: "@t/prov"',
  "version: 0.1.0",
  'display_name: "미션 수신 픽스처"',
  'description: "a2a 시한·배달 검증용"',
  "harness:",
  "  variants:",
  "    - name: fake",
  "      source: harness/fake",
  "      entry: run",
  "agents:",
  "  - name: recv",
  "    default: true",
  "    persona: agents/recv/AGENT.md",
  "missions:",
  `  - name: ${MISSION}`,
  '    description: "제품 맥락 질의"',
  "",
].join("\n"));

const ledger: Ledger = {
  secret: "a2a-fixture-secret",
  packages: {
    cons: { path: CONS_DIR, workspace: mk(path.join(ROOT, "ws-cons")) },
    prov: { path: PROV_DIR, workspace: mk(path.join(ROOT, "ws-prov")) },
  },
  grants: [{ consumer: "cons", provider: "prov", mission: MISSION }],
};
// 배달 사다리는 파일 장부를 다시 읽는다 — 한 시간 뒤에 앉을 수 있는 턴이라 스냅샷을 믿지 않는다
saveLedger(ledger);
const authority = localAuthority(() => ledger);

/** 브리지 스텁 — 수신 세션 자리. 받은 인자를 남겨 열쇠의 재료가 그대로 가는지 본다 */
function bridge(reply: () => Promise<string>): { host: HostBridge; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const host = {
    dispatch: (provider: string, mission: string, payload: string, consumer?: string, consumerSlot?: string | null) => {
      seen.push({ provider, mission, payload, consumer, consumerSlot });
      return reply();
    },
  } as unknown as HostBridge;
  return { host, seen };
}

/** 도구 문을 한 번 두드린다 — 응답 봉투의 result 를 돌려준다 */
async function callTool(host: HostBridge, callerSlot: string | null): Promise<{ content: { text: string }[]; isError?: boolean }> {
  let payload = "";
  const res = {
    writeHead: () => res,
    end: (s?: string) => void (payload = s ?? ""),
  } as unknown as http.ServerResponse;
  await handleMcp(ledger, authority, host, "cons", AGENT, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: `a2a__prov__${MISSION}`, arguments: { payload: "본문" } },
  }, res, callerSlot);
  return JSON.parse(payload).result;
}

const delivered = (): string => {
  try {
    return fs.readFileSync(PROBE, "utf8");
  } catch {
    return "";
  }
};

async function until(pred: () => boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("기다린 일이 오지 않았다");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("시한 안에 끝난 위임은 그 자리에서 답이 된다 — 사다리는 늦은 위임에만 선다", async () => {
  const { host, seen } = bridge(async () => "미션이 답한 본문");
  const r = await callTool(host, "agent-front");
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "미션이 답한 본문");
  // 열쇠의 재료(발신 패키지·미션)가 브리지에 그대로 간다 — 양쪽이 같은 슬롯을 계산하는 근거.
  // 발신 **슬롯**도 함께 간다: 수신 세션이 부모 좌표(§5.3-26)를 적는 근거이고, 아래 배달
  // 사다리가 📬 를 보낼 주소와 같은 값이어야 한다 — 갈리면 화면이 말한 자리와 답이 앉는
  // 자리가 달라진다
  assert.deepEqual(seen, [{ provider: "prov", mission: MISSION, payload: "본문", consumer: "cons", consumerSlot: "agent-front" }]);
  assert.equal(delivered(), "", "제때 온 답을 배달까지 하면 같은 말이 두 번 앉는다");
});

test("시한을 넘긴 위임은 도구가 물러나고, 완주한 답이 발신 대화로 배달된다", async () => {
  const { host } = bridge(() => new Promise((r) => setTimeout(() => r("늦게 도착한 미션의 답"), 1_400)));
  const r = await callTool(host, "agent-front");
  assert.match(r.content[0].text, /위임이 1초 안에 끝나지 않았습니다/);
  assert.match(r.content[0].text, /📬 배달됩니다/);
  assert.equal(delivered(), "", "물러난 시점에는 아직 배달할 답이 없다");

  await until(() => delivered().includes("📬"));
  assert.match(delivered(), /📬 위임 완료 — prov · product-context\(완료\)/);
  assert.match(delivered(), /늦게 도착한 미션의 답/);
});

test("실패도 배달된다 — 물러난 도구가 마지막 말이면 발신 세션은 끝났는지도 모른다", async () => {
  fs.rmSync(PROBE, { force: true });
  const { host } = bridge(() => new Promise((_r, rej) => setTimeout(() => rej(new Error("수신 세션이 죽었다")), 1_400)));
  const r = await callTool(host, "agent-front");
  assert.match(r.content[0].text, /위임이 1초 안에 끝나지 않았습니다/);

  await until(() => delivered().includes("📬"));
  assert.match(delivered(), /📬 위임 완료 — prov · product-context\(실패\)/);
  assert.match(delivered(), /수신 세션이 죽었다/);
});

test("발신 슬롯 미상(구 번들)이면 배달하지 않는다 — 없는 주소로 턴을 열지 않는다", async () => {
  fs.rmSync(PROBE, { force: true });
  const { host, seen } = bridge(() => new Promise((r) => setTimeout(() => r("주소 없는 답"), 1_400)));
  const r = await callTool(host, null);
  // 부모 좌표도 함께 미상이다 — 없는 주소를 부모라고 적으면 남의 대화가 이 일을 자기 것으로 센다
  assert.equal(seen[0].consumerSlot, null);
  assert.match(r.content[0].text, /위임이 1초 안에 끝나지 않았습니다/);
  await new Promise((r2) => setTimeout(r2, 2_000));
  assert.equal(delivered(), "");
});

test("위임 슬롯의 열쇠는 (발신 패키지, 미션) — 소비자가 다르면 대화가 갈린다", () => {
  assert.notEqual(a2aMissionSlot(MISSION, "cons"), a2aMissionSlot(MISSION, "other"));
  assert.equal(a2aMissionSlot(MISSION, "cons"), a2aMissionSlot(MISSION, "cons"), "같은 소비자의 재위임은 같은 대화를 잇는다");
  assert.equal(a2aMissionSlot(MISSION, null), a2aMissionSlot(MISSION, undefined), "consumer 미상은 한 자리를 함께 쓴다");
  for (const s of [
    a2aMissionSlot(MISSION, "cons"),
    a2aMissionSlot(MISSION, null),
    a2aMissionSlot("긴 미션 이름/슬래시 포함", "@t/cons"),
    a2aMissionSlot("m".repeat(90), "c".repeat(90)),
  ]) {
    assert.match(s, SLOT_RE, `세션 id 문법 밖 슬롯: ${s}`);
  }
});

test("미션 세션에 부모 좌표가 앉는다 — 남의 앱에서 도는 일을 발신 대화가 자기 것으로 셀 근거", async () => {
  // 여기서만 진짜 브리지를 쓴다. 종전에는 이 자리가 label 만 적고 지나가서, 미션으로 일하는
  // 앱의 현황 줄이 켜질 데이터가 아예 없었다(실측 2026-08-30 — 미션 둘이 도는데 화면은 조용).
  const { makeHostBridge } = await import("../daemon.ts");
  const host = makeHostBridge(() => ledger, () => null, authority);
  const slotDir = path.join(process.env.RELAY_HOME as string, "sessions", "prov", a2aMissionSlot(MISSION, "cons"));

  assert.equal(await host.dispatch("prov", MISSION, "본문", "cons", "s-caller-1"), "미션 답");
  assert.equal(fs.readFileSync(path.join(slotDir, "parent"), "utf8"), "s-caller-1");
  // 인스턴스 축이 없으면 이 슬롯은 **자기 패키지 안의** s-caller-1 을 가리키는 것으로 읽힌다 —
  // 그런 대화는 없으므로 줄이 영영 안 선다. 부모가 남의 집에 산다는 것이 이 형의 전부다
  assert.equal(fs.readFileSync(path.join(slotDir, "parent-instance"), "utf8"), "cons");

  // 발신 슬롯 미상(동사의 ctx.dispatch)이면 낡은 부모를 지운다 — 미션 슬롯은 재사용되므로
  // 남겨 두면 앞선 대화가 시키지도 않은 일을 자기 현황 줄에 세운다
  assert.equal(await host.dispatch("prov", MISSION, "본문", "cons"), "미션 답");
  assert.equal(fs.existsSync(path.join(slotDir, "parent")), false, "낡은 부모가 남았다");
  assert.equal(fs.existsSync(path.join(slotDir, "parent-instance")), false);
});
