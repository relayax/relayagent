// ctx.test.mjs — mount API 의 컨텍스트/대화 슬롯 주입(getCtx overrides)과
// conversation 문자열 계약(routematch 슬롯과 동형) 테스트. DOM 없이 전역 스텁만 사용.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

// runtime.ts 는 호출 시점에만 window/document 를 읽는다 — 최소 스텁으로 충분.
// (모듈 최상단의 relay:scene 구독은 addEventListener 실재를 보고 건너뛴다.)
globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const R = await loadModule("runtime.ts");
const M = await loadModule("routematch.ts");

beforeEach(() => {
  globalThis.window = {};
  globalThis.document = { currentScript: null, querySelector: () => null };
});
afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});

test("getCtx(): 전역 __RELAY_CONTEXT 패스스루(기존 자동 마운트 경로 보존)", () => {
  globalThis.window.__RELAY_CONTEXT = {
    instanceId: "inst-9", principal: "emp-1", conversationId: "main", title: "T",
  };
  const ctx = R.getCtx();
  // 화면 축은 그대로 통과한다.
  assert.equal(ctx.instanceId, "inst-9");
  assert.equal(ctx.principal, "emp-1");
  assert.equal(ctx.conversationId, "main");
  assert.equal(ctx.title, "T");
  // 좌표 축(base/root)이 함께 선다 — 계약 §2-6 의 주입 규약. 미주입이면 빈 문자열이고
  // 그 상태에서 위젯은 마운트를 포기한다(마운트 문법 조립 금지, fail-loud).
  assert.equal(typeof ctx.base, "string");
  assert.equal(typeof ctx.root, "string");
});

test("getCtx(): conversation 미주입 — 로컬 발급하지 않는다(지연 민팅 §5.3-22)", () => {
  globalThis.window.__RELAY_CONTEXT = { instanceId: "inst-9" };
  const ctx = R.getCtx();
  // 구 계약은 여기서 "chat-<id>" 를 **클라이언트가 발급**했다. 계약 v1 에서 세션 id 는
  // 기판이 발급하는 불투명 문자열이라(§5.3-22) 첫 발화 직전 session.create 가 민팅한다.
  assert.notEqual(ctx.conversationId, "chat-inst-9");
  assert.equal(ctx.principal, "local");
});

test("mount overrides: conversation prop 이 conversationId 자리에 주입", () => {
  globalThis.window.__RELAY_CONTEXT = { instanceId: "inst-9", conversationId: "main" };
  const ctx = R.getCtx({ instanceId: "inst-x", conversationId: "agent-review:pr-7", title: "리뷰" });
  assert.equal(ctx.instanceId, "inst-x");           // 전역보다 mount 인자 우선
  assert.equal(ctx.conversationId, "agent-review:pr-7");
  assert.equal(ctx.title, "리뷰");
});

test("mount overrides: conversation 생략 시 대상 인스턴스를 따른다", () => {
  globalThis.window.__RELAY_CONTEXT = { instanceId: "inst-9" };
  const ctx = R.getCtx({ instanceId: "inst-42" });
  // 대상은 오버라이드를 따르되, 대화 좌표는 로컬 발급하지 않는다(위 지연 민팅과 같은 이유).
  assert.equal(ctx.instanceId, "inst-42");
  assert.notEqual(ctx.conversationId, "chat-inst-42");
});

test("conversation 문자열 계약: bridge slotFor 와 동형(main | agent-<name>:<param>)", () => {
  // 슬롯 조립은 bridge.tsx slotFor(AgentBinding 파생)가 유일 지점 — view-bridge §2-5.
  // mount({conversation: slot})이 그대로 대화 축이 된다(같은 문자열이 히스토리 되읽기 키).
  // routematch 는 문법 해석만 소유한다.
  const slot = "agent-review:pr-7";
  globalThis.window.__RELAY_CONTEXT = { instanceId: "inst-9" };
  assert.equal(R.getCtx({ conversationId: slot }).conversationId, "agent-review:pr-7");
  assert.deepEqual(M.displayBinding(slot), { agent: "review", param: "pr-7", sibling: false });
});

test("구 계약 소거: slotForRoute/matchPath(manifest route 매칭)는 더 이상 존재하지 않는다", () => {
  assert.equal(M.slotForRoute, undefined);
  assert.equal(M.matchPath, undefined);
  assert.equal(R.getRoutes, undefined);
  assert.equal(R.slotForRoute, undefined);
});
