// new-conversation.test.mjs — "+ 새 대화"의 기준 좌표 계약. 인스턴스 축만 페이지를 따르고
// 에이전트 축은 활성 탭을 따르던 반쪽 규칙 때문에, A 워크벤치를 보면서 새 대화를 열면 직전에
// 보던 B 에이전트의 대화가 갈라져 나왔다(2026-08-04 수리 지점). 두 축 모두 페이지가 기준이다.
// 페이지 슬롯의 정본은 브리지 선언(view-bridge §5-17 preview openTab)이 심어 준 좌표다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const { newConversationTarget } = await loadModule("ChatTabs.tsx");
const slot = (instanceId, conversationId) => ({ instanceId, conversationId });

test("페이지 슬롯이 기준 — 보던 탭이 다른 에이전트여도 페이지에서 갈라진다", () => {
  const t = newConversationTarget(slot("sys", "agent-builder:A"), slot("sys", "agent-builder:B"));
  assert.equal(t.instanceId, "sys");
  assert.match(t.conversationId, /^agent-builder:A~[0-9a-f]{8}$/);
});

test("페이지가 없는 셸(/desk)에서만 보던 탭이 기준", () => {
  const t = newConversationTarget(null, slot("sys", "agent-builder:B"));
  assert.match(t.conversationId, /^agent-builder:B~[0-9a-f]{8}$/);
});

test("main 패밀리는 c-<id16> sibling — 도킹 문법과 섞이지 않는다", () => {
  const t = newConversationTarget(slot("sys", "main"), null);
  assert.match(t.conversationId, /^c-[0-9a-f]{16}$/);
});

test("이미 sibling 인 슬롯에서도 seed 패밀리로 갈라진다(중첩 ~ 금지)", () => {
  const t = newConversationTarget(slot("sys", "agent-builder:A~ab12cd34"), null);
  assert.match(t.conversationId, /^agent-builder:A~[0-9a-f]{8}$/);
});

test("열 인스턴스가 없으면 null — 호출자가 보관함 피커로 유도한다", () => {
  assert.equal(newConversationTarget(null, null), null);
  assert.equal(newConversationTarget(slot("", "main"), null), null);
});
