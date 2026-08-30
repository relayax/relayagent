// liveness.test.mjs — 위임이 살아 있는지 화면이 말할 수 있는가.
//
// 두 가지를 못박는다.
//
// ① **위임 판정은 이름 문법으로.** 종전 판정은 `toolName === "agent_dispatch"` 였는데 봉투에
//    실려 오는 이름은 문을 통과한 `mcp__relay__agent_dispatch` 다. 그래서 그 비교는 한 번도
//    참이 된 적이 없고, 위임의 대화를 탭으로 여는 길이 통째로 죽은 코드였다 — 위임을 걸어도
//    화면에는 아무 일도 일어나지 않았다(2026-08-29 실측: 실제 전사 기록의 도구 이름).
//
// ② **침묵에는 두 가지 뜻이 있다.** 도구 하나가 오래 무는 침묵과 고착의 침묵은 다르다.
//    한 상태로 접으면 30분째 도는 위임과 6분째 멈춘 위임이 똑같이 생긴다 — 그것이 사용자가
//    화면을 믿지 못한 이유였다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const { isDispatchTool, livenessOf, livenessLabel, isDelegationOf } = await loadModule("runtime.ts");

test("위임 판정은 문을 통과한 이름에도 걸린다 — 이것이 죽어 있던 그 비교다", () => {
  // 실제 봉투에 실려 오는 형태(문 이름 relay). 여기서 false 면 자동 탭 열기가 다시 죽는다
  assert.equal(isDispatchTool("mcp__relay__agent_dispatch"), true);
  // 문 이름은 어댑터 사정이라 못 박지 않는다
  assert.equal(isDispatchTool("mcp__substrate__agent_dispatch"), true);
  // 접두 없는 형태(기판이 직접 세우는 경우)도 그대로
  assert.equal(isDispatchTool("agent_dispatch"), true);
});

test("위임이 아닌 도구는 걸리지 않는다 — 부분일치로 번지면 엉뚱한 카드가 대화를 연다", () => {
  assert.equal(isDispatchTool("Bash"), false);
  assert.equal(isDispatchTool("mcp__relay__agent_list"), false);
  assert.equal(isDispatchTool("agent_dispatch_v2"), false);
  // 위임 문법이 아닌 접두는 받지 않는다 — a2a 위임은 자기 카드가 따로 있다
  assert.equal(isDispatchTool("a2a__peer__agent_dispatch"), false);
  assert.equal(isDispatchTool(""), false);
});

test("안 도는 대화는 idle — 축이 통째로 없어도 미상이 아니라 '안 돎'이다", () => {
  assert.equal(livenessOf({}).state, "idle");
  assert.equal(livenessOf({ busy: false, lastEvent: 1 }).state, "idle");
  assert.equal(livenessLabel(livenessOf({})), "");
});

test("침묵의 두 뜻을 가른다 — 오래 걸리는 중과 멈춤", () => {
  const now = 1_000_000_000;
  // 방금 무언가 했다
  assert.equal(livenessOf({ busy: true, lastEvent: now - 3_000, lastAlive: now - 1_000 }, now).state, "running");
  // 활동은 3분째 끊겼는데 박동은 방금 — 도구 하나가 오래 무는 중이다
  const slow = livenessOf({ busy: true, lastEvent: now - 180_000, lastAlive: now - 2_000 }, now);
  assert.equal(slow.state, "slow");
  assert.equal(livenessLabel(slow), "3분째 한 작업");
  // 박동조차 끊겼다 — 고착 의심
  assert.equal(livenessOf({ busy: true, lastEvent: now - 180_000, lastAlive: now - 180_000 }, now).state, "stalled");
});

test("박동 축이 없는 기판은 고착으로 몰지 않는다 — 없는 신호는 증거가 아니다", () => {
  const now = 1_000_000_000;
  // 구 어댑터: lastAlive 가 아예 없다. 이때 stalled 로 떨어뜨리면 멀쩡한 세션이 전부 '응답 없음'이 된다
  assert.equal(livenessOf({ busy: true, lastEvent: now - 5_000 }, now).state, "running");
  assert.equal(livenessOf({ busy: true, lastEvent: now - 600_000 }, now).state, "slow");
});

test("서버 시계가 앞서도 음수 경과를 만들지 않는다", () => {
  const now = 1_000_000_000;
  const l = livenessOf({ busy: true, lastEvent: now + 5_000, lastAlive: now + 5_000 }, now);
  assert.equal(l.silentMs, 0);
  assert.equal(l.state, "running");
});

// ③ **위임은 인스턴스를 건널 수 있다.** a2a 미션의 대화는 수신 패키지 쪽에 서고 부모는 발신
//    패키지에 있다. 슬롯 하나로만 짝지으면 그 형은 영영 안 보인다 — 미션 둘이 30분을 도는데
//    현황 줄이 비어 있던 자리다(실측 2026-08-30).
const sub = { instance: "factory", origin: "dispatch", parent: "s-me", busy: true };
const mission = { instance: "scout", origin: "mission", parent: "s-me", parentInstance: "factory", busy: true };

test("같은 인스턴스 위임 — parentInstance 가 없으면 그 행이 온 인스턴스가 부모의 자리다", () => {
  assert.equal(isDelegationOf(sub, "factory", "s-me"), true);
  // 이 축이 생기기 전의 행(parentInstance 없음)이 그대로 읽혀야 한다 — additive 의 조건이다
  assert.equal(isDelegationOf(sub, "scout", "s-me"), false, "남의 인스턴스 대화가 내 줄에 섰다");
  assert.equal(isDelegationOf(sub, "factory", "s-other"), false);
});

test("남의 앱에서 도는 미션도 내 위임이다 — 좌표 둘로 짝짓는다", () => {
  assert.equal(isDelegationOf(mission, "factory", "s-me"), true);
  // 수신 패키지 쪽에서 보면 이것은 내 위임이 아니다 — 그 앱은 부탁을 받은 쪽이다
  assert.equal(isDelegationOf(mission, "scout", "s-me"), false);
});

test("사람이 연 대화는 아무의 위임도 아니다 — origin·parent 둘 다 있어야 한다", () => {
  assert.equal(isDelegationOf({ instance: "factory", parent: "s-me", busy: true }, "factory", "s-me"), false);
  assert.equal(isDelegationOf({ instance: "factory", origin: "mission", busy: true }, "factory", "s-me"), false);
});
