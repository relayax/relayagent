// preview-tab.test.mjs — 미리보기 탭(VSCode 식) 계약 테스트 (view-bridge §5-17). 탭을 만드는
// 주체는 사람이고, 페이지 이동은 미리보기 **한 자리**만 빌려 쓴다. 이 불변식이 깨지면 페이지를
// 순회하는 것만으로 말 걸어본 적 없는 빈 대화가 탭으로 쌓이고, 새로고침마다 되살아난다
// (2026-08-04 수리 지점).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const { nextTabs, persistableTabs } = await loadModule("ChatTabs.tsx");

const tab = (key, preview) => ({ key, instanceId: "i1", conversationId: key, title: "", ...(preview ? { preview: true } : {}) });
const keys = (ts) => ts.map((t) => t.key);

test("미리보기는 자리 하나만 쓴다 — 페이지를 순회해도 탭이 쌓이지 않는다", () => {
  let ts = [];
  ts = nextTabs(ts, tab("main", true));       // 홈
  ts = nextTabs(ts, tab("agent-x:a", true));  // 스튜디오 slug a
  ts = nextTabs(ts, tab("agent-x:b", true));  // 스튜디오 slug b
  assert.deepEqual(keys(ts), ["agent-x:b"]);
});

test("고정 탭은 미리보기 순회에 밀리지 않는다", () => {
  let ts = [tab("main")];                     // 사람이 쓰던 대화(고정)
  ts = nextTabs(ts, tab("agent-x:a", true));
  ts = nextTabs(ts, tab("agent-x:b", true));
  assert.deepEqual(keys(ts), ["main", "agent-x:b"]);
  assert.equal(ts[0].preview, undefined);
});

test("고정 요청이 미리보기 탭을 가리키면 승격한다(보관함에서 같은 대화 열기 등)", () => {
  const ts = nextTabs([tab("agent-x:a", true)], tab("agent-x:a"));
  assert.deepEqual(keys(ts), ["agent-x:a"]);
  assert.equal(ts[0].preview, false);
});

test("이미 있는 탭에 대한 미리보기 요청은 무변화 — 보던 탭을 건드리지 않는다", () => {
  const prev = [tab("main"), tab("agent-x:a", true)];
  assert.equal(nextTabs(prev, tab("agent-x:a", true)), prev); // 참조 동일 = 재렌더 없음
  assert.equal(nextTabs(prev, tab("main", true)), prev);
});

test("미리보기는 저장되지 않는다 — 새로고침이 빈 대화를 되살리지 않게", () => {
  const saved = persistableTabs([tab("main"), tab("agent-x:a", true)]);
  assert.deepEqual(saved, [{ instanceId: "i1", conversationId: "main", title: "" }]);
});

test("승격된 탭은 저장된다 — 첫 발화 뒤엔 새로고침 너머로 남는다", () => {
  const ts = nextTabs([tab("agent-x:a", true)], tab("agent-x:a"));
  assert.deepEqual(persistableTabs(ts).map((t) => t.conversationId), ["agent-x:a"]);
});
