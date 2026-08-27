// trace-groups.test.mjs — 어시스턴트 한 턴의 파트가 화면 묶음으로 갈리는 규칙(parts.groupParts).
//
// 못박는 것 둘:
//  1. 하네스 내부 도구(ToolSearch)는 화면에 없다 — 담기지도, 흐름을 끊지도 않는다.
//     실사고(2026-08-27): 글 앞의 ToolSearch 하나가 제 묶음을 세워 "작업 1개"로 접히고,
//     글 아래에 진짜 작업 둘이 또 보여 숫자가 틀린 것처럼 읽혔다.
//  2. 글은 여전히 묶음을 가른다 — 그 자리가 곧 이후 도구들이 갈린 이유다. 대신 요약이 말할
//     작업 수는 묶음별이 아니라 **턴 전체**의 합이다(AssistantMessage 가 이 합을 센다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const { groupParts, isInternalTool } = await loadModule("parts.ts");

const tool = (name) => ({ type: "tool-call", toolName: name, toolCallId: name, args: {}, result: "ok" });
const text = (t) => ({ type: "text", text: t });

/** 스크린샷의 그 턴 그대로 — ToolSearch → 글 → 도구 둘 → 글 → ToolSearch → 위임 */
const TURN = [
  tool("ToolSearch"),
  text("먼저 재료를 확인하겠습니다."),
  tool("mcp__relay__campaign-list"),
  tool("mcp__relay__offer-material"),
  text("재료가 갖춰져 있습니다."),
  tool("ToolSearch"),
  tool("mcp__relay__agent_dispatch"),
  text("첫 세트가 섰습니다."),
];

const toolsOf = (groups) =>
  groups.reduce((n, g) => (g.kind === "trace" ? n + g.steps.filter((s) => s.type === "tool-call").length : n), 0);

test("내부 도구는 묶음에 담기지 않는다 — 뜻 없는 '작업 1개'가 서지 않게", () => {
  assert.equal(isInternalTool("ToolSearch"), true);
  assert.equal(isInternalTool("mcp__relay__campaign-list"), false);

  const groups = groupParts(TURN);
  const names = groups.flatMap((g) => (g.kind === "trace" ? g.steps.map((s) => s.toolName) : []));
  assert.equal(names.includes("ToolSearch"), false);
});

test("내부 도구는 흐름도 끊지 않는다 — 첫 글 앞에 묶음이 서지 않는다", () => {
  const groups = groupParts(TURN);
  assert.equal(groups[0].kind, "md"); // 예전엔 여기에 ToolSearch 한 개짜리 trace 가 섰다
  assert.deepEqual(groups.map((g) => g.kind), ["md", "trace", "md", "trace", "md"]);
});

test("글은 묶음을 가르되, 작업 수는 턴 전체로 센다", () => {
  const groups = groupParts(TURN);
  const traces = groups.filter((g) => g.kind === "trace");
  assert.equal(traces.length, 2);        // 묶음은 둘로 갈리고
  assert.equal(traces[0].steps.length, 2);
  assert.equal(traces[1].steps.length, 1);
  assert.equal(toolsOf(groups), 3);      // 요약 칩이 말할 수는 하나 — "작업 3개"
});

test("내부 도구뿐인 턴은 타임라인 자체가 없다", () => {
  const groups = groupParts([tool("ToolSearch"), text("바로 답합니다.")]);
  assert.deepEqual(groups.map((g) => g.kind), ["md"]);
});
