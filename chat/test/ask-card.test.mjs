// ask-card.test.mjs — 질문 하나가 카드 하나로 서는가.
//
// 이 파일이 생긴 이유(2026-08-26 실사고): 같은 질문이 화면에 두 벌 떴다. 하나는 답이 반영돼
// 닫히고, 다른 하나는 `답변 보내기 (0/2)` 로 영영 열린 채 남았다. 원인은 봉투가 **id 두 종류**로
// 도착하는 것이었다 — 실제 장부에서 그대로 옮긴 열이 아래 REAL 이다:
//
//     +0ms  tool  id=toolu_01Nxcp…  start
//    +43ms  ask   id=58518087-…     questions=2
// +21501ms  tool  id=toolu_01Nxcp…  end (result)
//
// 리듀서가 파트를 id 로 세우므로 앵커(ask.tool)가 없으면 두 카드가 선다. 못박는 것 넷:
//  1. 앵커가 있으면 카드는 하나다.
//  2. 그 하나가 tool 결과를 받아 닫힌다 — 답변·타임아웃·거절이 모두 이 한 경로다.
//  3. ask 의 questions 가 tool.args 를 덮는다 — args 는 2KB 상한이라 긴 질문이 잘려 온다.
//  4. 앵커 없는 봉투는 종전대로 자기 카드를 연다(구 어댑터 무영향 — additive 규율).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const { reduceEnvelope } = await loadModule("envelope-reducer.ts");

const TOOL_ID = "toolu_01NxcpFKMsSEAevhdEXKdjmD";
const REQ_ID = "58518087-5c3d-40b3-b82f-7e0e88ef6511";
const QUESTIONS = [
  { question: "제작소가 내놓는 결과물은 어디까지 가야 할까요?", header: "산출 깊이", multiSelect: false, options: [{ label: "설계서까지 (권장)" }] },
  { question: "오퍼 워크북의 답을 제작소가 어떻게 이어받을까요?", header: "입력 경로", multiSelect: false, options: [{ label: "워크북에서 직접 읽기 (권장)" }] },
];
const RESULT = 'Your questions have been answered: "…"="설계서까지 (권장)".';

/** 실제 장부의 열 — 순서·id 를 그대로 옮겼다. anchor=false 면 구 어댑터(앵커 미전송) */
const real = (anchor) => [
  { event: "turn", status: "started", turn: "t1", session: "s1", t: 0 },
  { event: "tool", status: "start", id: TOOL_ID, name: "AskUserQuestion", args: JSON.stringify({ questions: QUESTIONS }) },
  { event: "ask", id: REQ_ID, ...(anchor ? { tool: TOOL_ID } : {}), questions: QUESTIONS },
  { event: "tool", status: "end", id: TOOL_ID, name: "AskUserQuestion", ok: true, result: RESULT },
  { event: "reply", text: "이어서 진행할게요", t: 21600 },
];

const askCards = (parts) => parts.filter((p) => p.type === "tool-call" && p.toolName === "AskUserQuestion");

test("질문 하나에 카드 하나 — 앵커가 ask 를 tool_use 카드에 앉힌다", () => {
  const cards = askCards(reduceEnvelope(real(true)).parts);
  assert.equal(cards.length, 1, "카드가 둘이면 같은 질문이 두 벌 뜬다");
  assert.equal(cards[0].toolCallId, TOOL_ID);
});

test("그 하나가 닫힌다 — 완료 표시의 원천은 tool 결과 하나뿐이다", () => {
  // AskCard 의 done 판정이 part.result 다. 회신 좌표(REQ_ID)로 선 카드는 이 결과를 못 받는다 —
  // 유령 카드가 영영 열려 있던 이유가 그것이다.
  const [card] = askCards(reduceEnvelope(real(true)).parts);
  assert.equal(card.result, RESULT);
  assert.equal(card.isError, false);
});

test("ask 의 questions 가 args 를 덮는다 — tool.args 는 2KB 에서 잘린다", () => {
  const long = [{ question: "긴 질문", header: "h", options: [{ label: "A", description: "설".repeat(2000) }] }];
  const { parts } = reduceEnvelope([
    // 잘린 args = 파싱 불능. 종전에는 카드의 선택지가 통째로 사라졌다
    { event: "tool", status: "start", id: TOOL_ID, name: "AskUserQuestion", detail: "질문", args: JSON.stringify({ questions: long }).slice(0, 2048) },
    { event: "ask", id: REQ_ID, tool: TOOL_ID, questions: long },
  ]);
  const [card] = askCards(parts);
  assert.equal(card.args.questions.length, 1);
  assert.equal(card.args.questions[0].options[0].label, "A");
});

test("앵커 없는 봉투는 종전대로 자기 카드를 연다 — 구 어댑터 무영향", () => {
  const cards = askCards(reduceEnvelope(real(false)).parts);
  assert.equal(cards.length, 2); // 이것이 고치기 전의 화면이었다
  assert.deepEqual(cards.map((c) => c.toolCallId), [TOOL_ID, REQ_ID]);
});
