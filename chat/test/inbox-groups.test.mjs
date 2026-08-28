// inbox-groups.test.mjs — 보관함 피커의 묶음 문법(client-protocol §5.3-25). 목록은 두 종류를
// 섞어 받는다: 사람이 연 대화와, 에이전트가 판 위임 슬롯(origin). 둘이 같은 무게로 늘어서면
// 화면은 인스턴스 이름을 행마다 반복하고 기계가 판 대화를 사람의 대화처럼 세운다(2026-08-28
// 수리 지점). 판정 축은 기판이 밝힌 origin 하나여야 한다 — 슬롯 이름은 불투명이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const { groupRows, subLabel } = await loadModule("ChatTabs.tsx");

const conv = (instance, id, extra = {}) => ({ instance, conversation_id: id, ...extra });

test("위임은 사람의 대화와 섞이지 않고 같은 인스턴스 아래 따로 모인다", () => {
  const gs = groupRows([
    conv("system", "s-1", { title: "상단 바 버튼 배치" }),
    conv("system", "sub-1", { title: "↳ agent-builder · detail-page", origin: "dispatch" }),
    conv("system", "s-2", { title: "상세 페이지 구성" }),
  ]);
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].convs.map((r) => r.conversation_id), ["s-1", "s-2"]);
  assert.deepEqual(gs[0].subs.map((r) => r.conversation_id), ["sub-1"]);
});

test("미션 수신도 기계가 판 슬롯이다 — 같은 자리로 접힌다", () => {
  const [g] = groupRows([conv("system", "mission-x", { origin: "mission" })]);
  assert.equal(g.convs.length, 0);
  assert.equal(g.subs.length, 1);
});

test("판정은 origin 하나 — 슬롯 이름이 sub- 로 시작해도 기판이 말하지 않으면 사람의 대화다", () => {
  const [g] = groupRows([conv("system", "sub-looks-like-one", { title: "내가 이름 붙인 대화" })]);
  assert.deepEqual(g.convs.map((r) => r.conversation_id), ["sub-looks-like-one"]);
  assert.equal(g.subs.length, 0);
});

test("머리에 서는 이름은 사람이 붙인 이름 — 없으면 설치 이름으로 물러난다", () => {
  const gs = groupRows([
    conv("system", "s-1", { display: "무비 시스템" }),
    conv("todo", "s-2"),
  ]);
  assert.equal(gs[0].display, "무비 시스템");
  assert.equal(gs[1].display, "todo");
});

test("묶음 순서는 받은 순서(최근순) 그대로 — 정렬은 기판 몫이다", () => {
  const gs = groupRows([conv("b", "s-1"), conv("a", "s-2"), conv("b", "s-3")]);
  assert.deepEqual(gs.map((g) => g.instance), ["b", "a"]);
  assert.equal(gs[0].convs.length, 2);
});

test("위임 이름은 기계 화살표를 떼고 누가·무엇을만 남긴다", () => {
  assert.equal(subLabel({ instance: "system", conversation_id: "sub-1", title: "↳ agent-builder · detail-page" }), "agent-builder · detail-page");
  // 라벨이 없으면 행 메타(agent·param)로 세운다
  assert.equal(subLabel({ instance: "system", conversation_id: "sub-1", agent: "agent-builder", param: "detail-page" }), "agent-builder · detail-page");
  assert.equal(subLabel({ instance: "system", conversation_id: "sub-1", agent: "agent-builder" }), "agent-builder");
  // 사람이 붙인 이름이 정본 — 화살표가 없으면 그대로 둔다
  assert.equal(subLabel({ instance: "system", conversation_id: "sub-1", title: "상세 페이지 초안", agent: "agent-builder" }), "상세 페이지 초안");
});
