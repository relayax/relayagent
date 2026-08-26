// tool-label.test.mjs — 기판이 붙인 이름(`tool.label`)이 **렌더까지 살아 가는가**.
//
// 이 파일이 생긴 이유: 그 필드는 리듀서가 세우고(EnvelopeReducer.toolEvent) Chat 이 읽는데
// (stepMeta 의 given 인자), 그 사이 snapshot() 이 카드를 새로 지으면서 빠뜨려 **한 번도
// 화면에 닿은 적이 없었다**(2026-08-26 발견). 기판 쪽(runner tool-label.test.ts)은 붙이는
// 것만 검증하고, 클라이언트 쪽은 아무도 검증하지 않아 조용히 죽어 있었다.
//
// label 은 봉투에서 **기판이 이동 중에 더하는 유일한 필드**다(harness-protocol.md §Events).
// 어댑터는 우리 문의 동사가 무엇을 하는지 모르고, 뜻을 아는 쪽은 자기 tools/list 를 서는
// 기판뿐이다 — 그래서 이 한 필드가 죽으면 `orders-sync` 같은 슬러그가 날것으로 화면에 뜬다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const { EnvelopeReducer, reduceEnvelope } = await loadModule("envelope-reducer.ts");
const { stepMeta } = await loadModule("runtime.ts");

const LABELED = [
  { event: "turn", status: "started", turn: "t1", session: "s1", t: 0 },
  { event: "tool", status: "start", id: "c1", name: "orders-sync", label: "주문 동기화", args: '{"since":"2026-08"}' },
  { event: "tool", status: "end", id: "c1", name: "orders-sync", ok: true, result: "12건" },
  { event: "reply", text: "끝냈어요", t: 10 },
];

test("snapshot 이 기판의 이름을 싣는다 — 파트는 사본이라 빠뜨리면 조용히 사라진다", () => {
  const r = new EnvelopeReducer();
  for (const ev of LABELED) r.push(ev);
  const card = r.snapshot().find((p) => p.type === "tool-call");
  assert.equal(card.label, "주문 동기화");
});

test("재생도 같은 이름을 싣는다 — 라이브에서만 뜨는 라벨은 새로고침에 사라진다", () => {
  const card = reduceEnvelope(LABELED).parts.find((p) => p.type === "tool-call");
  assert.equal(card.label, "주문 동기화");
});

test("기판이 말한 이름이 짐작보다 앞선다 — 그 뜻을 아는 쪽은 기판 하나다", () => {
  // 라벨이 없으면 이름 그대로 뜬다(슬러그는 어떤 짐작 규칙에도 안 걸린다)
  assert.equal(stepMeta("orders-sync", {}).label, "orders-sync");
  // 라벨이 실리면 그것이 답이다
  assert.equal(stepMeta("orders-sync", {}, undefined, false, "주문 동기화").label, "주문 동기화");
});

test("라벨 없는 도구는 종전 표시 그대로 — 없음이 정상이다(기판이 안 서는 도구)", () => {
  const r = new EnvelopeReducer();
  r.push({ event: "tool", status: "start", id: "c1", name: "Bash", args: '{"command":"ls"}' });
  const card = r.snapshot().find((p) => p.type === "tool-call");
  assert.equal("label" in card, false);
  assert.equal(stepMeta("Bash", { command: "ls" }).label, "실행");
});
