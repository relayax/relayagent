// history-replay.test.mjs — 이력 재생의 순수 판정: 사용자 턴의 첨부가 다시 열어도 같은 자리에 선다.
// (이게 없어서 이미지를 보낸 대화는 새로고침하면 첨부가 사라졌다 — 2026-08-28)
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const R = await loadModule("runtime.ts");
const url = (p) => "/file/" + p;

test("본문이 먼저 선다 — UserMessage 는 content[0] 을 본문으로 읽는다", () => {
  const c = R.historyUserContent({ text: "하하", files: [{ path: "uploads/a.png", name: "a.png" }] }, url);
  assert.equal(c[0].type, "text");
  assert.equal(c[0].text, "하하");
  assert.deepEqual(c[1], { type: "image", image: "/file/uploads/a.png", filename: "a.png" });
});

test("첨부 없는 턴은 텍스트 한 파트 그대로", () => {
  assert.deepEqual(R.historyUserContent({ text: "안녕" }, url), [{ type: "text", text: "안녕" }]);
  assert.deepEqual(R.historyUserContent({ text: "안녕", files: null }, url), [{ type: "text", text: "안녕" }]);
});

test("이미지 아닌 첨부는 세우지 않는다 — 실황도 image/* 만 칩으로 그린다(대칭)", () => {
  const c = R.historyUserContent({ text: "", files: [{ path: "uploads/x.pdf", name: "x.pdf" }] }, url);
  assert.equal(c.length, 1);
});

test("이름이 비면 path 꼬리로 판정하고, path 없는 행은 건너뛴다", () => {
  const c = R.historyUserContent({ text: "", files: [{ path: "uploads/b.JPEG" }, { name: "c.png" }] }, url);
  assert.deepEqual(c.slice(1), [{ type: "image", image: "/file/uploads/b.JPEG", filename: "b.JPEG" }]);
});

test("path 는 불투명 참조 — 재생은 해석하지 않고 transport 가 준 URL 만 싣는다", () => {
  const seen = [];
  R.historyUserContent({ text: "", files: [{ path: "uploads/스크린샷 1.png", name: "스크린샷 1.png" }] },
    (p) => { seen.push(p); return "U"; });
  assert.deepEqual(seen, ["uploads/스크린샷 1.png"]);
});
