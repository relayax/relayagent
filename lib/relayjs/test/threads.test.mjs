// threads.test.mjs — 다중세션 스레드 문법(routematch threadFamily/siblingThread/displayBinding)
// 계약 테스트. 핵심 불변식: sibling 의 `~` 는 반드시 첫 `:` 뒤(param 자리) — 서버
// parseAgentSlot(첫 `:` split)이 에이전트 이름을 그대로 해석해야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const M = await loadModule("routematch.ts");

// 서버 쌍둥이(기판 turn 서비스 parseAgentSlot)의 최소 미러 — sibling 이 에이전트 해석을
// 깨지 않는지 이 파일 안에서 교차검증한다.
function parseAgentSlot(conv) {
  if (!conv.startsWith("agent-")) return { agent: "", param: "" };
  const body = conv.slice("agent-".length);
  const i = body.indexOf(":");
  return i >= 0 ? { agent: body.slice(0, i), param: body.slice(i + 1) } : { agent: body, param: "" };
}

test("threadFamily(): main 패밀리 수렴 — main·chat-*·c-*", () => {
  assert.equal(M.threadFamily("main"), "main");
  assert.equal(M.threadFamily("chat-inst9"), "main");
  assert.equal(M.threadFamily("c-0a1b2c3d4e5f6a7b"), "main");
  assert.equal(M.threadFamily(""), "main");
});

test("threadFamily(): 도킹 sibling 은 seed 로 수렴 (유param·무param)", () => {
  assert.equal(M.threadFamily("agent-triage:42"), "agent-triage:42");
  assert.equal(M.threadFamily("agent-triage:42~ab12cd34"), "agent-triage:42");
  // 무param sibling(agent-x:~id)의 잔여 trailing ":" 정규화 — seed 와 같은 패밀리여야 목록이 묶인다.
  assert.equal(M.threadFamily("agent-triage:~ab12cd34"), "agent-triage");
  assert.equal(M.threadFamily("agent-triage"), "agent-triage");
});

test("siblingThread(): main 패밀리 = c-<id16>", () => {
  const s = M.siblingThread("main");
  assert.match(s, /^c-[0-9a-f]{16}$/);
  assert.equal(M.threadFamily(s), "main");
});

test("siblingThread(): 도킹 sibling 은 에이전트 해석을 깨지 않는다 (~ 는 param 자리)", () => {
  for (const seed of ["agent-triage:42", "agent-triage", "agent-triage:42~old12345"]) {
    const s = M.siblingThread(seed);
    const slot = parseAgentSlot(s);
    assert.equal(slot.agent, "triage", `${seed} → ${s}`);
    // sibling 은 seed 와 같은 패밀리(목록 한 묶음) + seed 자체와는 다른 스레드 문자열.
    assert.equal(M.threadFamily(s), M.threadFamily(seed));
    assert.notEqual(s, seed);
  }
});

test("displayBinding(): 헤더 표시 해석 — agent/param(seed)/sibling 여부", () => {
  assert.deepEqual(M.displayBinding("main"), { agent: "", param: "", sibling: false });
  assert.deepEqual(M.displayBinding("c-0a1b2c3d4e5f6a7b"), { agent: "", param: "", sibling: true });
  assert.deepEqual(M.displayBinding("agent-triage:42"), { agent: "triage", param: "42", sibling: false });
  assert.deepEqual(M.displayBinding("agent-triage:42~ab12cd34"), { agent: "triage", param: "42", sibling: true });
  assert.deepEqual(M.displayBinding("agent-triage:~ab12cd34"), { agent: "triage", param: "", sibling: true });
});
