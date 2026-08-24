// retarget.test.mjs — 칩 피커의 "대상 고치기" 계약. 칩은 대화 id 의 파생이라 대상을 바꾸려면
// 좌표를 바꿔야 한다. 잘못 열린 대화는 대개 아직 빈 대화이므로 그때는 제자리에서 좌표만 갈아끼워
// 무손실로 고친다(말이 오간 대화는 이 경로를 타지 않고 새 탭으로 이동한다 — 호출자 분기).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const { retargetTabs } = await loadModule("ChatTabs.tsx");

const tab = (instanceId, conversationId, extra = {}) => ({
  key: instanceId + "|" + conversationId, instanceId, conversationId, title: "", ...extra,
});
const convs = (ts) => ts.map((t) => t.conversationId);

test("제자리 교체 — key/좌표가 함께 바뀌고 다른 탭은 그대로", () => {
  const prev = [tab("sys", "main"), tab("sys", "agent-builder:A")];
  const next = retargetTabs(prev, "sys|agent-builder:A", "agent-builder:B");
  assert.deepEqual(convs(next), ["main", "agent-builder:B"]);
  assert.equal(next[1].key, "sys|agent-builder:B");
});

test("미리보기 여부는 유지 — 고쳐진 빈 대화는 여전히 미리보기다", () => {
  const next = retargetTabs([tab("sys", "agent-builder:A", { preview: true })], "sys|agent-builder:A", "main");
  assert.equal(next[0].preview, true);
});

test("제목은 비운다 — 좌표가 바뀌었으니 자동 제목을 다시 받는다", () => {
  const next = retargetTabs([tab("sys", "main", { title: "옛 제목" })], "sys|main", "agent-builder:A");
  assert.equal(next[0].title, "");
});

test("목표 좌표가 이미 열려 있으면 비어 있던 원본만 접는다(쌍둥이 빈 탭 방지)", () => {
  const prev = [tab("sys", "agent-builder:B"), tab("sys", "agent-builder:A")];
  const next = retargetTabs(prev, "sys|agent-builder:A", "agent-builder:B");
  assert.deepEqual(convs(next), ["agent-builder:B"]);
});

test("같은 좌표·없는 탭·빈 좌표는 무변화(참조 동일)", () => {
  const prev = [tab("sys", "main")];
  assert.equal(retargetTabs(prev, "sys|main", "main"), prev);
  assert.equal(retargetTabs(prev, "sys|없음", "agent-builder:A"), prev);
  assert.equal(retargetTabs(prev, "sys|main", ""), prev);
});
