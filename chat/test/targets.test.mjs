// targets.test.mjs — 작업 대상 목록(param 축) 계약. "agent-builder 가 task 와 calendar 를 한
// 대화에서" = `agent-builder:task,calendar`. param 은 서버에서 권한 축이 아니라 프롬프트 한 줄이라
// 서버·스키마 무변경으로 성립한다 — parseAgentSlot 은 첫 `:` 뒤 전부를 param 으로 가져간다.
// 쌍둥이 주의: 기판 쪽 페르소나 주입 문장도 쉼표로 편다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const M = await loadModule("routematch.ts");

// 서버 쌍둥이(기판 turn 서비스 parseAgentSlot)의 최소 미러 — 목록 param 이 에이전트 해석을
// 깨지 않는지 이 파일 안에서 교차검증한다.
function parseAgentSlot(conv) {
  if (!conv.startsWith("agent-")) return { agent: "", param: "" };
  const body = conv.slice("agent-".length);
  const i = body.indexOf(":");
  return i >= 0 ? { agent: body.slice(0, i), param: body.slice(i + 1) } : { agent: body, param: "" };
}

test("paramTargets(): slug 목록만 목록으로 해석", () => {
  assert.deepEqual(M.paramTargets("task,calendar"), ["task", "calendar"]);
  assert.deepEqual(M.paramTargets("task"), ["task"]);
  assert.deepEqual(M.paramTargets(""), []);
});

test("paramTargets(): 임의 스레드 키는 쉼표를 품어도 대상 하나 — 기존 param 계약 보존", () => {
  assert.deepEqual(M.paramTargets("ticket #42, urgent"), ["ticket #42, urgent"]);
  assert.deepEqual(M.paramTargets("A_B"), ["A_B"]);
});

// 슬롯 접두사 "agent-" 는 에이전트 **이름** 앞에 붙는다 — 이름이 "agent-builder" 면 슬롯은
// "agent-agent-builder:…"(기존 규약: 뷰의 <AgentScope agent="agent-builder">가 그 슬롯을 만든다).
test("withTargets(): 중복·빈 값을 접고, 목록이 비면 param 없는 seed", () => {
  assert.equal(M.withTargets("agent-builder", ["task", "calendar"]), "agent-agent-builder:task,calendar");
  assert.equal(M.withTargets("agent-builder", ["task", "task", ""]), "agent-agent-builder:task");
  assert.equal(M.withTargets("agent-builder", []), "agent-agent-builder");
  assert.equal(M.withTargets("triage", ["42"]), "agent-triage:42");
});

test("목록 슬롯이 서버 parseAgentSlot 을 그대로 통과한다(계약 무변경)", () => {
  const slot = M.withTargets("agent-builder", ["task", "calendar"]);
  assert.deepEqual(parseAgentSlot(slot), { agent: "agent-builder", param: "task,calendar" });
});

test("목록 슬롯도 패밀리·sibling 문법과 어울린다", () => {
  const slot = M.withTargets("agent-builder", ["task", "calendar"]);
  assert.equal(M.threadFamily(slot), slot);
  const sib = M.siblingThread(slot);
  assert.match(sib, /^agent-agent-builder:task,calendar~[0-9a-f]{8}$/);
  assert.equal(M.threadFamily(sib), slot);
  // sibling 이어도 에이전트 이름은 그대로 해석돼야 한다(`~` 는 param 자리).
  assert.equal(parseAgentSlot(sib).agent, "agent-builder");
});

test("targetCandidates(): 같은 에이전트의 워크벤치만, 현재 대상은 빼고, 순서·중복 정리", () => {
  const convs = [
    "agent-agent-builder:youtube-studio",
    "agent-agent-builder:task,calendar",
    "agent-design-system",              // 다른 에이전트 — 제외
    "main",                            // 대상 축 없음 — 제외
    "agent-agent-builder:task",        // 중복 — 접힘
  ];
  assert.deepEqual(
    M.targetCandidates(convs, "agent-builder", ["calendar"]),
    ["youtube-studio", "task"],
  );
});

test("targetCandidates(): sibling 좌표도 seed 대상으로 잡힌다", () => {
  assert.deepEqual(M.targetCandidates(["agent-agent-builder:task~ab12cd34"], "agent-builder"), ["task"]);
});

test("targetCandidates(): 에이전트가 없으면 빈 목록(main 대화에는 대상 축이 없다)", () => {
  assert.deepEqual(M.targetCandidates(["agent-agent-builder:task"], ""), []);
});
